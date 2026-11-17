package store

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// Writers upsert, overwrite and delete while readers query, get and read
// stats on the same collection. With -race this checks the locking; the
// readers also check every hit against its filter.
func TestConcurrentCollectionAccess(t *testing.T) {
	c := newColl(t, Config{Name: "race", Dim: 16, EfConstruction: 32, M: 8})
	items := docs(900, 16, 51)
	if _, err := c.Upsert(items[:300]); err != nil {
		t.Fatal(err)
	}

	var done atomic.Bool
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer done.Store(true)
		for i := 300; i < len(items); i += 20 {
			if _, err := c.Upsert(items[i : i+20]); err != nil {
				t.Errorf("upsert: %v", err)
				return
			}
			_, _ = c.Upsert(items[i-300 : i-290]) // overwrite: tombstones + auto cleanup
			c.Delete(items[i-150].ID)
		}
		c.Cleanup()
	}()

	filter := map[string]any{"lang": "go"}
	for r := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := r; !done.Load() || i < r+10; i++ {
				q := items[i%len(items)]
				hits, err := c.Query(Query{Vector: q.Vector, K: 5, Filter: filter})
				if err != nil {
					t.Errorf("query: %v", err)
					return
				}
				for _, h := range hits {
					if h.Metadata["lang"] != "go" {
						t.Errorf("hit %s fails the filter: %v", h.ID, h.Metadata)
						return
					}
				}
				if _, err := c.Get(q.ID); err != nil && !errors.Is(err, ErrNotFound) {
					t.Errorf("get: %v", err)
				}
				_ = c.Info()
				_ = c.Len()
				_ = c.IDs()
			}
		}()
	}
	wg.Wait()
	if c.Info().Tombstones != 0 {
		t.Errorf("tombstones after final cleanup: %d", c.Info().Tombstones)
	}
}

func TestConcurrentDBAccess(t *testing.T) {
	db := NewDB()
	var wg sync.WaitGroup
	for w := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 25 {
				name := fmt.Sprintf("c%d", (w*25+i)%40) // overlapping names: some creates collide
				if c, err := db.Create(Config{Name: name, Dim: 4}); err == nil {
					_, _ = c.Upsert([]Item{{ID: "x", Vector: []float32{1, 2, 3, 4}}})
				} else if !errors.Is(err, ErrExists) {
					t.Errorf("create: %v", err)
				}
				_, _ = db.Get(name)
				_ = db.List()
				if i%5 == 0 {
					_ = db.Drop(name)
				}
			}
		}()
	}
	wg.Wait()
	for _, c := range db.List() {
		if _, err := db.Get(c.Name()); err != nil {
			t.Errorf("listed collection %s not gettable", c.Name())
		}
	}
}
