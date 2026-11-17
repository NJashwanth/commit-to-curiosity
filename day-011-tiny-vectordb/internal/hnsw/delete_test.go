package hnsw

import (
	"math/rand/v2"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// churnSetup builds a 3,000-vector clustered index, deletes a seeded 25%
// of it and returns the index, the vectors, queries, and the deleted set.
func churnSetup(t *testing.T) (*Index, [][]float32, [][]float32, map[uint32]bool) {
	t.Helper()
	gen := vecmath.NewClusters(21, fixDim, 30, 0.15)
	vecs := gen.SampleN(3000)
	queries := gen.SampleN(150)
	h := build(t, fixCfg, vecs)
	rng := rand.New(rand.NewPCG(21, 22))
	deleted := map[uint32]bool{}
	for _, i := range rng.Perm(len(vecs))[:len(vecs)/4] {
		if !h.Delete(uint32(i)) {
			t.Fatalf("Delete(%d) returned false for a live node", i)
		}
		deleted[uint32(i)] = true
	}
	return h, vecs, queries, deleted
}

func TestDeletedNeverReturned(t *testing.T) {
	t.Parallel()
	h, vecs, queries, deleted := churnSetup(t)
	if h.Len() != len(vecs)-len(deleted) || h.Tombstones() != len(deleted) {
		t.Fatalf("Len=%d Tombstones=%d", h.Len(), h.Tombstones())
	}
	check := func(stage string) {
		for _, q := range queries {
			res, err := h.Search(q, 10, 32)
			if err != nil {
				t.Fatal(err)
			}
			if len(res) != 10 {
				t.Fatalf("%s: got %d results, want 10", stage, len(res))
			}
			for _, r := range res {
				if deleted[r.ID] {
					t.Fatalf("%s: deleted node %d returned", stage, r.ID)
				}
			}
		}
		// Searching for a deleted vector itself must not find it.
		for id := range deleted {
			res, _ := h.Search(vecs[id], 1, 32)
			if len(res) == 1 && res[0].ID == id {
				t.Fatalf("%s: search for deleted vector %d found it", stage, id)
			}
			break
		}
	}
	check("before cleanup")
	h.Cleanup()
	check("after cleanup")

	for id := range deleted {
		if h.Delete(id) || h.IsLive(id) {
			t.Fatalf("deleted node %d still live", id)
		}
		if _, ok := h.Vector(id); ok {
			t.Fatalf("Vector(%d) of a deleted node succeeded", id)
		}
	}
	if h.Delete(uint32(len(vecs) + 10)) {
		t.Error("Delete of an id never handed out returned true")
	}
}

func TestCleanupPreservesRecall(t *testing.T) {
	t.Parallel()
	h, vecs, queries, deleted := churnSetup(t)
	live := func(id uint32) bool { return !deleted[id] }
	truth := groundTruth(t, fixCfg.Metric, vecs, queries, fixK, live)

	before := recall(t, h, queries, truth, fixK, 128)
	if n := h.Cleanup(); n != len(deleted) {
		t.Fatalf("Cleanup removed %d, want %d", n, len(deleted))
	}
	after := recall(t, h, queries, truth, fixK, 128)
	t.Logf("recall@10 at ef=128 with 25%% deleted: %.4f with tombstones, %.4f after cleanup", before, after)

	if after < 0.95 {
		t.Errorf("recall after cleanup = %.4f, want >= 0.95", after)
	}
	if after+0.02 < before {
		t.Errorf("cleanup lost recall: %.4f -> %.4f", before, after)
	}

	// The graph is structurally sound: no links to removed nodes, every
	// live node reachable on every layer, entry on the top layer.
	checkGraph(t, h)
	if h.Tombstones() != 0 || h.Len() != len(vecs)-len(deleted) {
		t.Errorf("after cleanup Len=%d Tombstones=%d", h.Len(), h.Tombstones())
	}
	for id := range deleted {
		if h.nodes[id] != nil {
			t.Fatalf("slot %d not freed", id)
		}
	}
	for layer := 0; layer <= h.MaxLevel(); layer++ {
		if got, total := reachable(h, layer); got != total {
			t.Errorf("layer %d: %d of %d live nodes reachable after cleanup", layer, got, total)
		}
	}
	if h.nodes[h.entry].level != h.MaxLevel() {
		t.Errorf("entry on layer %d, top is %d", h.nodes[h.entry].level, h.MaxLevel())
	}

	// New inserts after cleanup get fresh ids and are findable.
	id, err := h.Insert(queries[0])
	if err != nil {
		t.Fatal(err)
	}
	if id != uint32(len(vecs)) {
		t.Errorf("insert after cleanup got id %d, want %d (ids are never reused)", id, len(vecs))
	}
	res, _ := h.Search(queries[0], 1, 32)
	if len(res) != 1 || res[0].ID != id {
		t.Errorf("new node not found after cleanup: %v", res)
	}
}

// Deleting the entry point and every node on the upper layers forces
// Cleanup to choose a new entry and rebuild the top of the graph.
func TestCleanupAfterDeletingUpperLayers(t *testing.T) {
	t.Parallel()
	vecs := uniform(31, 1500, 8)
	h := build(t, Config{Dim: 8, Metric: vecmath.MetricL2, M: 6, EfConstruction: 40, Seed: 31}, vecs)
	oldTop := h.MaxLevel()
	for id, n := range h.nodes {
		if n.level >= 1 {
			h.Delete(uint32(id))
		}
	}
	h.Cleanup()
	if h.MaxLevel() != 0 {
		t.Errorf("only layer-0 nodes are left, but top layer is %d (was %d)", h.MaxLevel(), oldTop)
	}
	checkGraph(t, h)
	if got, total := reachable(h, 0); got != total {
		t.Errorf("%d of %d reachable after removing all upper-layer nodes", got, total)
	}
	res, err := h.Search(vecs[0], 5, 32)
	if err != nil || len(res) != 5 {
		t.Errorf("search after cleanup: %v, %v", res, err)
	}
}

func TestDeleteEverything(t *testing.T) {
	h, _ := New(Config{Dim: 2, Metric: vecmath.MetricL2, M: 4, Seed: 1})
	for i := range 20 {
		_, _ = h.Insert([]float32{float32(i), 1})
	}
	for i := range 20 {
		h.Delete(uint32(i))
	}
	if res, err := h.Search([]float32{0, 0}, 3, 10); err != nil || len(res) != 0 {
		t.Errorf("search with everything deleted: %v, %v", res, err)
	}
	// Inserting into an all-tombstone index starts a fresh graph.
	id, err := h.Insert([]float32{5, 5})
	if err != nil {
		t.Fatal(err)
	}
	if h.Tombstones() != 0 || h.Len() != 1 || h.MaxLevel() < 0 {
		t.Errorf("after insert: len=%d tombs=%d top=%d", h.Len(), h.Tombstones(), h.MaxLevel())
	}
	res, _ := h.Search([]float32{0, 0}, 3, 10)
	if len(res) != 1 || res[0].ID != id {
		t.Errorf("search = %v, want only the new node %d", res, id)
	}
	if h.Cleanup() != 0 {
		t.Error("Cleanup with no tombstones should remove nothing")
	}
	h.Delete(id)
	if h.Cleanup() != 1 || h.MaxLevel() != -1 {
		t.Errorf("cleanup of the last node: top=%d", h.MaxLevel())
	}
	if st := h.Stats(); st.Live != 0 || len(st.LayerSizes) != 0 || st.AvgDegree0 != 0 {
		t.Errorf("empty stats = %+v", st)
	}
}

func TestSearchFilter(t *testing.T) {
	t.Parallel()
	f := getFixture(t)
	// Accept every 10th node: 500 of 5,000 match.
	tenth := func(id uint32) bool { return id%10 == 0 }
	truth := groundTruth(t, fixCfg.Metric, f.vecs, f.queries, fixK, tenth)

	hit, total := 0, 0
	for i, q := range f.queries {
		res, err := f.index.SearchFilter(q, fixK, 128, tenth)
		if err != nil {
			t.Fatal(err)
		}
		if len(res) != fixK {
			t.Fatalf("query %d: %d results, want %d", i, len(res), fixK)
		}
		got := map[uint32]bool{}
		for _, r := range res {
			if !tenth(r.ID) {
				t.Fatalf("query %d: result %d fails the filter", i, r.ID)
			}
			got[r.ID] = true
		}
		for _, id := range truth[i] {
			if got[id] {
				hit++
			}
		}
		total += len(truth[i])
	}
	r := float64(hit) / float64(total)
	t.Logf("filtered recall@10 (10%% selectivity, ef=128): %.4f", r)
	if r < 0.9 {
		t.Errorf("filtered recall = %.4f, want >= 0.9", r)
	}

	// Only 3 nodes match: all 3 come back, nothing else.
	three := func(id uint32) bool { return id == 7 || id == 1234 || id == 4999 }
	res, _ := f.index.SearchFilter(f.queries[0], fixK, 16, three)
	if len(res) != 3 {
		t.Errorf("3 matching nodes, got %d results: %v", len(res), res)
	}
	none := func(uint32) bool { return false }
	if res, _ := f.index.SearchFilter(f.queries[0], fixK, 16, none); len(res) != 0 {
		t.Errorf("reject-all filter returned %v", res)
	}
}

func TestVectorAndStats(t *testing.T) {
	t.Parallel()
	f := getFixture(t)
	v, ok := f.index.Vector(42)
	if !ok || len(v) != fixDim {
		t.Fatalf("Vector(42) = %v, %v", v, ok)
	}
	v[0] = 99 // a copy: must not change the index
	if f.index.nodes[42].vec[0] == 99 {
		t.Error("Vector returned the internal slice")
	}
	st := f.index.Stats()
	if st.Live != fixN || st.LayerSizes[0] != fixN || st.MaxLevel != f.index.MaxLevel() {
		t.Errorf("stats = %+v", st)
	}
	for l := 1; l < len(st.LayerSizes); l++ {
		if st.LayerSizes[l] >= st.LayerSizes[l-1] {
			t.Errorf("layer %d has %d nodes, layer below has %d", l, st.LayerSizes[l], st.LayerSizes[l-1])
		}
	}
	if st.AvgDegree0 < 4 || st.AvgDegree0 > float64(2*fixCfg.M) {
		t.Errorf("avg layer-0 degree %.1f out of range", st.AvgDegree0)
	}
	if f.index.Slots() != fixN {
		t.Errorf("Slots = %d", f.index.Slots())
	}
}
