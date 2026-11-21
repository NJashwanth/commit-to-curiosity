import numpy as np
import pytest
import torch

from agents import make_agent
from agents.dqn import DQNAgent
from env import N_FEATURES


def tiny(**kw):
    cfg = dict(hidden=8, batch_size=4, buffer_size=32, learn_start=4, target_sync=3, seed=0)
    cfg.update(kw)
    return DQNAgent(**cfg)


def rand_obs(rng):
    return (rng.random(N_FEATURES) > 0.5).astype(np.float32)


def feed(agent, n, rng):
    losses = []
    for _ in range(n):
        losses.append(agent.observe(rand_obs(rng), int(rng.integers(4)), 1.0, rand_obs(rng), False))
    return losses


def test_network_shape_and_q_values():
    agent = tiny()
    q = agent.q_values(np.zeros(N_FEATURES))
    assert q.shape == (4,)
    assert agent.act(np.zeros(N_FEATURES), greedy=True) == int(q.argmax())


def test_td_target_zeroes_bootstrap_on_terminal():
    agent = tiny(gamma=0.9)
    agent.target[-1].weight.data.zero_()
    agent.target[-1].bias.data = torch.tensor([1.0, 5.0, 2.0, 0.0])  # max_a Q_target = 5
    r = torch.tensor([1.0, -10.0, 2.0])
    s2 = torch.zeros(3, N_FEATURES)
    d = torch.tensor([0.0, 1.0, 1.0])
    t = agent.td_targets(r, s2, d)
    assert t.tolist() == pytest.approx([1.0 + 0.9 * 5.0, -10.0, 2.0])


def test_td_target_uses_target_network_not_online():
    agent = tiny()
    agent.online[-1].bias.data.fill_(1000.0)
    agent.target[-1].weight.data.zero_()
    agent.target[-1].bias.data.fill_(3.0)
    t = agent.td_targets(torch.zeros(1), torch.zeros(1, N_FEATURES), torch.zeros(1))
    assert t.item() == pytest.approx(0.9 * 3.0)


def test_no_learning_before_warmup():
    agent = tiny(learn_start=6)
    losses = feed(agent, 8, np.random.default_rng(0))
    assert losses[:5] == [None] * 5 and all(x is not None for x in losses[5:])
    assert agent.learn_steps == 3


def test_learning_updates_online_but_not_target_between_syncs():
    agent = tiny(target_sync=100)
    rng = np.random.default_rng(0)
    before_t = [p.clone() for p in agent.target.parameters()]
    before_o = [p.clone() for p in agent.online.parameters()]
    feed(agent, 10, rng)
    assert all(torch.equal(a, b) for a, b in zip(before_t, agent.target.parameters()))
    assert any(not torch.equal(a, b) for a, b in zip(before_o, agent.online.parameters()))


def test_target_syncs_on_schedule():
    agent = tiny(target_sync=3, learn_start=4)
    rng = np.random.default_rng(0)
    feed(agent, 3, rng)  # buffer warming up, no learning yet
    assert agent.learn_steps == 0
    feed(agent, 1, rng)  # step 1
    feed(agent, 1, rng)  # step 2
    differs = lambda: any(not torch.equal(a, b) for a, b in zip(agent.online.parameters(), agent.target.parameters()))
    assert agent.learn_steps == 2 and differs()
    feed(agent, 1, rng)  # step 3 -> sync
    assert agent.learn_steps == 3 and not differs()
    feed(agent, 1, rng)  # step 4 -> drift again
    assert differs()


def test_loss_decreases_on_a_fixed_target():
    agent = tiny(hidden=16, batch_size=16, buffer_size=64, learn_start=16, target_sync=10, lr=1e-2, gamma=0.0)
    rng = np.random.default_rng(0)
    for _ in range(64):  # reward is a deterministic function of the action
        a = int(rng.integers(4))
        agent.buffer.push(rand_obs(rng), a, float(a), rand_obs(rng), True)
    losses = [agent.learn() for _ in range(150)]
    assert np.mean(losses[-10:]) < 0.2 * np.mean(losses[:10])


def test_epsilon_decay_and_floor():
    agent = tiny(eps_start=1.0, eps_min=0.2, eps_decay=0.5)
    seen = []
    for _ in range(4):
        agent.end_episode()
        seen.append(agent.epsilon)
    assert seen == pytest.approx([0.5, 0.25, 0.2, 0.2])


def test_epsilon_greedy_exploration():
    agent = tiny(eps_start=1.0)
    obs = np.zeros(N_FEATURES, dtype=np.float32)
    assert len({agent.act(obs) for _ in range(100)}) == 4
    agent.epsilon = 0.0
    assert len({agent.act(obs) for _ in range(20)}) == 1


def test_checkpoint_roundtrip_gives_identical_actions(tmp_path):
    agent = tiny()
    rng = np.random.default_rng(0)
    feed(agent, 30, rng)
    agent.epsilon, agent.episodes = 0.3, 9
    path = tmp_path / "dqn.pt"
    agent.save(path)
    clone = DQNAgent.load(path)
    assert (clone.epsilon, clone.episodes, clone.learn_steps) == (0.3, 9, agent.learn_steps)
    for _ in range(100):
        obs = rand_obs(rng)
        assert clone.act(obs, greedy=True) == agent.act(obs, greedy=True)
        assert torch.equal(clone.q_values(obs), agent.q_values(obs))
    assert all(torch.equal(a, b) for a, b in zip(clone.target.parameters(), agent.target.parameters()))


def test_grid_sized_network_and_factory():
    agent = make_agent("dqn", obs_size=3 * 4 * 4, hidden=8, seed=0)
    assert agent.q_values(np.zeros((3, 4, 4))).shape == (4,)
    assert isinstance(agent, DQNAgent)
