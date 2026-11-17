package hnsw

import (
	"errors"
	"sync"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/flat"
	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// The shared recall fixture: 5,000 seeded clustered vectors, 200 queries
// from the same distribution, and exact top-10 answers from the flat index.
const (
	fixN       = 5000
	fixDim     = 32
	fixQueries = 200
	fixK       = 10
)

var fixCfg = Config{Dim: fixDim, Metric: vecmath.MetricCosine, M: 16, EfConstruction: 100, Seed: 11}

type fixture struct {
	vecs    [][]float32
	queries [][]float32
	truth   [][]uint32
	index   *Index
}

var (
	fixOnce sync.Once
	fix     fixture
)

func groundTruth(t testing.TB, metric vecmath.Metric, vecs, queries [][]float32, k int, accept func(uint32) bool) [][]uint32 {
	t.Helper()
	f, err := flat.New(metric, len(vecs[0]))
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range vecs {
		if accept == nil || accept(uint32(i)) {
			if err := f.Add(uint32(i), v); err != nil {
				t.Fatal(err)
			}
		}
	}
	truth := make([][]uint32, len(queries))
	for i, q := range queries {
		res, err := f.Search(q, k)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range res {
			truth[i] = append(truth[i], r.ID)
		}
	}
	return truth
}

func getFixture(t testing.TB) *fixture {
	t.Helper()
	fixOnce.Do(func() {
		gen := vecmath.NewClusters(11, fixDim, 40, 0.15)
		fix.vecs = gen.SampleN(fixN)
		fix.queries = gen.SampleN(fixQueries)
		fix.truth = groundTruth(t, fixCfg.Metric, fix.vecs, fix.queries, fixK, nil)
		fix.index = build(t, fixCfg, fix.vecs)
	})
	return &fix
}

// recall is the fraction of true top-k ids that the search returned.
func recall(t testing.TB, h *Index, queries [][]float32, truth [][]uint32, k, ef int) float64 {
	t.Helper()
	hit, total := 0, 0
	for i, q := range queries {
		res, err := h.Search(q, k, ef)
		if err != nil {
			t.Fatal(err)
		}
		got := map[uint32]bool{}
		for _, r := range res {
			got[r.ID] = true
		}
		for _, id := range truth[i] {
			if got[id] {
				hit++
			}
		}
		total += len(truth[i])
	}
	return float64(hit) / float64(total)
}

func TestRecallAtEf128(t *testing.T) {
	f := getFixture(t)
	r := recall(t, f.index, f.queries, f.truth, fixK, 128)
	t.Logf("recall@10 at ef=128 on %d vectors: %.4f", fixN, r)
	if r < 0.95 {
		t.Errorf("recall@10 = %.4f at ef=128, want >= 0.95", r)
	}
}

// More candidates can only help on average: recall must not drop as ef rises.
func TestRecallImprovesWithEf(t *testing.T) {
	f := getFixture(t)
	prev := -1.0
	for _, ef := range []int{10, 32, 128, 256} {
		r := recall(t, f.index, f.queries, f.truth, fixK, ef)
		t.Logf("ef=%d recall=%.4f", ef, r)
		if r+0.01 < prev {
			t.Errorf("recall dropped from %.4f to %.4f when ef rose to %d", prev, r, ef)
		}
		prev = r
	}
}

func TestSearchFindsInsertedVector(t *testing.T) {
	f := getFixture(t)
	for _, id := range []int{0, 17, 1234, fixN - 1} {
		res, err := f.index.Search(f.vecs[id], 1, 64)
		if err != nil {
			t.Fatal(err)
		}
		if len(res) != 1 || res[0].ID != uint32(id) || res[0].Distance > 1e-5 {
			t.Errorf("searching for vector %d returned %v", id, res)
		}
	}
}

func TestSearchResultsSortedAndSized(t *testing.T) {
	f := getFixture(t)
	for _, k := range []int{1, 5, 10, 100} {
		res, err := f.index.Search(f.queries[0], k, 0) // ef 0 means the default
		if err != nil {
			t.Fatal(err)
		}
		if len(res) != k {
			t.Errorf("k=%d returned %d results", k, len(res))
		}
		for i := 1; i < len(res); i++ {
			if res[i].Distance < res[i-1].Distance {
				t.Fatalf("k=%d results out of order at %d: %v", k, i, res)
			}
		}
	}
}

func TestSearchSmallAndEmpty(t *testing.T) {
	h, _ := New(Config{Dim: 2, Metric: vecmath.MetricL2, Seed: 1})
	if res, err := h.Search([]float32{0, 0}, 3, 10); err != nil || len(res) != 0 {
		t.Errorf("empty index: %v, %v", res, err)
	}
	pts := [][]float32{{0, 0}, {1, 0}, {0, 2}}
	for _, p := range pts {
		if _, err := h.Insert(p); err != nil {
			t.Fatal(err)
		}
	}
	// k larger than the index returns everything, in exact order.
	res, err := h.Search([]float32{0.1, 0}, 10, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 3 || res[0].ID != 0 || res[1].ID != 1 || res[2].ID != 2 {
		t.Errorf("k > n: %v, want ids 0, 1, 2", res)
	}
}

func TestSearchErrors(t *testing.T) {
	h, _ := New(Config{Dim: 2, Metric: vecmath.MetricCosine})
	_, _ = h.Insert([]float32{1, 0})
	if _, err := h.Search([]float32{1, 0}, 0, 10); !errors.Is(err, ErrInvalidK) {
		t.Errorf("k=0: %v", err)
	}
	if _, err := h.Search([]float32{1}, 1, 10); !errors.Is(err, vecmath.ErrDimensionMismatch) {
		t.Errorf("wrong dim: %v", err)
	}
	if _, err := h.Search([]float32{0, 0}, 1, 10); !errors.Is(err, vecmath.ErrZeroVector) {
		t.Errorf("zero query with cosine: %v", err)
	}
}
