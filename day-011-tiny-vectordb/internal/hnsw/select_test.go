package hnsw

import (
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// selectionIndex builds an index whose nodes are exactly pts, without
// linking them, so selection can be tested on hand-placed points.
func selectionIndex(t *testing.T, cfg Config, pts [][]float32) *Index {
	t.Helper()
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pts {
		h.nodes = append(h.nodes, &node{vec: p, links: [][]uint32{nil}})
	}
	return h
}

// candidatesFrom returns every node as a candidate for base q, closest first.
func candidatesFrom(h *Index, q []float32) []candidate {
	c := make([]candidate, len(h.nodes))
	for i, n := range h.nodes {
		c[i] = candidate{uint32(i), h.dist(q, n.vec)}
	}
	sortCandidates(c)
	return c
}

func ids(c []candidate) []uint32 {
	out := make([]uint32, len(c))
	for i, x := range c {
		out[i] = x.id
	}
	return out
}

// The base node sits at the origin. Node 1 is right behind node 0 as seen
// from the origin, so the heuristic skips it in favour of nodes in other
// directions:
//
//	        2 (0, 1.5)
//	        |
//	3 ------q----- 0 (1, 0)
//	(-2,0)          1 (1.1, 0.1)   <- closer to 0 than to q: pruned
func TestHeuristicPrunesShadowedCandidate(t *testing.T) {
	pts := [][]float32{{1, 0}, {1.1, 0.1}, {0, 1.5}, {-2, 0}}
	q := []float32{0, 0}

	h := selectionIndex(t, Config{Dim: 2, Metric: vecmath.MetricL2}, pts)
	got := ids(h.selectNeighbors(candidatesFrom(h, q), 3))
	if want := []uint32{0, 2, 3}; !equalIDs(got, want) {
		t.Errorf("heuristic picked %v, want %v", got, want)
	}

	simple := selectionIndex(t, Config{Dim: 2, Metric: vecmath.MetricL2, SimpleSelection: true}, pts)
	got = ids(simple.selectNeighbors(candidatesFrom(simple, q), 3))
	if want := []uint32{0, 1, 2}; !equalIDs(got, want) {
		t.Errorf("simple selection picked %v, want the 3 closest %v", got, want)
	}
}

// Points in a line all shadow each other: only the closest survives the
// heuristic, and keepPrunedConnections refills the list in distance order.
func TestKeepPrunedConnections(t *testing.T) {
	pts := [][]float32{{1, 0}, {2, 0}, {3, 0}, {4, 0}, {5, 0}}
	q := []float32{0, 0}

	h := selectionIndex(t, Config{Dim: 2, Metric: vecmath.MetricL2}, pts)
	if got := ids(h.selectNeighbors(candidatesFrom(h, q), 3)); !equalIDs(got, []uint32{0}) {
		t.Errorf("heuristic on a line kept %v, want just [0]", got)
	}
	keep := selectionIndex(t, Config{Dim: 2, Metric: vecmath.MetricL2, KeepPrunedConnections: true}, pts)
	if got := ids(keep.selectNeighbors(candidatesFrom(keep, q), 3)); !equalIDs(got, []uint32{0, 1, 2}) {
		t.Errorf("keepPruned kept %v, want [0 1 2]", got)
	}
	// Fewer candidates than the cap: nothing to choose, keep all.
	if got := h.selectNeighbors(candidatesFrom(h, q)[:2], 3); len(got) != 2 {
		t.Errorf("2 candidates with cap 3 returned %d", len(got))
	}
}

func equalIDs(a, b []uint32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// On clustered data, closest-M links almost never leave a cluster, so a
// search that descends into the wrong cluster stays there no matter how
// large ef is. The heuristic keeps long links between clusters. Same data,
// same seed, only the selection differs.
func TestHeuristicEscapesClusterTraps(t *testing.T) {
	t.Parallel()
	f := getFixture(t)

	cfg := fixCfg
	cfg.SimpleSelection = true
	simple := build(t, cfg, f.vecs)
	simpleWide := recall(t, simple, f.queries, f.truth, fixK, 256)
	heurNarrow := recall(t, f.index, f.queries, f.truth, fixK, 64)
	heurWide := recall(t, f.index, f.queries, f.truth, fixK, 256)
	t.Logf("closest-M ef=256: %.4f   heuristic ef=64: %.4f   heuristic ef=256: %.4f", simpleWide, heurNarrow, heurWide)

	if heurWide < 0.99 {
		t.Errorf("heuristic recall at ef=256 = %.4f, want >= 0.99", heurWide)
	}
	if heurNarrow <= simpleWide {
		t.Errorf("heuristic at ef=64 (%.4f) should beat closest-M at ef=256 (%.4f)", heurNarrow, simpleWide)
	}
}

func TestHeuristicGraphStaysConnectedOnClusters(t *testing.T) {
	t.Parallel()
	f := getFixture(t)
	checkGraph(t, f.index)
	for layer := 0; layer <= f.index.MaxLevel(); layer++ {
		got, total := reachable(f.index, layer)
		if got != total {
			t.Errorf("layer %d: %d of %d nodes reachable", layer, got, total)
		}
	}
}

func TestKeepPrunedBuildRespectsCaps(t *testing.T) {
	t.Parallel()
	cfg := Config{Dim: 8, Metric: vecmath.MetricL2, M: 4, EfConstruction: 32, Seed: 5, KeepPrunedConnections: true}
	h := build(t, cfg, uniform(5, 1000, 8))
	checkGraph(t, h)
	if got, total := reachable(h, 0); got != total {
		t.Errorf("layer 0: %d of %d reachable", got, total)
	}
}
