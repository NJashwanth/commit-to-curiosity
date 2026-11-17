package flat

import (
	"errors"
	"math/rand/v2"
	"sort"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

func mustNew(t *testing.T, m vecmath.Metric, dim int) *Index {
	t.Helper()
	f, err := New(m, dim)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestNewValidates(t *testing.T) {
	if _, err := New(0, 3); err == nil {
		t.Error("invalid metric should fail")
	}
	if _, err := New(vecmath.MetricL2, 0); err == nil {
		t.Error("dim 0 should fail")
	}
	f := mustNew(t, vecmath.MetricDot, 4)
	if f.Dim() != 4 || f.Metric() != vecmath.MetricDot || f.Len() != 0 {
		t.Errorf("accessors: dim=%d metric=%v len=%d", f.Dim(), f.Metric(), f.Len())
	}
}

// Points on a line make the exact order obvious.
func TestExactOrderL2(t *testing.T) {
	f := mustNew(t, vecmath.MetricL2, 2)
	for i, x := range []float32{5, 1, 9, 3, 7} {
		if err := f.Add(uint32(i), []float32{x, 0}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := f.Search([]float32{2, 0}, 3)
	if err != nil {
		t.Fatal(err)
	}
	// Distances from x=2: id1 (x=1) 1, id3 (x=3) 1, id0 (x=5) 3. Tie broken by id.
	want := []Result{{1, 1}, {3, 1}, {0, 3}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestExactOrderDotAndCosine(t *testing.T) {
	f := mustNew(t, vecmath.MetricDot, 2)
	_ = f.Add(10, []float32{1, 0})
	_ = f.Add(11, []float32{3, 0}) // largest dot with (1,0)
	_ = f.Add(12, []float32{0, 5})
	got, _ := f.Search([]float32{1, 0}, 3)
	if got[0].ID != 11 || got[1].ID != 10 || got[2].ID != 12 {
		t.Errorf("dot order = %v, want 11, 10, 12", got)
	}

	c := mustNew(t, vecmath.MetricCosine, 2)
	_ = c.Add(1, []float32{1, 1})
	_ = c.Add(2, []float32{10, 0}) // same direction as the query, length ignored
	_ = c.Add(3, []float32{-1, 0})
	got, _ = c.Search([]float32{0.5, 0}, 3)
	if got[0].ID != 2 || got[1].ID != 1 || got[2].ID != 3 {
		t.Errorf("cosine order = %v, want 2, 1, 3", got)
	}
	if got[0].Distance > 1e-6 || got[2].Distance < 1.999 {
		t.Errorf("cosine distances = %v, want ~0 and ~2", got)
	}
}

// Against a full sort on random data, for several k including k > n.
func TestMatchesFullSort(t *testing.T) {
	const n, dim = 300, 8
	rng := rand.New(rand.NewPCG(3, 4))
	f := mustNew(t, vecmath.MetricL2, dim)
	vecs := make([][]float32, n)
	for i := range vecs {
		v := make([]float32, dim)
		for j := range v {
			v[j] = rng.Float32()
		}
		vecs[i] = v
		_ = f.Add(uint32(i), v)
	}
	for trial := range 20 {
		q := make([]float32, dim)
		for j := range q {
			q[j] = rng.Float32()
		}
		all := make([]Result, n)
		for i, v := range vecs {
			d, _ := vecmath.L2(q, v)
			all[i] = Result{uint32(i), d}
		}
		sort.Slice(all, func(a, b int) bool { return less(all[a], all[b]) })
		for _, k := range []int{1, 10, 50, n + 5} {
			got, err := f.Search(q, k)
			if err != nil {
				t.Fatal(err)
			}
			want := all[:min(k, n)]
			if len(got) != len(want) {
				t.Fatalf("trial %d k=%d: %d results, want %d", trial, k, len(got), len(want))
			}
			for i := range want {
				if got[i].ID != want[i].ID {
					t.Fatalf("trial %d k=%d rank %d: id %d, want %d", trial, k, i, got[i].ID, want[i].ID)
				}
			}
		}
	}
}

func TestAddReplaceRemove(t *testing.T) {
	f := mustNew(t, vecmath.MetricL2, 1)
	_ = f.Add(1, []float32{1})
	_ = f.Add(2, []float32{2})
	_ = f.Add(3, []float32{3})
	_ = f.Add(1, []float32{10}) // replace
	if f.Len() != 3 {
		t.Fatalf("len = %d, want 3", f.Len())
	}
	got, _ := f.Search([]float32{0}, 1)
	if got[0].ID != 2 {
		t.Errorf("after replace nearest = %d, want 2", got[0].ID)
	}
	if !f.Remove(2) || f.Remove(2) {
		t.Error("Remove should succeed once")
	}
	got, _ = f.Search([]float32{0}, 5)
	if len(got) != 2 || got[0].ID != 3 || got[1].ID != 1 {
		t.Errorf("after remove = %v, want ids 3, 1", got)
	}
}

func TestFilter(t *testing.T) {
	f := mustNew(t, vecmath.MetricL2, 1)
	for i := range 20 {
		_ = f.Add(uint32(i), []float32{float32(i)})
	}
	odd := func(id uint32) bool { return id%2 == 1 }
	got, _ := f.SearchFilter([]float32{0}, 3, odd)
	if len(got) != 3 || got[0].ID != 1 || got[1].ID != 3 || got[2].ID != 5 {
		t.Errorf("odd filter = %v, want 1, 3, 5", got)
	}
	none := func(uint32) bool { return false }
	if got, _ := f.SearchFilter([]float32{0}, 3, none); len(got) != 0 {
		t.Errorf("reject-all filter returned %v", got)
	}
}

func TestErrors(t *testing.T) {
	f := mustNew(t, vecmath.MetricCosine, 2)
	if err := f.Add(1, []float32{1, 2, 3}); !errors.Is(err, vecmath.ErrDimensionMismatch) {
		t.Errorf("Add wrong dim: %v", err)
	}
	if err := f.Add(1, []float32{0, 0}); !errors.Is(err, vecmath.ErrZeroVector) {
		t.Errorf("Add zero for cosine: %v", err)
	}
	_ = f.Add(1, []float32{1, 0})
	if _, err := f.Search([]float32{1, 0}, 0); !errors.Is(err, ErrInvalidK) {
		t.Errorf("k=0: %v", err)
	}
	if _, err := f.Search([]float32{1}, 1); !errors.Is(err, vecmath.ErrDimensionMismatch) {
		t.Errorf("query wrong dim: %v", err)
	}
	if _, err := f.Search([]float32{0, 0}, 1); !errors.Is(err, vecmath.ErrZeroVector) {
		t.Errorf("zero query for cosine: %v", err)
	}
	empty := mustNew(t, vecmath.MetricL2, 2)
	if got, err := empty.Search([]float32{1, 1}, 5); err != nil || len(got) != 0 {
		t.Errorf("empty index = %v, %v", got, err)
	}
}
