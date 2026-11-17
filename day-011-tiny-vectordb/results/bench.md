# tiny-vectordb benchmark

Generated 2026-11-17 by:

```
go run ./cmd/bench --n 50000 --dim 128 --k 10 --queries 1000 --clusters 100 --spread 0.5 --metric cosine --m 16 --ef-construction 200 --ef 16,32,64,128,256 --seed 42 --threads 8
```

## Setup

| | |
|---|---|
| vectors | 50000 × 128-d, cosine |
| data | 100 Gaussian clusters, σ = 0.5 per dimension, centers uniform in [-1, 1] |
| queries | 1000, drawn from the same distribution (not in the index) |
| HNSW | M = 16 (layer 0: 32), efConstruction = 200, neighbor heuristic on |
| machine | darwin/arm64, 8 CPUs, go1.27.4 |

## Build

- HNSW build: **15.74 s** (3177 inserts/s, single writer)
- Layers: 5 (nodes per layer, bottom up: 50000, 3087, 203, 8, 1)
- Mean layer-0 degree: 19.1 of a possible 32
- Graph snapshot: 28.3 MB (raw vectors alone are 25.6 MB)

## Queries

Recall@k is the fraction of the true k nearest neighbors (from the flat index) that HNSW returned. Latency and single-thread QPS come from one pass over the queries on one goroutine; the threaded column runs the same queries spread across goroutines. Speedup is single-thread HNSW QPS over single-thread flat QPS.

| index | ef | recall@10 | QPS (1 thread) | p50 ms | p99 ms | QPS (8 threads) | speedup vs flat |
|-------|---:|----------:|---------------:|-------:|-------:|-----------------:|----------------:|
| flat | - | 1.0000 | 515 | 1.817 | 4.057 | 2274 | 1.0x |
| hnsw | 16 | 0.8613 | 17568 | 0.054 | 0.103 | 66835 | 34.1x |
| hnsw | 32 | 0.9644 | 12512 | 0.077 | 0.130 | 44017 | 24.3x |
| hnsw | 64 | 0.9957 | 8637 | 0.115 | 0.183 | 37436 | 16.8x |
| hnsw | 128 | 0.9997 | 5694 | 0.167 | 0.345 | 26231 | 11.0x |
| hnsw | 256 | 0.9999 | 4642 | 0.215 | 0.323 | 19096 | 9.0x |
