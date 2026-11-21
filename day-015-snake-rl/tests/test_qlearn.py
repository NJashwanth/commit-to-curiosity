import numpy as np
import pytest

from agents import make_agent
from agents.qlearn import QLearningAgent
from agents.random_agent import RandomAgent
from env import N_FEATURES


def onehot(*idx):
    v = np.zeros(N_FEATURES, dtype=np.float32)
    v[list(idx)] = 1.0
    return v


def test_state_index_packs_bits():
    agent = QLearningAgent()
    assert agent.state_index(np.zeros(N_FEATURES)) == 0
    assert agent.state_index(onehot(0)) == 1
    assert agent.state_index(onehot(0, 2, 10)) == 1 + 4 + 1024
    assert agent.state_index(np.ones(N_FEATURES)) == 2 ** N_FEATURES - 1


def test_update_matches_hand_computation():
    agent = QLearningAgent(alpha=0.5, gamma=0.9)
    s, s2 = onehot(0), onehot(1)
    i, j = agent.state_index(s), agent.state_index(s2)
    agent.q[i, 2] = 1.0
    agent.q[j] = [0.0, 2.0, 1.0, 0.5]
    loss = agent.observe(s, 2, 1.0, s2, False)
    # target = 1 + 0.9 * 2 = 2.8, td = 1.8, new = 1 + 0.5 * 1.8 = 1.9
    assert agent.q[i, 2] == pytest.approx(1.9)
    assert loss == pytest.approx(1.8 ** 2)
    assert np.count_nonzero(agent.q[i]) == 1  # other actions untouched


def test_terminal_update_ignores_next_state():
    agent = QLearningAgent(alpha=0.5, gamma=0.9)
    s, s2 = onehot(3), onehot(4)
    agent.q[agent.state_index(s), 0] = 1.0
    agent.q[agent.state_index(s2)] = 100.0
    agent.observe(s, 0, -10.0, s2, True)
    # 1 + 0.5 * (-10 - 1) = -4.5
    assert agent.q[agent.state_index(s), 0] == pytest.approx(-4.5)


def test_epsilon_decay_schedule():
    agent = QLearningAgent(eps_start=1.0, eps_min=0.1, eps_decay=0.5)
    seen = []
    for _ in range(6):
        agent.end_episode()
        seen.append(agent.epsilon)
    assert seen == pytest.approx([0.5, 0.25, 0.125, 0.1, 0.1, 0.1])
    assert agent.episodes == 6


def test_greedy_picks_argmax_and_explore_hits_all_actions():
    agent = QLearningAgent(seed=0)
    s = onehot(5)
    agent.q[agent.state_index(s)] = [0.1, 0.2, 0.9, 0.3]
    agent.epsilon = 0.0
    assert {agent.act(s) for _ in range(20)} == {2}
    agent.epsilon = 1.0
    assert {agent.act(s) for _ in range(200)} == {0, 1, 2, 3}
    assert {agent.act(s, greedy=True) for _ in range(20)} == {2}


def test_save_load_roundtrip(tmp_path):
    agent = QLearningAgent(alpha=0.3, seed=1)
    rng = np.random.default_rng(0)
    agent.q = rng.normal(size=agent.q.shape)
    agent.epsilon, agent.episodes = 0.2, 17
    path = tmp_path / "q.npz"
    agent.save(path)
    clone = QLearningAgent.load(path)
    assert np.array_equal(clone.q, agent.q)
    assert (clone.epsilon, clone.episodes, clone.alpha) == (0.2, 17, 0.3)
    for _ in range(50):
        obs = (rng.random(N_FEATURES) > 0.5).astype(np.float32)
        assert clone.act(obs, greedy=True) == agent.act(obs, greedy=True)


def test_random_agent_is_seeded_and_in_range():
    a, b = RandomAgent(seed=5), RandomAgent(seed=5)
    xs = [a.act(None) for _ in range(50)]
    assert xs == [b.act(None) for _ in range(50)]
    assert set(xs) <= {0, 1, 2, 3} and len(set(xs)) > 1
    assert a.observe(None, 0, 0, None, False) is None
    a.end_episode()
    with pytest.raises(NotImplementedError):
        a.save("x")


def test_make_agent():
    assert isinstance(make_agent("random", seed=0), RandomAgent)
    assert isinstance(make_agent("qlearn", seed=0), QLearningAgent)
    with pytest.raises(ValueError):
        make_agent("nope")
