package hnsw

import (
	"errors"
	"math"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

func uniform(seed uint64, n, dim int) [][]float32 {
	rng := rand.New(rand.NewPCG(seed, seed+1))
	out := make([][]float32, n)
	for i := range out {
		v := make([]float32, dim)
		for j := range v {
			v[j] = rng.Float32()*2 - 1
		}
		out[i] = v
	}
	return out
}

func build(t testing.TB, cfg Config, vecs [][]float32) *Index {
	t.Helper()
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range vecs {
		id, err := h.Insert(v)
		if err != nil {
			t.Fatal(err)
		}
		if id != uint32(i) {
			t.Fatalf("insert %d got id %d", i, id)
		}
	}
	return h
}

// checkGraph verifies the structural invariants of every adjacency list.
func checkGraph(t testing.TB, h *Index) {
	t.Helper()
	for id, n := range h.nodes {
		if n == nil {
			continue
		}
		if len(n.links) != n.level+1 {
			t.Fatalf("node %d: level %d but %d link layers", id, n.level, len(n.links))
		}
		for layer, links := range n.links {
			if len(links) > h.maxLinks(layer) {
				t.Fatalf("node %d layer %d: %d links, cap %d", id, layer, len(links), h.maxLinks(layer))
			}
			seen := map[uint32]bool{}
			for _, to := range links {
				if to == uint32(id) {
					t.Fatalf("node %d layer %d links to itself", id, layer)
				}
				if seen[to] {
					t.Fatalf("node %d layer %d has duplicate link to %d", id, layer, to)
				}
				seen[to] = true
				if int(to) >= len(h.nodes) || h.nodes[to] == nil {
					t.Fatalf("node %d layer %d links to missing node %d", id, layer, to)
				}
				if h.nodes[to].level < layer {
					t.Fatalf("node %d layer %d links to node %d whose top layer is %d", id, layer, to, h.nodes[to].level)
				}
			}
		}
	}
}

// reachable counts nodes reachable from the entry point on one layer by
// following links, and how many nodes are on that layer in total.
func reachable(h *Index, layer int) (got, total int) {
	for _, n := range h.nodes {
		if n != nil && n.level >= layer {
			total++
		}
	}
	if !h.hasEnt {
		return 0, total
	}
	seen := map[uint32]bool{h.entry: true}
	queue := []uint32{h.entry}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, nb := range h.nodes[id].links[layer] {
			if !seen[nb] {
				seen[nb] = true
				queue = append(queue, nb)
			}
		}
	}
	return len(seen), total
}

func TestConfigDefaultsAndValidation(t *testing.T) {
	h, err := New(Config{Dim: 4, Metric: vecmath.MetricL2})
	if err != nil {
		t.Fatal(err)
	}
	c := h.Config()
	if c.M != DefaultM || c.EfConstruction != DefaultEfConstruction || c.EfSearch != DefaultEfSearch {
		t.Errorf("defaults not applied: %+v", c)
	}
	if h.maxLinks(0) != 2*DefaultM || h.maxLinks(1) != DefaultM {
		t.Errorf("link caps = %d/%d", h.maxLinks(0), h.maxLinks(1))
	}
	if h.Len() != 0 || h.MaxLevel() != -1 {
		t.Errorf("empty index: len=%d maxLevel=%d", h.Len(), h.MaxLevel())
	}
	bad := []Config{
		{Dim: 0, Metric: vecmath.MetricL2},
		{Dim: 4, Metric: 0},
		{Dim: 4, Metric: vecmath.MetricL2, M: 1},
		{Dim: 4, Metric: vecmath.MetricL2, M: 1000},
		{Dim: 4, Metric: vecmath.MetricL2, EfConstruction: -1},
		{Dim: 4, Metric: vecmath.MetricL2, EfSearch: -1},
	}
	for _, cfg := range bad {
		if _, err := New(cfg); err == nil {
			t.Errorf("New(%+v) should fail", cfg)
		}
	}
}

// With mL = 1/ln(M), P(level >= l) = M^-l. Check the empirical tail
// fractions against that for the first few layers.
func TestLevelDistribution(t *testing.T) {
	t.Parallel()
	for _, m := range []int{4, 16} {
		h, _ := New(Config{Dim: 1, Metric: vecmath.MetricL2, M: m, Seed: 1})
		if want := 1 / math.Log(float64(m)); math.Abs(h.mL-want) > 1e-12 {
			t.Fatalf("mL = %v, want %v", h.mL, want)
		}
		const n = 200_000
		atLeast := make([]int, levelCap+2)
		for range n {
			l := h.randomLevel()
			if l < 0 || l > levelCap {
				t.Fatalf("level %d out of range", l)
			}
			for i := 0; i <= l; i++ {
				atLeast[i]++
			}
		}
		if atLeast[0] != n {
			t.Fatalf("level >= 0 count = %d", atLeast[0])
		}
		for l := 1; l <= 3; l++ {
			want := math.Pow(float64(m), -float64(l))
			got := float64(atLeast[l]) / n
			// Allow 5 standard errors of a binomial proportion, plus a floor.
			tol := 5*math.Sqrt(want*(1-want)/n) + 1e-4
			if math.Abs(got-want) > tol {
				t.Errorf("M=%d: P(level>=%d) = %.5f, want %.5f ± %.5f", m, l, got, want, tol)
			}
			// Decay ratio between consecutive layers should be about 1/M.
			if atLeast[l-1] > 1000 {
				ratio := float64(atLeast[l]) / float64(atLeast[l-1])
				if math.Abs(ratio-1/float64(m)) > 0.25/float64(m) {
					t.Errorf("M=%d: layer %d/%d ratio %.4f, want about %.4f", m, l, l-1, ratio, 1/float64(m))
				}
			}
		}
	}
}

// Small M on a few thousand points forces lots of overflow and pruning.
func TestNeighborListsNeverExceedCap(t *testing.T) {
	t.Parallel()
	for _, m := range []int{3, 6, 16} {
		h := build(t, Config{Dim: 8, Metric: vecmath.MetricL2, M: m, EfConstruction: 40, Seed: 2}, uniform(2, 1500, 8))
		checkGraph(t, h)
		full := 0
		for _, n := range h.nodes {
			if len(n.links[0]) == h.maxLinks(0) {
				full++
			}
		}
		if full == 0 {
			t.Errorf("M=%d: no node ever hit the layer-0 cap, so pruning wasn't exercised", m)
		}
	}
}

func TestGraphConnectedAfterInserts(t *testing.T) {
	t.Parallel()
	h := build(t, Config{Dim: 16, Metric: vecmath.MetricCosine, M: 8, EfConstruction: 64, Seed: 3}, uniform(3, 2000, 16))
	checkGraph(t, h)
	if h.MaxLevel() < 2 {
		t.Fatalf("expected a few layers with 3000 points and M=8, got top layer %d", h.MaxLevel())
	}
	for layer := 0; layer <= h.MaxLevel(); layer++ {
		got, total := reachable(h, layer)
		if got != total {
			t.Errorf("layer %d: %d of %d nodes reachable from the entry point", layer, got, total)
		}
	}
	// The entry point must be on the top layer.
	if h.nodes[h.entry].level != h.MaxLevel() {
		t.Errorf("entry point is on layer %d, top is %d", h.nodes[h.entry].level, h.MaxLevel())
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	t.Parallel()
	cfg := Config{Dim: 8, Metric: vecmath.MetricL2, M: 6, EfConstruction: 32, Seed: 9}
	vecs := uniform(4, 500, 8)
	a := build(t, cfg, vecs)
	b := build(t, cfg, vecs)
	if a.entry != b.entry || a.top != b.top {
		t.Fatal("entry point differs between identical builds")
	}
	for i := range a.nodes {
		for l := range a.nodes[i].links {
			if !slices.Equal(a.nodes[i].links[l], b.nodes[i].links[l]) {
				t.Fatalf("node %d layer %d links differ", i, l)
			}
		}
	}
}

func TestInsertErrors(t *testing.T) {
	h, _ := New(Config{Dim: 3, Metric: vecmath.MetricCosine})
	if _, err := h.Insert([]float32{1, 2}); !errors.Is(err, vecmath.ErrDimensionMismatch) {
		t.Errorf("wrong dim: %v", err)
	}
	if _, err := h.Insert([]float32{0, 0, 0}); !errors.Is(err, vecmath.ErrZeroVector) {
		t.Errorf("zero vector with cosine: %v", err)
	}
	if h.Len() != 0 {
		t.Errorf("failed inserts changed Len to %d", h.Len())
	}
	// The stored vector is a normalized copy, not the caller's slice.
	v := []float32{3, 0, 4}
	id, err := h.Insert(v)
	if err != nil {
		t.Fatal(err)
	}
	v[0] = 100
	got := h.nodes[id].vec
	if math.Abs(float64(got[0])-0.6) > 1e-6 || math.Abs(float64(got[2])-0.8) > 1e-6 {
		t.Errorf("stored vector = %v, want (0.6, 0, 0.8)", got)
	}
}

func TestHeaps(t *testing.T) {
	rng := rand.New(rand.NewPCG(5, 6))
	var mn minHeap
	var mx maxHeap
	var all []float32
	for i := range 200 {
		d := rng.Float32()
		all = append(all, d)
		mn.push(candidate{uint32(i), d})
		mx.push(candidate{uint32(i), d})
	}
	slices.Sort(all)
	for i := range all {
		if got := mn.pop().dist; got != all[i] {
			t.Fatalf("minHeap pop %d = %v, want %v", i, got, all[i])
		}
	}
	sorted := mx.sorted()
	for i := range all {
		if sorted[i].dist != all[i] {
			t.Fatalf("maxHeap sorted[%d] = %v, want %v", i, sorted[i].dist, all[i])
		}
	}
}

func TestVisitedSetWraps(t *testing.T) {
	var v visitedSet
	v.reset(10)
	v.visit(3)
	v.gen = math.MaxUint32 // force the next reset to wrap
	v.marks[5] = 1         // a stale mark from generation 1
	v.reset(10)
	if v.gen != 1 || v.visit(5) {
		t.Errorf("after wrap: gen=%d, stale mark survived", v.gen)
	}
}
