import csv
import statistics

import pytest

import compare as compare_mod
import train as train_mod
from agents import make_agent
from agents.dqn import DQNAgent
from agents.qlearn import QLearningAgent
from env import SnakeEnv


def quick(agent, tmp_path, episodes=30, **kw):
    kw.setdefault("size", 6)
    return train_mod.train(agent, episodes, seed=0, runs_dir=tmp_path / "runs", ckpt_dir=tmp_path / "ck",
                           quiet=True, **kw)


def read_rows(path):
    with open(path) as fh:
        return list(csv.DictReader(fh))


def test_csv_log_has_expected_columns_and_rows(tmp_path):
    res = quick("qlearn", tmp_path, episodes=25)
    rows = read_rows(res["csv"])
    assert list(rows[0]) == ["episode", "score", "avg100", "epsilon", "loss"]
    assert [int(r["episode"]) for r in rows] == list(range(1, 26))
    scores = [int(r["score"]) for r in rows]
    assert float(rows[-1]["avg100"]) == pytest.approx(statistics.fmean(scores))
    assert float(rows[0]["epsilon"]) == 1.0 and float(rows[-1]["epsilon"]) < 1.0
    assert all(r["loss"] != "" for r in rows[1:])


def test_best_and_last_checkpoints_saved(tmp_path):
    quick("qlearn", tmp_path, episodes=20)
    quick("dqn", tmp_path, episodes=10, hp=dict(hidden=8, learn_start=32))
    ck = tmp_path / "ck"
    assert {p.name for p in ck.iterdir()} == {"qlearn_best.npz", "qlearn_last.npz", "dqn_best.pt", "dqn_last.pt"}


def test_training_is_reproducible_for_a_seed(tmp_path):
    a = quick("qlearn", tmp_path / "a", episodes=40)
    b = quick("qlearn", tmp_path / "b", episodes=40)
    assert [r[1] for r in a["rows"]] == [r[1] for r in b["rows"]]


def test_random_agent_trains_without_checkpoint(tmp_path):
    res = quick("random", tmp_path, episodes=5)
    assert len(res["rows"]) == 5
    assert list((tmp_path / "ck").iterdir()) == []


def test_no_shaping_flag_changes_nothing_but_rewards(tmp_path):
    res = quick("qlearn", tmp_path, episodes=5, shaping=False, tag="qlearn_noshape")
    assert res["csv"].name == "qlearn_noshape.csv"
    assert (tmp_path / "ck" / "qlearn_noshape_last.npz").exists()


def test_build_agent_rules():
    grid_env = SnakeEnv(size=5, state_mode="grid")
    with pytest.raises(ValueError):
        train_mod.build_agent("qlearn", grid_env)
    agent = train_mod.build_agent("dqn", grid_env, seed=0, hidden=8)
    assert agent.obs_size == 75
    assert train_mod.env_for(agent, size=5).state_mode == "grid"
    assert train_mod.env_for(make_agent("qlearn"), size=5).state_mode == "compact"


def test_load_agent_dispatch(tmp_path):
    quick("qlearn", tmp_path, episodes=5)
    quick("dqn", tmp_path, episodes=3, hp=dict(hidden=8))
    assert isinstance(train_mod.load_agent("qlearn", tmp_path / "ck" / "qlearn_best.npz"), QLearningAgent)
    assert isinstance(train_mod.load_agent("dqn", tmp_path / "ck" / "dqn_best.pt"), DQNAgent)
    with pytest.raises(ValueError):
        train_mod.load_agent("random", "x")


def test_evaluate_is_greedy_and_repeatable():
    agent = QLearningAgent(seed=0)
    env = SnakeEnv(size=6)
    first = train_mod.evaluate(agent, env, 5, seed=3)
    assert first == train_mod.evaluate(agent, env, 5, seed=3)
    assert agent.episodes == 0 and agent.epsilon == 1.0  # nothing learned or decayed


def test_plot_curves_writes_one_png(tmp_path):
    quick("qlearn", tmp_path, episodes=15)
    quick("random", tmp_path, episodes=15)
    out = train_mod.plot_curves(tmp_path / "runs", tmp_path / "docs" / "curves.png")
    assert out.exists() and out.read_bytes()[:4] == b"\x89PNG"
    with pytest.raises(FileNotFoundError):
        train_mod.plot_curves(tmp_path / "empty", tmp_path / "x.png")


def test_parse_hp():
    assert train_mod.parse_hp(["lr=0.01", "hidden=32"]) == {"lr": 0.01, "hidden": 32}
    assert train_mod.parse_hp(None) == {}


def test_train_cli(tmp_path, capsys):
    code = train_mod.main(["--agent", "qlearn", "--episodes", "20", "--size", "6", "--runs-dir", str(tmp_path / "r"),
                           "--ckpt-dir", str(tmp_path / "c"), "--plot", str(tmp_path / "p.png")])
    assert code == 0 and (tmp_path / "p.png").exists()
    assert "best avg100" in capsys.readouterr().out


def test_short_seeded_dqn_run_beats_random(tmp_path):
    res = train_mod.train("dqn", 200, seed=1, size=6, runs_dir=tmp_path, ckpt_dir=tmp_path, quiet=True,
                          hp=dict(hidden=32, eps_decay=0.97, learn_start=200, target_sync=100))
    env = train_mod.env_for(res["agent"], size=6)
    dqn = statistics.fmean(train_mod.evaluate(res["agent"], env, 30, seed=500))
    rnd_agent = make_agent("random", seed=0)
    rnd = statistics.fmean(train_mod.evaluate(rnd_agent, train_mod.env_for(rnd_agent, size=6), 30, seed=500))
    assert dqn > rnd + 2


# ---- compare ---------------------------------------------------------------

def test_summarize():
    assert compare_mod.summarize([1, 2, 3, 10]) == {"mean": 4.0, "median": 2.5, "max": 10}


def test_compare_pipeline_and_cli(tmp_path, capsys):
    quick("qlearn", tmp_path, episodes=20)
    quick("dqn", tmp_path, episodes=5, hp=dict(hidden=8, learn_start=32))
    ck = tmp_path / "ck"
    res = compare_mod.compare(6, seed=7, size=6, ckpt_dir=ck)
    assert list(res) == ["random", "qlearn", "dqn"]
    assert all(set(v) == {"mean", "median", "max"} for v in res.values())
    assert res == compare_mod.compare(6, seed=7, size=6, ckpt_dir=ck)
    md = compare_mod.markdown_table(res, 6)
    assert md.splitlines()[0] == "| Agent | Mean | Median | Max |" and len(md.splitlines()) == 5
    out = tmp_path / "docs" / "t.md"
    code = compare_mod.main(["--episodes", "4", "--size", "6", "--ckpt-dir", str(ck), "--markdown", str(out)])
    assert code == 0 and out.read_text().startswith("| Agent")
    assert "qlearn" in capsys.readouterr().out


def test_compare_without_checkpoints_explains(tmp_path, capsys):
    with pytest.raises(FileNotFoundError, match="train.py --agent qlearn"):
        compare_mod.compare(2, ckpt_dir=tmp_path)
    assert compare_mod.main(["--episodes", "2", "--ckpt-dir", str(tmp_path)]) == 1
    assert "train.py" in capsys.readouterr().out


def test_train_cli_random_has_no_best_checkpoint(tmp_path, capsys):
    code = train_mod.main(["--agent", "random", "--episodes", "5", "--size", "6", "--runs-dir", str(tmp_path / "r"),
                           "--ckpt-dir", str(tmp_path / "c"), "--plot", ""])
    assert code == 0
    assert "best avg100" not in capsys.readouterr().out
