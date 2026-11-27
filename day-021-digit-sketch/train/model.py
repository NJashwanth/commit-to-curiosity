"""The digit CNN: conv3x3 -> ReLU -> maxpool -> conv3x3 -> ReLU -> maxpool -> dense -> ReLU -> dense(10).

No padding, so the shapes are easy to follow (and easy to re-implement in TypeScript):

    input   1 x 28 x 28
    conv1  16 x 26 x 26   (3x3, 160 params)
    pool   16 x 13 x 13
    conv2  32 x 11 x 11   (3x3, 4,640 params)
    pool   32 x  5 x  5   (the odd last row and column are dropped)
    flat   800
    dense  64             (51,264 params)
    dense  10             (650 params)

56,714 parameters in total. The network returns logits; softmax is applied outside.
"""
from __future__ import annotations

import torch
from torch import nn


class DigitCNN(nn.Module):
    def __init__(self, c1: int = 16, c2: int = 32, hidden: int = 64, classes: int = 10):
        super().__init__()
        self.conv1 = nn.Conv2d(1, c1, kernel_size=3)
        self.conv2 = nn.Conv2d(c1, c2, kernel_size=3)
        self.pool = nn.MaxPool2d(2)
        self.fc1 = nn.Linear(c2 * 5 * 5, hidden)
        self.fc2 = nn.Linear(hidden, classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.pool(torch.relu(self.conv1(x)))
        x = self.pool(torch.relu(self.conv2(x)))
        x = torch.relu(self.fc1(x.flatten(1)))
        return self.fc2(x)

    def feature_maps(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Post-ReLU activations of conv1 (N, c1, 26, 26) and conv2 (N, c2, 11, 11)."""
        a1 = torch.relu(self.conv1(x))
        a2 = torch.relu(self.conv2(self.pool(a1)))
        return a1, a2

    def config(self) -> dict:
        return {"c1": self.conv1.out_channels, "c2": self.conv2.out_channels,
                "hidden": self.fc1.out_features, "classes": self.fc2.out_features}


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
