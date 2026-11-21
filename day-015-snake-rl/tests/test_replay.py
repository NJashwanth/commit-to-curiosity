import numpy as np
import pytest

from replay import ReplayBuffer


def fill(buf, n, start=0):
    for i in range(start, start + n):
        buf.push(np.full(3, i), i % 4, float(i), np.full(3, i + 1), i % 2 == 0)


def test_len_and_capacity():
    buf = ReplayBuffer(5, 3, seed=0)
    assert len(buf) == 0
    fill(buf, 3)
    assert len(buf) == 3
    fill(buf, 10, start=3)
    assert len(buf) == 5 == buf.capacity


def test_overwrites_oldest_first():
    buf = ReplayBuffer(4, 3)
    fill(buf, 6)  # 0..5 pushed; 0 and 1 overwritten
    assert sorted(buf.rewards.tolist()) == [2.0, 3.0, 4.0, 5.0]
    assert buf.rewards[0] == 4.0 and buf.rewards[1] == 5.0  # slots 0,1 reused
    assert buf.pos == 2
    buf.push(np.zeros(3), 0, 99.0, np.zeros(3), False)
    assert buf.rewards[2] == 99.0  # next-oldest (2) goes next


def test_sample_shapes_and_dtypes():
    buf = ReplayBuffer(20, 3, seed=1)
    fill(buf, 12)
    s, a, r, s2, d = buf.sample(8)
    assert s.shape == (8, 3) and s2.shape == (8, 3)
    assert a.shape == r.shape == d.shape == (8,)
    assert s.dtype == np.float32 and a.dtype == np.int64 and d.dtype == np.float32
    # transitions stay aligned across arrays
    assert np.array_equal(s[:, 0], r) and np.array_equal(s2[:, 0], r + 1)
    assert np.array_equal(a, (r % 4).astype(np.int64))


def test_sample_has_no_duplicates_and_is_seeded():
    a, b = ReplayBuffer(30, 3, seed=4), ReplayBuffer(30, 3, seed=4)
    fill(a, 30)
    fill(b, 30)
    ra, rb = a.sample(10)[2], b.sample(10)[2]
    assert np.array_equal(ra, rb) and len(set(ra.tolist())) == 10


def test_grid_observations_are_flattened():
    buf = ReplayBuffer(4, 12)
    buf.push(np.ones((3, 2, 2)), 1, 0.0, np.zeros((3, 2, 2)), True)
    assert buf.states[0].tolist() == [1.0] * 12 and buf.dones[0] == 1.0


def test_errors():
    with pytest.raises(ValueError):
        ReplayBuffer(0, 3)
    buf = ReplayBuffer(4, 3)
    fill(buf, 2)
    with pytest.raises(ValueError):
        buf.sample(3)
