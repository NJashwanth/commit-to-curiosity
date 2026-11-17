# Day 011: tiny-vectordb

**Date:** 2026-11-17

## What it does

A small vector database written from scratch in Go, using only the standard library. It stores vectors with string ids and JSON metadata in named collections. Search runs on an HNSW graph (Hierarchical Navigable Small World), and metadata filters are applied during the graph walk. Each collection snapshots to a checksummed binary file and is reloaded on startup. Everything is served over an HTTP JSON API.

```
$ curl -X POST localhost:8080/collections/docs/query -d '{"vector":[1,0.1,0,0.1],"k":5,"filter":{"lang":"go"}}'
{"results": [
  {"id": "go-http", "distance": 0.0001180172, "metadata": {"lang": "go", "stars": 120, "topic": "web"}},
  {"id": "go-sql",  "distance": 0.06767118,   "metadata": {"lang": "go", "stars": 45,  "topic": "db"}},
  {"id": "go-cli",  "distance": 0.7971363,    "metadata": {"lang": "go", "stars": 15,  "topic": "cli"}}
], "took_ms": 0.01}
```

On 50,000 clustered 128-d vectors, it finds 99.97% of the true 10 nearest neighbors (recall@10 of 0.9997) at 11x the speed of brute force. If 86% recall is acceptable, it is 34x faster.

## Why I built it

On Day 2 I put code embeddings into ChromaDB and asked it for the nearest chunks. It answered in about a millisecond, and I had no idea how. Comparing the query with every stored vector is easy to write but slow at scale. So how do vector databases skip almost all of the comparisons and still find the right neighbors? What happens to that shortcut when you delete things, or only want results where `lang = "go"`? HNSW is the index behind most of them (hnswlib, FAISS's HNSW, pgvector, Qdrant, Weaviate), so I built one from the paper.

## How HNSW works

**The structure.** Every vector is a node on layer 0, linked to up to 2M of its nearest neighbors. Each node also gets a random top layer L, drawn as `floor(-ln(U) * mL)` with `mL = 1/ln(M)`. That makes P(L ≥ l) = M⁻ˡ, so each layer up holds about 1/M of the nodes below it. With M = 16, the 50k benchmark index has 50,000 → 3,087 → 203 → 8 → 1 nodes per layer (the formula predicts 3,125, 195, 12 and 0.8). The upper layers work like an express train: few stops, long hops.

```
                                                                  links per node
layer 3   E ─────────────────────────────────── F                 ≤ M   (1 in ~4,000 nodes)
          │                                     │
layer 2   E ──────────────── B ──────────────── F ──────── H      ≤ M   (1 in ~256)
          │                  │                  │          │
layer 1   E ──── a ───────── B ──── C ───────── F ─── G ── H      ≤ M   (1 in 16)
          │      │           │      │           │     │    │
layer 0   E ─ · ─a─ · ─ · ─ ·B─ · ─ C ─ c ─ d ─ F ─ · G ─ ·H ─ ·  ≤ 2M  (every node)
```

**Search** starts at the single entry point on the top layer. On each upper layer it moves greedily to whichever neighbor is closer to the query, and drops a layer when no neighbor is closer. The node where it stops becomes the starting point one layer down. On layer 0 it switches to a best-first search that keeps the `ef` best candidates, and returns the top k of those.

```
query q sits between C and c on layer 0

layer 3   [E] ───────────────────────────────► [F]       E→F: F is closer to q. F has no closer neighbor here: go down.
                                                │
layer 2    E ──────────────── B ────────────── [F]       neither B nor H is closer than F: go down.
                                                │
layer 1    E ──── a ───────── B ──── [C] ◄──── [F]       F→C: C is closer. Nothing past C is closer: go down.
                                      │
layer 0   E ─ · ─ a ─ · ─ · ─ B ─ · ─[C]─[c]─[d]─ F ─ …   best-first from C, keeping the ef closest
                                       ▲                  seen so far; stop once the nearest unexpanded
                                       q                  candidate is further than the worst of the ef.
                                                          Return the top k: c, C, d, …
```

The upper layers use a handful of distance computations to get near the answer. Layer 0 then does a local, ef-wide search. A larger `ef` costs more time and gives better recall. That is the trade-off the benchmark below measures.

**Insertion** is a search for the new vector itself. It walks greedily down to the new node's top layer. Then, on every layer from there to 0, it runs an `efConstruction`-wide search, links the new node to M of the results and links them back. If a back-link pushes a neighbor over its cap, that neighbor re-chooses its links.

**Which M neighbors** matters more than I expected. The obvious choice is the M closest. The paper's heuristic (Algorithm 4) walks the candidates from closest to furthest and keeps one only if it is closer to the new node than to every neighbor already kept:

```
        2 (0, 1.5)                      closest-M picks 0, 1, 2
        │                               heuristic picks 0, 2, 3
3 ──────q────── 0 (1, 0)
(-2,0)           1 (1.1, 0.1)   ← closer to 0 than to q: reachable through 0, so skipped
```

Skipping candidates that sit "behind" an existing neighbor leaves room for links in other directions, including long links to other clusters. Without those links, a search can get stuck inside the wrong cluster (see Results).

**Deletes** mark the node as a tombstone. It stays in the graph so searches can still pass through it, but it is never returned. Once tombstones reach 20% of a collection (or the server's periodic maintenance runs), cleanup repairs the graph. Every live node that linked to a deleted one re-chooses its links from its live neighbors plus the deleted node's live neighbors, which bridges the gap. A node left with no candidates is relinked with a fresh search, and any node that nothing links to any more is reconnected the same way.

**Filters** run inside the layer-0 search, not after it. A node that fails the filter is still expanded, so the search can walk through it, but it never enters the result list. While the list holds fewer than `ef` matches, the stopping rule doesn't apply. So a selective filter makes the search look further instead of returning fewer than k results. Filtering after the search would hand back 2 results when you asked for 10.

## Tech used

- Go 1.27, standard library only (`go.mod` has no dependencies)
- `net/http` with Go 1.22+ method and wildcard routing, `encoding/binary`, `hash/crc32` (Castagnoli), `math/rand/v2` (PCG)
- `go test -race -cover`, plus a fuzz test on the graph decoder

```
internal/vecmath   dot, L2, cosine, normalize, metrics; seeded clustered data generator
internal/flat      exact brute-force index (ground truth)
internal/hnsw      graph, insertion, search, neighbor heuristic, deletes + repair, binary codec
internal/store     collections, metadata filters, snapshots, DB, maintenance loop
internal/api       HTTP handlers
cmd/server         go run ./cmd/server --data ./data --port 8080
cmd/bench          go run ./cmd/bench --n 50000 --dim 128 --k 10
scripts/check.sh   gofmt, go vet, go test -race -cover
```

## How to run

```bash
cd day-011-tiny-vectordb
go run ./cmd/server --data ./data --port 8080
```

Server flags: `--host` (default `127.0.0.1`), `--snapshot-interval` (default `30s`: how often to clean up tombstones and save changed collections) and `--quiet` (no per-request logs). On Ctrl-C or SIGTERM it finishes in-flight requests and saves every changed collection.

Benchmark and tests:

```bash
go run ./cmd/bench --n 50000 --dim 128 --k 10   # writes results/bench.md
./scripts/check.sh                              # gofmt, vet, go test -race -cover
```

`cmd/bench` also takes `--queries`, `--clusters`, `--spread`, `--metric`, `--m`, `--ef-construction`, `--ef 16,32,64`, `--seed`, `--threads` and `--out`.

## API

| Method | Path | Body / result |
|--------|------|---------------|
| `POST` | `/collections` | `{"name", "dim", "metric": "cosine"\|"dot"\|"l2", "m", "ef_construction", "ef_search"}` → 201 + info |
| `GET` | `/collections` | `{"collections": [info, …]}` |
| `GET` | `/collections/{name}` | config, count, tombstones, graph stats |
| `DELETE` | `/collections/{name}` | drops it and its snapshot file |
| `POST` | `/collections/{name}/upsert` | `{"items": [{"id", "vector", "metadata"}]}` → `{"upserted", "count"}` |
| `GET` | `/collections/{name}/items/{id}` | `{"id", "vector", "metadata"}` |
| `DELETE` | `/collections/{name}/items/{id}` | `{"deleted": id}` |
| `POST` | `/collections/{name}/query` | `{"vector", "k" (default 10), "ef", "filter", "include_vectors"}` → `{"results", "took_ms"}` |
| `POST` | `/collections/{name}/snapshot` | save now |
| `GET` | `/stats` | every collection's info, total documents, heap, uptime |

Errors are `{"error": "..."}`: 400 for invalid input, 404 for an unknown collection, id or route, 405 for a wrong method, 409 for a duplicate collection and 413 for bodies over 128 MB. An upsert batch is validated as a whole, so one bad item means nothing is written. `distance` is always "smaller is closer": `1 - cos` for cosine, `-a·b` for dot and Euclidean distance for l2. For cosine collections, vectors are stored normalized, so `GET` returns the unit-length version.

A session against the running server:

```bash
$ curl -X POST localhost:8080/collections -d '{"name":"docs","dim":4,"metric":"cosine"}'
{"name":"docs","dim":4,"metric":"cosine","m":16,"ef_construction":200,"ef_search":64,"count":0, ...}

$ curl -X POST localhost:8080/collections/docs/upsert -d '{"items": [
  {"id": "go-http",    "vector": [0.9, 0.1, 0.0, 0.1],    "metadata": {"lang": "go",     "topic": "web", "stars": 120}},
  {"id": "go-sql",     "vector": [0.8, 0.0, 0.3, 0.1],    "metadata": {"lang": "go",     "topic": "db",  "stars": 45}},
  {"id": "rust-actix", "vector": [0.85, 0.15, 0.05, 0.1], "metadata": {"lang": "rust",   "topic": "web", "stars": 300}},
  {"id": "py-flask",   "vector": [0.7, 0.3, 0.0, 0.2],    "metadata": {"lang": "python", "topic": "web", "stars": 210}},
  {"id": "go-cli",     "vector": [0.1, 0.9, 0.2, 0.0],    "metadata": {"lang": "go",     "topic": "cli", "stars": 15}}]}'
{"upserted":5,"count":5}

# unfiltered: rust-actix is the second closest
$ curl -X POST localhost:8080/collections/docs/query -d '{"vector":[1,0.1,0,0.1],"k":3}'
go-http 0.000118 (go) · rust-actix 0.004556 (rust) · py-flask 0.056884 (python)

# filtered: only Go docs, and all 3 of them although k=5
$ curl -X POST localhost:8080/collections/docs/query -d '{"vector":[1,0.1,0,0.1],"k":5,"filter":{"lang":"go"}}'
go-http 0.000118 · go-sql 0.067671 · go-cli 0.797136

# operators: web projects with at least 200 stars
$ curl -X POST localhost:8080/collections/docs/query -d '{"vector":[1,0.1,0,0.1],"k":2,"filter":{"topic":"web","stars":{"$gte":200}}}'
rust-actix 0.004556 · py-flask 0.056884

$ curl localhost:8080/stats
{"total_documents":5,"collections":[{"name":"docs","count":5,"tombstones":0,"graph":{"live":5,"tombstones":0,"max_level":1,"layer_sizes":[5,1],"avg_degree_l0":4}}], ...}
```

(Query output is shortened to `id distance`. The real responses are the JSON shown at the top.) After Ctrl-C the server logged `saved 1 dirty collections`. A restart logged `loaded 1 collections (5 documents)` and returned the same filtered results.

Filters are JSON objects, and every key must match. A plain value means equal, or "contains" when the field is an array. Operators: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte` and `$exists`.

### Snapshot format

One `<name>.tvdb` file per collection. It is written to a temp file, fsynced and renamed into place, so a crash mid-save leaves the old snapshot intact.

```
"TVDB" | version u16 | reserved u16 | payload length u64 | payload | CRC-32C of everything before it
payload = config | HNSW graph | documents (node, id, metadata JSON)
graph   = config, RNG state, entry point, then per node: state, level, float32 vector, varint neighbor ids per layer
```

The checks run in the order that gives the most useful error. Magic comes first ("not a tiny-vectordb snapshot"), then version ("file is version 2, this build reads version 1"), then length ("truncated"), then checksum ("checksum mismatch: the file is corrupt"), then structure. A bad file stops the server at startup with the file's path in the message, rather than being skipped. The RNG state is saved too, so a reloaded index assigns the same levels to new inserts as one that never stopped.

## Results

### Recall vs ef vs QPS

50,000 vectors, 128-d, cosine, in 100 Gaussian clusters (σ = 0.5 per dimension around centers in [-1, 1]). There are 1,000 queries from the same distribution, none of them in the index. M = 16 and efConstruction = 200. Measured on an Apple M2 (8 cores). Full report: [results/bench.md](results/bench.md).

| index | ef | recall@10 | QPS (1 thread) | p50 ms | p99 ms | QPS (8 threads) | speedup vs flat |
|-------|---:|----------:|---------------:|-------:|-------:|-----------------:|----------------:|
| flat | - | 1.0000 | 515 | 1.817 | 4.057 | 2,274 | 1.0x |
| hnsw | 16 | 0.8613 | 17,568 | 0.054 | 0.103 | 66,835 | 34.1x |
| hnsw | 32 | 0.9644 | 12,512 | 0.077 | 0.130 | 44,017 | 24.3x |
| hnsw | 64 | 0.9957 | 8,637 | 0.115 | 0.183 | 37,436 | 16.8x |
| hnsw | 128 | 0.9997 | 5,694 | 0.167 | 0.345 | 26,231 | 11.0x |
| hnsw | 256 | 0.9999 | 4,642 | 0.215 | 0.323 | 19,096 | 9.0x |

- **Flat vs HNSW:** brute force takes 1.8 ms per query (every one of the 50,000 vectors, 128 multiply-adds each). HNSW at ef=64 takes 0.115 ms and still finds 99.6% of the true neighbors: **16.8x faster**. It is 11x faster at 0.9997 recall and 34x faster at 0.86. The gap keeps growing with n, because flat search is O(n) and HNSW search is roughly O(log n).
- **ef is the dial.** Going from ef=16 to ef=64 costs 2x the time and removes 97% of the misses. Above ef=128 there is almost nothing left to find.
- **Build:** 15.7 s with one writer (3,177 inserts/s) at efConstruction = 200. The mean layer-0 degree is 19.1 out of a possible 32, because the heuristic often keeps fewer links than the cap.
- **Snapshot size:** the graph encodes to 28.3 MB, and the raw float32 vectors alone are 25.6 MB. Varint neighbor ids keep the links to about 10% on top of the vectors.
- These are single runs on a laptop, so treat individual QPS numbers as ±10-20%.

### Closest-M vs the heuristic

Same 5,000 clustered 32-d vectors, same seed, and only the neighbor selection changes (`TestHeuristicEscapesClusterTraps`):

| selection | recall@10 at ef=64 | at ef=256 |
|-----------|-------------------:|----------:|
| closest M | 0.948 | 0.963 |
| heuristic | 1.000 | 1.000 |

With closest-M, recall plateaued: quadrupling ef from 64 to 256 only moved it from 0.948 to 0.963, which pointed to a structural problem rather than a search-width one. The graph was fully connected (all 5,000 nodes reachable), and 177 of 200 queries found all 10 neighbors. But 6 queries found 3 or fewer, even at ef=256. Closest-M links almost never leave a cluster. So a search that reaches the bottom layer in the wrong cluster fills its candidate list with that cluster's points and stops. The heuristic keeps the long links between clusters, and the plateau went away.

### Harder data

The cluster spread changes how hard the problem is. At 20,000 vectors (`--n 20000 --spread …`), recall@10 looked like this:

| spread σ | ef=16 | ef=32 | ef=128 | ef=256 |
|---------:|------:|------:|-------:|-------:|
| 0.25 (tight clusters) | 0.942 | 0.991 | 1.000 | 1.000 |
| 0.5 (default) | 0.932 | 0.991 | 1.000 | 1.000 |
| 1.0 (clusters overlap) | 0.877 | 0.959 | 0.990 | 0.997 |

The more the clusters overlap, the closer the data gets to uniform 128-d noise, which has no structure for the graph to use. Real embeddings usually sit between these: lots of dimensions, but far lower intrinsic dimension.

### Tests

There are 83 tests, and `go test -race -cover ./...` gives 94.8% total coverage (vecmath and flat 100%, api 98.6%, hnsw 96.2%, store 92.9%, cmd/bench 91.3%, cmd/server 84.3%). What they check:

- **Vector math:** distances match hand-computed values; zero vectors (cosine errors, dot and L2 don't); dimension mismatch errors; the unrolled kernels match a naive loop at every length from 0 to 37.
- **Flat index:** exact top-k in the right order, matching a full sort on random data.
- **HNSW recall:** recall@10 ≥ 0.95 at ef=128 on the seeded 5k dataset (it gets 1.000), and recall never drops as ef rises.
- **Level distribution:** P(level ≥ l) stays within 5 standard errors of M⁻ˡ over 200,000 draws, for M = 4 and M = 16.
- **Graph invariants:** neighbor lists never exceed M (2M on layer 0), with no self-links or duplicates. Every node is reachable from the entry point on every layer, after inserts, after churn and after cleanup.
- **Deletes and cleanup:** deleted ids are never returned. Recall survives deleting 25% of nodes and cleaning up. Deleting every upper-layer node forces a new entry point.
- **Filters:** results only ever match the filter, k results come back when at least k match, recall against the exact filtered answer is ≥ 0.9 (measured 0.993-1.000), and every operator is covered.
- **Snapshots:** a reloaded collection gives identical results with and without filters, keeps evolving identically, and re-encodes byte for byte. Flipped bytes, a wrong version, bad magic, truncation and trailing garbage each give their own clear error. Every truncation and every single-byte flip of the graph encoding is rejected or decodes to a valid graph. The fuzz target ran 5.2M inputs without a panic.
- **Concurrency:** searches running during inserts, deletes and cleanups, at the index, collection and DB levels. Removing the read lock from `Search` makes `-race` report data races, so the test catches what it is meant to.
- **API:** status codes, validation messages and JSON shapes through `httptest`. The server test starts on a free port, writes over HTTP, shuts down and reloads the snapshot.

## What I learned

- **Neighbor selection is what makes HNSW work.** With closest-M, the graph was fully connected and recall still stalled around 0.96, however much ef I gave it. The paper says the heuristic matters for clustered data, and the per-query histogram showed exactly why: the misses were whole queries stranded in the wrong cluster, not a few neighbors here and there.
- **mL = 1/ln(M) is a neat trick.** It makes each layer about 1/M the size of the one below, so the top layers are tiny and the greedy descent takes a few dozen distance computations. The 50k index came out at 50,000 → 3,087 → 203 → 8 → 1 against a predicted 50,000 → 3,125 → 195 → 12 → 1.
- **Deletes are the hard part of a graph index.** Removing a node can cut the only path to a region of the graph. Tombstones keep the paths while hiding the node, and cleanup has to repair links, not just remove them. I also added a check for nodes that nothing links to any more, because pruning someone else's links can orphan a node without anyone noticing.
- **Filtering inside the search beats filtering afterwards,** but a filter that matches almost nothing turns the search into a near-full scan, because the stopping rule only applies once `ef` matches are in hand. Real databases switch to brute force over the matching ids when the filter is very selective. That would be the next step here.
- **Test every truncation of a binary format.** A loop over all prefix lengths found a real bug: a file cut off right after the RNG state decoded as a valid empty index, because I checked the error before reading the slot count but not after. I also check the version before the checksum, so a file from a newer build says "version 2" instead of "corrupt".
- **`-race` and `-cover` together are expensive in hot loops.** With `-race`, coverage counters become atomic, and the race detector instruments each one. The HNSW tests take 4.7 s with `-race`, 0.4 s with `-cover`, and 22 s with both. I also found out that `sync.Pool` deliberately drops some items under the race detector, so pooled search buffers kept reallocating. Inserts are serialized anyway, so they now use one dedicated buffer.

## Ideas to extend

- Switch to brute force over the matching ids when a filter is very selective, using a cheap estimate of how many ids it matches.
- SIMD distance kernels. The unrolled Go loop is decent, but 128-d dot products are exactly what SIMD is for.
- Product or scalar quantization (int8) to cut memory 4-16x, keeping full vectors for a final rerank.
- A write-ahead log, so writes between snapshots survive a crash.
- Concurrent inserts with per-node locks, as hnswlib does, instead of one writer at a time.
- Point Day 2's ask-my-repo at this instead of ChromaDB.

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
