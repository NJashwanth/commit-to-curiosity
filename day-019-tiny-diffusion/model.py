"""MLP denoiser that predicts the noise added to a 2D point."""

from __future__ import annotations

import math

import torch
from torch import nn


def timestep_embedding(t: torch.Tensor, dim: int, max_period: float = 10000.0) -> torch.Tensor:
    """Sinusoidal embedding of integer timesteps, shape (B,) -> (B, dim)."""
    half = dim // 2
    freqs = torch.exp(-math.log(max_period) * torch.arange(half, dtype=torch.float32) / max(half, 1))
    args = t.float()[:, None] * freqs[None, :].to(t.device)
    emb = torch.cat([torch.sin(args), torch.cos(args)], dim=-1)
    if dim % 2:
        emb = torch.cat([emb, torch.zeros_like(emb[:, :1])], dim=-1)
    return emb


class Denoiser(nn.Module):
    """epsilon_theta(x_t, t): an MLP with the timestep injected into every hidden layer.

    With ``learned_input=True`` the point is expanded with multi-frequency
    sin/cos features (plain MLPs struggle to fit sharp, curly shapes from raw
    coordinates), lifted by a learned linear embedding and added to the time
    embedding. With ``False`` the raw point is concatenated with the time
    embedding before the first layer.
    """

    def __init__(
        self,
        data_dim: int = 2,
        hidden: int = 128,
        n_layers: int = 4,
        time_dim: int = 64,
        learned_input: bool = True,
        n_freqs: int = 5,
    ):
        super().__init__()
        if n_layers < 1:
            raise ValueError("n_layers must be at least 1")
        self.data_dim = data_dim
        self.time_dim = time_dim
        self.learned_input = learned_input
        self.n_freqs = n_freqs
        self.register_buffer("freqs", 2.0 ** torch.arange(n_freqs, dtype=torch.float32), persistent=False)
        self.time_mlp = nn.Sequential(nn.Linear(time_dim, hidden), nn.SiLU(), nn.Linear(hidden, hidden))
        if learned_input:
            self.input_embed = nn.Linear(data_dim * (1 + 2 * n_freqs), hidden)
        else:
            self.input_embed = nn.Linear(data_dim + hidden, hidden)
        self.layers = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(n_layers)])
        self.time_proj = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(n_layers)])
        self.act = nn.SiLU()
        self.out = nn.Linear(hidden, data_dim)

    def fourier_features(self, x: torch.Tensor) -> torch.Tensor:
        """[x, sin(2^k x), cos(2^k x)] for k < n_freqs, shape (B, data_dim * (1 + 2 n_freqs))."""
        angles = x[:, :, None] * self.freqs.to(x.dtype)
        return torch.cat([x, torch.sin(angles).flatten(1), torch.cos(angles).flatten(1)], dim=-1)

    def forward(self, x: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
        temb = self.time_mlp(timestep_embedding(t, self.time_dim).to(x.device))
        if self.learned_input:
            h = self.act(self.input_embed(self.fourier_features(x)) + temb)
        else:
            h = self.act(self.input_embed(torch.cat([x, temb], dim=-1)))
        for layer, proj in zip(self.layers, self.time_proj):
            h = h + self.act(layer(h + proj(temb)))
        return self.out(h)
