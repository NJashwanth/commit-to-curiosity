# Arena results

100 games, round-robin with alternating first player, level **medium**, Elo K = 32 starting at 1500, seed 0. Played 2026-11-14 in 47.9s.

| Rank | Agent | Budget | Elo | W | L | D | Score | Avg think / move | Avg nodes / move |
|-----:|-------|--------|----:|--:|--:|--:|------:|-----------------:|-----------------:|
| 1 | mcts | mcts (5000 sims) | 1676 | 51 | 15 | 0 | 77.3% | 61.0 ms | 5,000 |
| 2 | minimax | minimax (depth 6, 2s) | 1654 | 49 | 18 | 0 | 73.1% | 5.2 ms | 1,029 |
| 3 | random | random | 1170 | 0 | 67 | 0 | 0.0% | 0.0 ms | 1 |

## Head to head

Wins-losses-draws for the row agent against the column agent.

| | mcts | minimax | random |
|---|---|---|---|
| **mcts** | - | 18-15-0 | 33-0-0 |
| **minimax** | 15-18-0 | - | 34-0-0 |
| **random** | 0-33-0 | 0-34-0 | - |

## First move

First player won 42, second player won 58, 0 drawn.
