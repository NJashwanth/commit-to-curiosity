import random

import numpy as np
import pytest

from env import DOWN, LEFT, RIGHT, UP, SnakeEnv, compact_features


def make(size=8, **kw):
    return SnakeEnv(size=size, seed=0, **kw)


def test_reset_layout_and_food_off_snake():
    env = make(12)
    obs = env.reset()
    assert list(env.snake) == [(6, 6), (5, 6), (4, 6)]
    assert env.food not in env.snake
    assert obs.shape == (11,)
    assert env.score == 0 and not env.done


def test_deterministic_reset_with_seed():
    a, b = SnakeEnv(size=10), SnakeEnv(size=10)
    a.reset(seed=7)
    b.reset(seed=7)
    assert a.food == b.food
    first = a.food
    a.reset(seed=7)
    assert a.food == first
    # whole rollouts match under the same seed and same actions
    rng = random.Random(1)
    acts = [rng.randrange(4) for _ in range(40)]
    runs = []
    for _ in range(2):
        e = SnakeEnv(size=6)
        e.reset(seed=3)
        trace = []
        for act in acts:
            if e.done:
                break
            _, r, _, _ = e.step(act)
            trace.append((tuple(e.snake), e.food, r))
        runs.append(trace)
    assert runs[0] == runs[1]


def test_different_seeds_can_differ():
    foods = set()
    for s in range(10):
        e = SnakeEnv(size=12)
        e.reset(seed=s)
        foods.add(e.food)
    assert len(foods) > 1


def test_movement_keeps_length():
    env = make()
    env.set_state([(3, 3), (2, 3), (1, 3)], RIGHT, (7, 7))
    env.step(RIGHT)
    assert list(env.snake) == [(4, 3), (3, 3), (2, 3)]
    env.step(DOWN)
    assert list(env.snake) == [(4, 4), (4, 3), (3, 3)]
    assert env.direction == DOWN
    env.step(LEFT)
    assert env.snake[0] == (3, 4)


def test_growth_on_food_and_respawn():
    env = make()
    env.set_state([(3, 3), (2, 3), (1, 3)], RIGHT, (4, 3))
    _, reward, done, info = env.step(RIGHT)
    assert reward == pytest.approx(10.0)
    assert not done and info["ate"] and info["score"] == 1
    assert len(env.snake) == 4
    assert list(env.snake) == [(4, 3), (3, 3), (2, 3), (1, 3)]
    assert env.food != (4, 3) and env.food not in env.snake


def test_wall_collision():
    env = make(6)
    env.set_state([(5, 2), (4, 2), (3, 2)], RIGHT, (0, 0))
    _, reward, done, info = env.step(RIGHT)
    assert done and info["reason"] == "wall"
    assert reward == pytest.approx(-10.0)
    with pytest.raises(RuntimeError):
        env.step(RIGHT)


@pytest.mark.parametrize("snake,direction,action,wall", [
    ([(0, 3), (1, 3), (2, 3)], LEFT, LEFT, True),
    ([(3, 0), (3, 1), (3, 2)], UP, UP, True),
    ([(3, 5), (3, 4), (3, 3)], DOWN, DOWN, True),
])
def test_wall_each_side(snake, direction, action, wall):
    env = make(6)
    env.set_state(snake, direction, (5, 5) if snake[0] != (3, 5) else (0, 0))
    _, _, done, info = env.step(action)
    assert done and info["reason"] == "wall"


def test_self_collision():
    env = make()
    env.set_state([(3, 3), (3, 4), (4, 4), (4, 3), (4, 2), (3, 2)], UP, (7, 7))
    _, reward, done, info = env.step(RIGHT)
    assert done and info["reason"] == "self"
    assert reward == pytest.approx(-10.0)


def test_moving_into_vacating_tail_is_safe():
    env = make()
    env.set_state([(3, 3), (4, 3), (4, 4), (3, 4)], LEFT, (7, 7))
    _, _, done, _ = env.step(DOWN)
    assert not done
    assert env.snake[0] == (3, 4)


def test_cannot_reverse_into_itself():
    env = make()
    env.set_state([(3, 3), (2, 3), (1, 3)], RIGHT, (7, 7))
    _, _, done, _ = env.step(LEFT)
    assert not done
    assert env.direction == RIGHT
    assert env.snake[0] == (4, 3)


def test_food_never_spawns_on_snake():
    for seed in range(20):
        env = SnakeEnv(size=5, seed=seed)
        env.reset()
        rng = random.Random(seed)
        for _ in range(300):
            assert env.food is None or env.food not in env.snake
            _, _, done, _ = env.step(rng.randrange(4))
            if done:
                env.reset()


def test_step_limit_without_food():
    env = SnakeEnv(size=6, max_idle_steps=5, seed=0)
    env.set_state([(2, 2), (1, 2), (0, 2)], RIGHT, (5, 5))
    actions = [RIGHT, DOWN, LEFT, UP, RIGHT]
    for i, act in enumerate(actions):
        _, reward, done, info = env.step(act)
        assert done == (i == 4)
    assert info["reason"] == "starved"
    assert reward == pytest.approx(-10.0)


def test_eating_resets_idle_counter():
    env = SnakeEnv(size=6, max_idle_steps=3, seed=0)
    env.set_state([(1, 2), (0, 2), (0, 3)], RIGHT, (4, 2))
    env.step(RIGHT)
    env.step(RIGHT)
    assert env.idle == 2
    env.step(RIGHT)  # eats
    assert env.idle == 0 and not env.done


def test_filling_the_board_wins():
    path = []
    for y in range(5):
        xs = range(5) if y % 2 == 0 else range(4, -1, -1)
        path.extend((x, y) for x in xs)
    env = make(5)
    env.set_state(list(reversed(path[:24])), RIGHT, path[24])
    obs, reward, done, info = env.step(RIGHT)
    assert done and info["reason"] == "won" and info["score"] == 1
    assert reward == pytest.approx(10.0)
    assert env.food is None and not obs.any()


def test_grid_state_mode():
    env = SnakeEnv(size=6, state_mode="grid", seed=0)
    obs = env.reset()
    assert obs.shape == (3, 6, 6) and env.obs_size == 108
    assert obs[1].sum() == 1 and obs[1][3, 3] == 1  # head
    assert obs[0].sum() == 2  # body without head
    assert obs[2].sum() == 1 and obs[2][env.food[1], env.food[0]] == 1
    env.set_state([(2, 2), (1, 2), (0, 2)], RIGHT, (5, 5))
    env.step(RIGHT)
    assert env.step(RIGHT)[0].shape == (3, 6, 6)


def test_invalid_args():
    with pytest.raises(ValueError):
        SnakeEnv(size=3)
    with pytest.raises(ValueError):
        SnakeEnv(state_mode="pixels")
    env = make()
    env.reset()
    with pytest.raises(ValueError):
        env.step(9)


def test_render_and_snapshot():
    env = make(5)
    env.set_state([(2, 2), (1, 2), (0, 2)], RIGHT, (4, 0))
    rows = env.render().split("\n")
    assert rows[2] == "o o O . ."
    assert rows[0] == ". . . . *"
    snap = env.snapshot()
    assert snap["snake"][0] == (2, 2) and snap["food"] == (4, 0) and snap["size"] == 5


# ---- state features -------------------------------------------------------

def feats(size, snake, direction, food):
    return compact_features(size, snake, direction, food).astype(int).tolist()


def test_features_walls_and_food_direction():
    # head in the top-left corner heading up; food down-right
    f = feats(6, [(0, 0), (0, 1), (0, 2)], UP, (3, 3))
    assert f == [1, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0]


def test_features_body_danger_on_left():
    f = feats(6, [(3, 3), (3, 4), (2, 4), (2, 3), (2, 2)], UP, (3, 0))
    assert f == [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0]


def test_features_relative_to_heading_left():
    f = feats(6, [(3, 5), (4, 5), (5, 5)], LEFT, (1, 2))
    # facing left: straight (2,5) free, right-turn=up (3,4) free, left-turn=down (3,6) wall
    assert f == [0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1]


def test_features_tail_is_not_danger():
    f = feats(6, [(3, 3), (4, 3), (4, 4), (3, 4)], LEFT, (0, 0))
    assert f[2] == 0  # left-turn (down) lands on the tail


def test_features_food_on_same_axis():
    f = feats(6, [(3, 3), (2, 3), (1, 3)], RIGHT, (3, 0))
    assert f[7:] == [1, 0, 0, 0]


def test_env_obs_matches_feature_function():
    env = make(6)
    obs = env.set_state([(3, 3), (4, 3), (5, 3)], LEFT, (0, 5))
    assert np.array_equal(obs, compact_features(6, env.snake, LEFT, (0, 5)))


# ---- reward shaping -------------------------------------------------------

def shaped_env(shaping):
    env = make(8, shaping=shaping)
    env.set_state([(2, 2), (1, 2), (0, 2)], RIGHT, (5, 2))
    return env


def test_shaping_rewards_moving_toward_food():
    _, r, _, _ = shaped_env(True).step(RIGHT)
    assert r == pytest.approx(0.1)


def test_shaping_penalises_moving_away():
    _, r, _, _ = shaped_env(True).step(UP)
    assert r == pytest.approx(-0.1)


def test_no_shaping_gives_zero_for_plain_steps():
    for act in (RIGHT, UP):
        _, r, _, _ = shaped_env(False).step(act)
        assert r == 0.0


def test_food_and_death_rewards_ignore_shaping():
    for shaping in (True, False):
        env = make(6, shaping=shaping)
        env.set_state([(1, 2), (0, 2), (0, 3)], RIGHT, (2, 2))
        assert env.step(RIGHT)[1] == pytest.approx(10.0)
        env.set_state([(5, 2), (4, 2), (3, 2)], RIGHT, (0, 0))
        assert env.step(RIGHT)[1] == pytest.approx(-10.0)
