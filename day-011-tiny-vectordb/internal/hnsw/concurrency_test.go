package hnsw

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// One writer inserts, deletes and cleans up while four readers search,
// read vectors and take stats. Run with -race: the race detector is the
// real assertion here. The readers also check that every result is sane.
func TestConcurrentSearchDuringInserts(t *testing.T) {
	t.Parallel()
	gen := vecmath.NewClusters(41, 16, 10, 0.2)
	initial := gen.SampleN(300)
	more := gen.SampleN(800)
	queries := gen.SampleN(40)
	h := build(t, Config{Dim: 16, Metric: vecmath.MetricCosine, M: 8, EfConstruction: 32, Seed: 41}, initial)

	var done atomic.Bool
	var searches atomic.Int64
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer done.Store(true)
		for i, v := range more {
			if _, err := h.Insert(v); err != nil {
				t.Errorf("insert: %v", err)
				return
			}
			if i%7 == 0 {
				h.Delete(uint32(i)) // ids 0..299 are from the initial batch
			}
			if i%300 == 299 {
				h.Cleanup()
			}
		}
	}()

	for r := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := r; !done.Load() || i < r+20; i++ {
				res, err := h.Search(queries[i%len(queries)], 10, 32)
				if err != nil {
					t.Errorf("search: %v", err)
					return
				}
				if len(res) != 10 {
					t.Errorf("search returned %d results", len(res))
					return
				}
				for j := 1; j < len(res); j++ {
					if res[j].Distance < res[j-1].Distance {
						t.Errorf("results out of order: %v", res)
						return
					}
				}
				_, _ = h.Vector(res[0].ID)
				_ = h.Stats()
				_ = h.Len() + h.Tombstones() + h.Slots() + h.MaxLevel()
				_ = h.IsLive(res[0].ID)
				searches.Add(1)
			}
		}()
	}
	wg.Wait()

	t.Logf("%d searches ran alongside %d inserts", searches.Load(), len(more))
	checkGraph(t, h)
	if got, total := reachable(h, 0); got != total {
		t.Errorf("after concurrent churn %d of %d reachable", got, total)
	}
}
