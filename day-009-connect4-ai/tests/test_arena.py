from collections import Counter
from datetime import date

import pytest

import arena as arena_cli
from connect4.agents import RandomAgent
from connect4.arena import (
    expected_score,
    factories_for,
    parse_spec,
    play_game,
    run_arena,
    schedule,
    to_markdown,
    update_elo,
)
from connect4.minimax import MinimaxAgent

# ----- Elo math --------------------------------------------------------------------


def test_expected_score_known_values():
    assert expected_score(1500, 1500) == 0.5
    assert expected_score(1600, 1400) == pytest.approx(0.75975, abs=1e-5)
    assert expected_score(1400, 1600) == pytest.approx(0.24025, abs=1e-5)
    assert expected_score(1900, 1500) == pytest.approx(10 / 11)  # 400 points = 10:1 odds


def test_update_elo_known_values():
    assert update_elo(1500, 1500, 1.0) == (1516, 1484)
    assert update_elo(1500, 1500, 0.5) == (1500, 1500)
    assert update_elo(1500, 1500, 0.0, k=16) == (1492, 1508)
    winner, loser = update_elo(1600, 1400, 1.0)
    assert winner == pytest.approx(1607.69, abs=0.01)
    assert loser == pytest.approx(1392.31, abs=0.01)
    # An upset moves ratings much more.
    upset, favourite = update_elo(1400, 1600, 1.0)
    assert upset == pytest.approx(1424.31, abs=0.01)


def test_update_elo_conserves_points():
    a, b = update_elo(1712, 1388, 0.5, k=24)
    assert a + b == pytest.approx(1712 + 1388)


# ----- schedule ----------------------------------------------------------------------


def test_schedule_alternates_first_player_per_pairing():
    order = schedule(["a", "b", "c"], 12)
    assert len(order) == 12
    by_pair = {}
    for first, second in order:
        by_pair.setdefault(frozenset((first, second)), []).append(first)
    assert len(by_pair) == 3
    for firsts in by_pair.values():
        assert len(firsts) == 4
        assert all(x != y for x, y in zip(firsts, firsts[1:]))  # strictly alternating


def test_schedule_spreads_odd_totals_evenly():
    counts = Counter(frozenset(p) for p in schedule(["a", "b", "c"], 100))
    assert sorted(counts.values()) == [33, 33, 34]


def test_schedule_rejects_bad_input():
    with pytest.raises(ValueError, match="at least two"):
        schedule(["solo"], 4)
    with pytest.raises(ValueError, match="unique"):
        schedule(["a", "a"], 4)


# ----- games and tournaments ------------------------------------------------------------


def test_play_game_reaches_a_result():
    winner, board, think, nodes = play_game(RandomAgent(seed=1), RandomAgent(seed=2))
    assert board.is_over()
    assert winner == board.winner
    assert all(t >= 0 for t in think) and sum(nodes) == board.move_count


def test_minimax_beats_random_as_either_colour():
    for seed in range(4):
        w, _, _, _ = play_game(MinimaxAgent(depth=4), RandomAgent(seed=seed))
        assert w == 0
        w, _, _, _ = play_game(RandomAgent(seed=seed), MinimaxAgent(depth=4))
        assert w == 1


def small_factories():
    return {
        "random": lambda seed: RandomAgent(seed=seed),
        "rand2": lambda seed: RandomAgent(seed=seed + 1),
        "minimax": lambda seed: MinimaxAgent(depth=2),
    }


def test_arena_totals_add_up_and_first_player_alternates():
    seen = []
    result = run_arena(small_factories(), games=12, seed=3, on_game=lambda g, r: seen.append(g))
    assert len(result.games) == len(seen) == 12
    standings = result.standings.values()
    assert sum(s.wins for s in standings) == sum(s.losses for s in standings)
    assert sum(s.games for s in standings) == 2 * 12
    for s in standings:
        assert s.games == 8  # 2 pairings x 4 games each
        assert s.wins + s.losses + s.draws == s.games
        assert s.turns > 0 and s.avg_think_ms >= 0 and s.avg_nodes > 0
    # Each pairing alternates who goes first.
    by_pair = {}
    for g in result.games:
        by_pair.setdefault(frozenset((g.first, g.second)), []).append(g.first)
    for firsts in by_pair.values():
        assert all(x != y for x, y in zip(firsts, firsts[1:]))
    # Head to head agrees with the standings.
    for name, s in result.standings.items():
        rows = [v for (a, _), v in result.head_to_head.items() if a == name]
        assert [sum(r[i] for r in rows) for i in range(3)] == [s.wins, s.losses, s.draws]
    f, sec, d = result.first_player_record()
    assert f + sec + d == 12
    # Turns per game match the move strings.
    for g in result.games:
        assert sum(g.turns.values()) == len(g.moves)


def test_elo_is_zero_sum_and_ranks_minimax_first():
    result = run_arena(small_factories(), games=12, seed=3)
    total = sum(s.elo for s in result.standings.values())
    assert total == pytest.approx(1500 * 3)
    assert result.ranked()[0].name == "minimax"


def test_arena_is_reproducible_with_a_seed():
    a = run_arena(small_factories(), games=6, seed=8)
    b = run_arena(small_factories(), games=6, seed=8)
    assert [g.moves for g in a.games] == [g.moves for g in b.games]


def test_draws_are_recorded_for_both_sides():
    from connect4.engine import Board

    class Scripted:
        """Replays a known drawn game, one move per call."""

        def __init__(self, seed):
            self.last_info = None

        def choose_move(self, board: Board):
            return int("547125662261271266215743771576315353334444"[board.move_count]) - 1

    result = run_arena({"x": Scripted, "y": Scripted}, games=2)
    assert result.standings["x"].draws == result.standings["y"].draws == 2
    assert result.head_to_head[("x", "y")] == [0, 0, 2]
    assert result.standings["x"].elo == 1500
    assert result.first_player_record() == (0, 0, 2)
    assert result.standings["x"].nodes == 0


# ----- specs and report ---------------------------------------------------------------------


def test_parse_spec():
    assert parse_spec("mcts", "medium") == ("mcts", "mcts", "medium")
    assert parse_spec("minimax:hard", "medium") == ("minimax:hard", "minimax", "hard")
    assert parse_spec("minimax:medium", "medium") == ("minimax", "minimax", "medium")
    with pytest.raises(ValueError):
        parse_spec("deepblue", "easy")


def test_factories_build_fresh_seeded_agents():
    factories, descriptions = factories_for(["random", "mcts:easy"], "easy")
    assert set(factories) == {"random", "mcts"}
    a, b = factories["mcts"](5), factories["mcts"](5)
    assert a is not b and a.seed == 5
    assert descriptions["mcts"] == "mcts (300 sims)"


def test_markdown_report():
    result = run_arena(small_factories(), games=3, seed=0, level="easy")
    text = to_markdown(result, today=date(2026, 11, 14))
    assert text.startswith("# Arena results")
    assert "level **easy**" in text and "Played 2026-11-14" in text
    assert "| Rank | Agent | Budget | Elo |" in text
    assert "## Head to head" in text and "## First move" in text
    for name in ("random", "rand2", "minimax"):
        assert f"| **{name}** |" in text


# ----- CLI ------------------------------------------------------------------------------------


def test_cli_runs_and_saves(tmp_path, capsys):
    out = tmp_path / "nested" / "arena.md"
    code = arena_cli.main(["--games", "3", "--level", "easy", "--agents", "random,minimax", "--out", str(out)])
    assert code == 0
    text = out.read_text()
    assert "| minimax |" in text and "| random |" in text
    printed = capsys.readouterr().out
    assert "[  1/3]" in printed and f"Saved {out}" in printed


def test_cli_quiet(tmp_path, capsys):
    out = tmp_path / "a.md"
    assert arena_cli.main(["--games", "2", "--level", "easy", "--agents", "random,minimax", "--out", str(out), "--quiet"]) == 0
    assert "[  1/2]" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "argv, message",
    [
        (["--games", "0"], "at least 1"),
        (["--agents", "random,skynet"], "unknown agent"),
        (["--agents", "random"], "at least two"),
        (["--agents", "random,random"], "listed twice"),
    ],
)
def test_cli_rejects_bad_arguments(argv, message, tmp_path, capsys):
    code = arena_cli.main(argv + ["--out", str(tmp_path / "x.md")])
    assert code == 2
    assert message in capsys.readouterr().err
