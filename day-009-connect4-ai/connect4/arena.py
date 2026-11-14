"""Round-robin tournaments between agents, with Elo ratings."""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable, Iterable

from .agents import Agent, budget, make_agent
from .engine import Board

INITIAL_ELO = 1500.0
DEFAULT_K = 32.0

AgentFactory = Callable[[int], Agent]  # seed -> fresh agent

# ----- Elo -----------------------------------------------------------------------


def expected_score(rating_a: float, rating_b: float) -> float:
    """Probability-like score A is expected to take from a game against B."""
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))


def update_elo(
    rating_a: float, rating_b: float, score_a: float, k: float = DEFAULT_K
) -> tuple[float, float]:
    """New ratings after one game. ``score_a`` is 1 (A won), 0.5 or 0."""
    delta = k * (score_a - expected_score(rating_a, rating_b))
    return rating_a + delta, rating_b - delta


# ----- games -----------------------------------------------------------------------


@dataclass
class GameRecord:
    index: int
    first: str
    second: str
    winner: str | None  # agent name, or None for a draw
    moves: str  # 1-based columns, e.g. "4453..."
    think: dict[str, float]  # total seconds spent thinking, per agent
    turns: dict[str, int]  # moves made, per agent
    nodes: dict[str, int]  # nodes or simulations, per agent


def play_game(first: Agent, second: Agent) -> tuple[int | None, Board, list[float], list[int]]:
    """Play one game. Returns (winning seat or None, final board, think times, nodes)."""
    board = Board()
    seats = (first, second)
    think = [0.0, 0.0]
    nodes = [0, 0]
    while not board.is_over():
        seat = board.current_player
        start = time.perf_counter()
        move = seats[seat].choose_move(board)
        think[seat] += time.perf_counter() - start
        info = seats[seat].last_info
        nodes[seat] += info.nodes if info else 0
        board.play(move)
    return board.winner, board, think, nodes


def schedule(names: list[str], games: int) -> list[tuple[str, str]]:
    """Round-robin order of (first, second) pairs.

    Each round plays every pairing once; who moves first flips every round,
    so each pairing alternates first player game by game.
    """
    if len(names) < 2:
        raise ValueError("an arena needs at least two agents")
    if len(set(names)) != len(names):
        raise ValueError("agent names must be unique")
    pairs = list(itertools.combinations(names, 2))
    order: list[tuple[str, str]] = []
    for rnd in itertools.count():
        for a, b in pairs:
            if len(order) == games:
                return order
            order.append((a, b) if rnd % 2 == 0 else (b, a))
    raise AssertionError("unreachable")  # pragma: no cover


# ----- standings -------------------------------------------------------------------


@dataclass
class Standing:
    name: str
    description: str = ""
    elo: float = INITIAL_ELO
    wins: int = 0
    losses: int = 0
    draws: int = 0
    turns: int = 0
    think: float = 0.0
    nodes: int = 0

    @property
    def games(self) -> int:
        return self.wins + self.losses + self.draws

    @property
    def score(self) -> float:
        """Points per game: a win is 1, a draw 0.5."""
        return (self.wins + 0.5 * self.draws) / self.games if self.games else 0.0

    @property
    def avg_think_ms(self) -> float:
        return 1000 * self.think / self.turns if self.turns else 0.0

    @property
    def avg_nodes(self) -> float:
        return self.nodes / self.turns if self.turns else 0.0


@dataclass
class ArenaResult:
    standings: dict[str, Standing]
    games: list[GameRecord]
    k: float
    seed: int
    level: str = ""
    elapsed: float = 0.0
    head_to_head: dict[tuple[str, str], list[int]] = field(default_factory=dict)

    def ranked(self) -> list[Standing]:
        return sorted(self.standings.values(), key=lambda s: (-s.elo, s.name))

    def first_player_record(self) -> tuple[int, int, int]:
        """(first player wins, second player wins, draws)."""
        first = sum(1 for g in self.games if g.winner == g.first)
        second = sum(1 for g in self.games if g.winner == g.second)
        return first, second, len(self.games) - first - second


def run_arena(
    factories: dict[str, AgentFactory],
    games: int,
    k: float = DEFAULT_K,
    seed: int = 0,
    level: str = "",
    descriptions: dict[str, str] | None = None,
    on_game: Callable[[GameRecord, ArenaResult], None] | None = None,
) -> ArenaResult:
    """Play ``games`` games round-robin and rate everyone with Elo.

    Every game gets fresh agents seeded with ``seed + game index``, so a run
    is reproducible and no search table leaks from one game to the next.
    Ratings are updated after each game in the order played.
    """
    names = list(factories)
    descriptions = descriptions or {}
    standings = {n: Standing(n, descriptions.get(n, n)) for n in names}
    result = ArenaResult(standings, [], k, seed, level)
    for a, b in itertools.permutations(names, 2):
        result.head_to_head[(a, b)] = [0, 0, 0]  # a's wins, losses, draws vs b
    start = time.perf_counter()
    for index, (first, second) in enumerate(schedule(names, games)):
        game_seed = seed + index
        agents = (factories[first](game_seed), factories[second](game_seed + 10_000))
        winner_seat, board, think, nodes = play_game(*agents)
        seats = (first, second)
        winner = None if winner_seat is None else seats[winner_seat]
        record = GameRecord(
            index=index,
            first=first,
            second=second,
            winner=winner,
            moves="".join(str(c + 1) for c in board.moves),
            think={first: think[0], second: think[1]},
            turns={first: (board.move_count + 1) // 2, second: board.move_count // 2},
            nodes={first: nodes[0], second: nodes[1]},
        )
        _record(result, record)
        if on_game:
            on_game(record, result)
    result.elapsed = time.perf_counter() - start
    return result


def _record(result: ArenaResult, g: GameRecord) -> None:
    a, b = result.standings[g.first], result.standings[g.second]
    if g.winner is None:
        score_a = 0.5
        a.draws += 1
        b.draws += 1
        result.head_to_head[(a.name, b.name)][2] += 1
        result.head_to_head[(b.name, a.name)][2] += 1
    else:
        score_a = 1.0 if g.winner == a.name else 0.0
        win, lose = (a, b) if score_a else (b, a)
        win.wins += 1
        lose.losses += 1
        result.head_to_head[(win.name, lose.name)][0] += 1
        result.head_to_head[(lose.name, win.name)][1] += 1
    a.elo, b.elo = update_elo(a.elo, b.elo, score_a, result.k)
    for s in (a, b):
        s.turns += g.turns[s.name]
        s.think += g.think[s.name]
        s.nodes += g.nodes[s.name]
    result.games.append(g)


# ----- building agents from names --------------------------------------------------


def parse_spec(spec: str, default_level: str) -> tuple[str, str, str]:
    """"mcts" or "mcts:hard" -> (label, agent name, level)."""
    name, _, level = spec.partition(":")
    level = level or default_level
    budget(name, level)  # validates both
    label = name if level == default_level else f"{name}:{level}"
    return label, name, level


def factories_for(specs: Iterable[str], level: str) -> tuple[dict[str, AgentFactory], dict[str, str]]:
    factories: dict[str, AgentFactory] = {}
    descriptions: dict[str, str] = {}
    for spec in specs:
        label, name, lvl = parse_spec(spec.strip(), level)
        if label in factories:
            raise ValueError(f"agent {label!r} is listed twice")
        factories[label] = lambda seed, n=name, lv=lvl: make_agent(n, lv, seed=seed)
        descriptions[label] = make_agent(name, lvl).describe()
    if len(factories) < 2:
        raise ValueError("an arena needs at least two agents")
    return factories, descriptions


# ----- report -------------------------------------------------------------------------


def to_markdown(result: ArenaResult, today: date | None = None) -> str:
    today = today or date.today()
    ranked = result.ranked()
    lines = [
        "# Arena results",
        "",
        f"{len(result.games)} games, round-robin with alternating first player"
        + (f", level **{result.level}**" if result.level else "")
        + f", Elo K = {result.k:g} starting at {INITIAL_ELO:g}, seed {result.seed}."
        + f" Played {today.isoformat()} in {result.elapsed:.1f}s.",
        "",
        "| Rank | Agent | Budget | Elo | W | L | D | Score | Avg think / move | Avg nodes / move |",
        "|-----:|-------|--------|----:|--:|--:|--:|------:|-----------------:|-----------------:|",
    ]
    for rank, s in enumerate(ranked, 1):
        lines.append(
            f"| {rank} | {s.name} | {s.description} | {s.elo:.0f} | {s.wins} | {s.losses} | {s.draws}"
            f" | {100 * s.score:.1f}% | {s.avg_think_ms:.1f} ms | {s.avg_nodes:,.0f} |"
        )
    names = [s.name for s in ranked]
    lines += [
        "",
        "## Head to head",
        "",
        "Wins-losses-draws for the row agent against the column agent.",
        "",
        "| | " + " | ".join(names) + " |",
        "|---|" + "---|" * len(names),
    ]
    for a in names:
        cells = []
        for b in names:
            if a == b:
                cells.append("-")
            else:
                w, l, d = result.head_to_head[(a, b)]
                cells.append(f"{w}-{l}-{d}")
        lines.append(f"| **{a}** | " + " | ".join(cells) + " |")
    first, second, draws = result.first_player_record()
    lines += [
        "",
        "## First move",
        "",
        f"First player won {first}, second player won {second}, {draws} drawn.",
        "",
    ]
    return "\n".join(lines)


def save_markdown(result: ArenaResult, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(to_markdown(result))
    return path
