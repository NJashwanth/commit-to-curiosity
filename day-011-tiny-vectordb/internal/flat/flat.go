// Package flat is an exact, brute-force vector index. It compares the
// query against every stored vector, so it is slow (O(n·dim) per query) but
// always right, which makes it the ground truth for measuring HNSW recall.
package flat

import (
	"errors"
	"fmt"
	"sort"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// ErrInvalidK is returned when k < 1.
var ErrInvalidK = errors.New("k must be at least 1")

// Result is one search hit. Smaller distances are closer.
type Result struct {
	ID       uint32
	Distance float32
}

// less orders results by distance, then by id so ties are deterministic.
func less(a, b Result) bool {
	if a.Distance != b.Distance {
		return a.Distance < b.Distance
	}
	return a.ID < b.ID
}

// Index stores vectors in a dense slice and scans all of them per query.
type Index struct {
	metric vecmath.Metric
	dim    int
	dist   vecmath.DistanceFunc
	ids    []uint32
	vecs   [][]float32
	pos    map[uint32]int // id -> position in ids/vecs
}

// New returns an empty index for dim-dimensional vectors.
func New(metric vecmath.Metric, dim int) (*Index, error) {
	if !metric.Valid() {
		return nil, fmt.Errorf("flat: invalid metric %v", metric)
	}
	if dim < 1 {
		return nil, fmt.Errorf("flat: dim must be at least 1, got %d", dim)
	}
	return &Index{metric: metric, dim: dim, dist: metric.Func(), pos: map[uint32]int{}}, nil
}

// Dim returns the vector dimension.
func (f *Index) Dim() int { return f.dim }

// Metric returns the distance metric.
func (f *Index) Metric() vecmath.Metric { return f.metric }

// Len returns the number of stored vectors.
func (f *Index) Len() int { return len(f.ids) }

// Add stores v under id, replacing any vector already stored there.
func (f *Index) Add(id uint32, v []float32) error {
	if len(v) != f.dim {
		return fmt.Errorf("flat: %w: index is %d-d, vector is %d-d", vecmath.ErrDimensionMismatch, f.dim, len(v))
	}
	p, err := f.metric.Prepare(v)
	if err != nil {
		return fmt.Errorf("flat: %w", err)
	}
	if i, ok := f.pos[id]; ok {
		f.vecs[i] = p
		return nil
	}
	f.pos[id] = len(f.ids)
	f.ids = append(f.ids, id)
	f.vecs = append(f.vecs, p)
	return nil
}

// Remove deletes id, reporting whether it was present.
func (f *Index) Remove(id uint32) bool {
	i, ok := f.pos[id]
	if !ok {
		return false
	}
	last := len(f.ids) - 1
	f.ids[i], f.vecs[i] = f.ids[last], f.vecs[last]
	f.pos[f.ids[i]] = i
	f.ids, f.vecs = f.ids[:last], f.vecs[:last]
	delete(f.pos, id)
	return true
}

// Search returns the exact k nearest vectors to q, closest first.
func (f *Index) Search(q []float32, k int) ([]Result, error) {
	return f.SearchFilter(q, k, nil)
}

// SearchFilter is Search restricted to ids for which accept returns true.
// A nil accept matches everything.
func (f *Index) SearchFilter(q []float32, k int, accept func(id uint32) bool) ([]Result, error) {
	if k < 1 {
		return nil, ErrInvalidK
	}
	if len(q) != f.dim {
		return nil, fmt.Errorf("flat: %w: index is %d-d, query is %d-d", vecmath.ErrDimensionMismatch, f.dim, len(q))
	}
	qv, err := f.metric.Prepare(q)
	if err != nil {
		return nil, fmt.Errorf("flat: %w", err)
	}

	// Keep a sorted slice of the best k so far. A new vector is only
	// inserted when it beats the current worst, which for k << n is rare,
	// so this costs about one comparison per vector.
	top := make([]Result, 0, min(k, len(f.ids)))
	for i, v := range f.vecs {
		id := f.ids[i]
		if accept != nil && !accept(id) {
			continue
		}
		r := Result{ID: id, Distance: f.dist(qv, v)}
		if len(top) == k && !less(r, top[k-1]) {
			continue
		}
		at := sort.Search(len(top), func(j int) bool { return less(r, top[j]) })
		if len(top) < k {
			top = append(top, Result{})
		}
		copy(top[at+1:], top[at:len(top)-1])
		top[at] = r
	}
	return top, nil
}
