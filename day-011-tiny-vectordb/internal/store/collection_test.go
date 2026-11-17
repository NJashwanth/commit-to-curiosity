package store

import (
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/flat"
	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

var langs = []string{"go", "rust", "python", "js"}

// docs makes n seeded clustered documents with metadata: lang cycles
// through 4 values, year through 2015-2024, and every 3rd doc is tagged.
func docs(n, dim int, seed uint64) []Item {
	gen := vecmath.NewClusters(seed, dim, 12, 0.2)
	items := make([]Item, n)
	for i := range items {
		meta := map[string]any{
			"lang": langs[i%len(langs)],
			"year": 2015 + i%10,
		}
		if i%3 == 0 {
			meta["tags"] = []string{"db", "fast"}
		}
		items[i] = Item{ID: fmt.Sprintf("doc-%d", i), Vector: gen.Sample(), Metadata: meta}
	}
	return items
}

func newColl(t testing.TB, cfg Config) *Collection {
	t.Helper()
	c, err := NewCollection(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func loaded(t testing.TB, n int) (*Collection, []Item) {
	t.Helper()
	c := newColl(t, Config{Name: "docs", Dim: 16, EfConstruction: 64})
	items := docs(n, 16, 7)
	if got, err := c.Upsert(items); err != nil || got != n {
		t.Fatalf("Upsert = %d, %v", got, err)
	}
	return c, items
}

func TestConfigValidation(t *testing.T) {
	c := newColl(t, Config{Name: "a", Dim: 3})
	cfg := c.Config()
	if cfg.Metric != "cosine" || cfg.M != 16 || cfg.EfConstruction != 200 || cfg.EfSearch != 64 {
		t.Errorf("defaults = %+v", cfg)
	}
	if newColl(t, Config{Name: "b", Dim: 3, Metric: "Euclidean"}).Config().Metric != "l2" {
		t.Error("metric name not canonicalized")
	}
	bad := []Config{
		{Name: "", Dim: 3},
		{Name: "has space", Dim: 3},
		{Name: "../etc", Dim: 3},
		{Name: "-leading", Dim: 3},
		{Name: string(make([]byte, 65)), Dim: 3},
		{Name: "ok", Dim: 0},
		{Name: "ok", Dim: MaxDim + 1},
		{Name: "ok", Dim: 3, Metric: "hamming"},
		{Name: "ok", Dim: 3, M: 1},
		{Name: "ok", Dim: 3, M: 500},
		{Name: "ok", Dim: 3, EfConstruction: -5},
		{Name: "ok", Dim: 3, EfSearch: MaxEf + 1},
	}
	for _, cfg := range bad {
		if _, err := NewCollection(cfg); !errors.Is(err, ErrInvalid) {
			t.Errorf("NewCollection(%+v) err = %v, want ErrInvalid", cfg, err)
		}
	}
}

func TestUpsertGetReplaceDelete(t *testing.T) {
	c := newColl(t, Config{Name: "t", Dim: 2, Metric: "l2"})
	_, err := c.Upsert([]Item{
		{ID: "a", Vector: []float32{0, 0}, Metadata: map[string]any{"n": 1}},
		{ID: "b", Vector: []float32{10, 0}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Get("a")
	if err != nil || got.Vector[0] != 0 || got.Metadata["n"] != float64(1) {
		t.Errorf("Get(a) = %+v, %v (metadata numbers come back as JSON numbers)", got, err)
	}

	// Replace "a": the old vector must stop matching.
	if _, err := c.Upsert([]Item{{ID: "a", Vector: []float32{20, 0}, Metadata: map[string]any{"n": 2}}}); err != nil {
		t.Fatal(err)
	}
	if c.Len() != 2 {
		t.Errorf("Len after replace = %d, want 2", c.Len())
	}
	hits, _ := c.Query(Query{Vector: []float32{0, 0}, K: 2})
	if len(hits) != 2 || hits[0].ID != "b" || hits[1].ID != "a" || hits[1].Metadata["n"] != float64(2) {
		t.Errorf("after replace = %+v, want b then the new a", hits)
	}
	if hits[0].Distance != 10 || hits[1].Distance != 20 {
		t.Errorf("l2 distances = %v, %v; want 10, 20", hits[0].Distance, hits[1].Distance)
	}

	if !c.Delete("a") || c.Delete("a") {
		t.Error("Delete should succeed exactly once")
	}
	if _, err := c.Get("a"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get deleted = %v", err)
	}
	if ids := c.IDs(); len(ids) != 1 || ids[0] != "b" {
		t.Errorf("IDs = %v", ids)
	}
}

func TestUpsertValidatesWholeBatch(t *testing.T) {
	c := newColl(t, Config{Name: "t", Dim: 3})
	good := Item{ID: "ok", Vector: []float32{1, 2, 3}}
	cases := map[string]Item{
		"empty id":      {ID: "", Vector: []float32{1, 2, 3}},
		"long id":       {ID: string(make([]byte, MaxIDLen+1)), Vector: []float32{1, 2, 3}},
		"wrong dim":     {ID: "x", Vector: []float32{1, 2}},
		"zero (cosine)": {ID: "x", Vector: []float32{0, 0, 0}},
		"NaN":           {ID: "x", Vector: []float32{1, float32(math.NaN()), 3}},
		"bad metadata":  {ID: "x", Vector: []float32{1, 2, 3}, Metadata: map[string]any{"f": func() {}}},
		"huge metadata": {ID: "x", Vector: []float32{1, 2, 3}, Metadata: map[string]any{"s": string(make([]byte, MaxMetaSize))}},
	}
	for name, bad := range cases {
		n, err := c.Upsert([]Item{good, bad})
		if !errors.Is(err, ErrInvalid) || n != 0 {
			t.Errorf("%s: Upsert = %d, %v; want 0, ErrInvalid", name, n, err)
		}
		if c.Len() != 0 {
			t.Fatalf("%s: a rejected batch wrote %d items", name, c.Len())
		}
	}
	if err := c.validateVector([]float32{1, 2}); !errors.Is(err, vecmath.ErrDimensionMismatch) {
		t.Errorf("dimension errors should also wrap vecmath.ErrDimensionMismatch: %v", err)
	}
	// Repeated ids in one batch: the last one wins.
	_, _ = c.Upsert([]Item{{ID: "d", Vector: []float32{1, 0, 0}}, {ID: "d", Vector: []float32{0, 1, 0}}})
	got, _ := c.Get("d")
	if c.Len() != 1 || got.Vector[1] != 1 {
		t.Errorf("repeated id: len=%d vec=%v", c.Len(), got.Vector)
	}
}

func TestDeletedNeverReturnedAndCleanup(t *testing.T) {
	c, items := loaded(t, 1200)
	c.SetCleanupRatio(0) // manual cleanup only, so tombstones pile up
	deleted := map[string]bool{}
	for i := 0; i < len(items); i += 3 {
		c.Delete(items[i].ID)
		deleted[items[i].ID] = true
	}
	if info := c.Info(); info.Count != 800 || info.Tombstones != 400 {
		t.Fatalf("info = count %d, tombstones %d", info.Count, info.Tombstones)
	}
	check := func(stage string) {
		for _, it := range items[:100] {
			hits, err := c.Query(Query{Vector: it.Vector, K: 10})
			if err != nil {
				t.Fatal(err)
			}
			if len(hits) != 10 {
				t.Fatalf("%s: %d hits", stage, len(hits))
			}
			for _, h := range hits {
				if deleted[h.ID] {
					t.Fatalf("%s: deleted id %s returned", stage, h.ID)
				}
			}
		}
	}
	check("tombstoned")
	if n := c.Cleanup(); n != 400 {
		t.Errorf("Cleanup removed %d, want 400", n)
	}
	check("cleaned")
	if c.Info().Tombstones != 0 {
		t.Error("tombstones left after cleanup")
	}
}

func TestAutomaticCleanup(t *testing.T) {
	c, items := loaded(t, 400)
	// Default ratio 0.2: the cleanup fires on the delete that makes
	// tombstones reach 20% of the graph (80 of 400).
	for i := range 79 {
		c.Delete(items[i].ID)
	}
	if got := c.Info().Tombstones; got != 79 {
		t.Fatalf("tombstones = %d before threshold, want 79", got)
	}
	c.Delete(items[79].ID)
	if got := c.Info().Tombstones; got != 0 {
		t.Errorf("tombstones = %d after crossing 20%%, want 0", got)
	}
	// Upserting over existing ids also creates tombstones and triggers it.
	c2, items2 := loaded(t, 200)
	_, _ = c2.Upsert(items2[:50])
	if c2.Info().Tombstones != 0 || c2.Len() != 200 {
		t.Errorf("after re-upserting 50: tombstones %d len %d", c2.Info().Tombstones, c2.Len())
	}
}

// exactIndex is a flat index of just the items matching f: the ground
// truth for a filtered query.
func exactIndex(t *testing.T, items []Item, metas []map[string]any, f Filter) *flat.Index {
	t.Helper()
	fl, _ := flat.New(vecmath.MetricCosine, len(items[0].Vector))
	for i, it := range items {
		if f(metas[i]) {
			_ = fl.Add(uint32(i), it.Vector)
		}
	}
	return fl
}

func TestFilteredQuery(t *testing.T) {
	c, items := loaded(t, 2000)
	queries := docs(60, 16, 99)
	metas := make([]map[string]any, len(items))
	for i, it := range items {
		metas[i], _, _ = normalizeJSON(it.Metadata)
	}

	filters := []map[string]any{
		{"lang": "go"},                         // 25%
		{"lang": "rust", "year": 2016},         // 5%
		{"tags": "db"},                         // array contains, 33%
		{"year": map[string]any{"$gte": 2023}}, // 20%
		{"lang": map[string]any{"$in": []any{"go", "js"}}},
	}
	for _, spec := range filters {
		f, err := CompileFilter(spec)
		if err != nil {
			t.Fatal(err)
		}
		exact := exactIndex(t, items, metas, f)
		hit, total := 0, 0
		for _, q := range queries {
			hits, err := c.Query(Query{Vector: q.Vector, K: 10, Ef: 128, Filter: spec})
			if err != nil {
				t.Fatal(err)
			}
			if len(hits) != 10 {
				t.Fatalf("filter %v: %d hits, want k=10", spec, len(hits))
			}
			got := map[string]bool{}
			for _, h := range hits {
				if !f(h.Metadata) {
					t.Fatalf("filter %v returned non-matching %s %v", spec, h.ID, h.Metadata)
				}
				got[h.ID] = true
			}
			want, _ := exact.Search(q.Vector, 10)
			for _, r := range want {
				if got[items[r.ID].ID] {
					hit++
				}
			}
			total += 10
		}
		r := float64(hit) / float64(total)
		t.Logf("filter %v: recall@10 %.3f", spec, r)
		if r < 0.9 {
			t.Errorf("filter %v: recall@10 = %.3f, want >= 0.9", spec, r)
		}
	}

	// Fewer matches than k: return exactly the matches.
	_, _ = c.Upsert([]Item{{ID: "rare-1", Vector: items[0].Vector, Metadata: map[string]any{"lang": "zig"}},
		{ID: "rare-2", Vector: items[1].Vector, Metadata: map[string]any{"lang": "zig"}}})
	hits, _ := c.Query(Query{Vector: queries[0].Vector, K: 10, Filter: map[string]any{"lang": "zig"}})
	if len(hits) != 2 {
		t.Errorf("2 matching docs, got %d hits", len(hits))
	}
	hits, _ = c.Query(Query{Vector: queries[0].Vector, K: 10, Filter: map[string]any{"lang": "cobol"}})
	if len(hits) != 0 {
		t.Errorf("no matching docs, got %d hits", len(hits))
	}
}

func TestQueryValidation(t *testing.T) {
	c, _ := loaded(t, 50)
	v := make([]float32, 16)
	v[0] = 1
	bad := []Query{
		{Vector: v, K: 0},
		{Vector: v, K: MaxK + 1},
		{Vector: v, K: 5, Ef: -1},
		{Vector: v, K: 5, Ef: MaxEf + 1},
		{Vector: v[:3], K: 5},
		{Vector: make([]float32, 16), K: 5},
		{Vector: v, K: 5, Filter: map[string]any{"x": map[string]any{"$regex": "a"}}},
	}
	for _, q := range bad {
		if _, err := c.Query(q); !errors.Is(err, ErrInvalid) {
			t.Errorf("Query(k=%d ef=%d dim=%d filter=%v) err = %v, want ErrInvalid", q.K, q.Ef, len(q.Vector), q.Filter, err)
		}
	}
	info := c.Info()
	if info.Name != "docs" || info.Count != 50 || info.Graph.Live != 50 {
		t.Errorf("info = %+v", info)
	}
}
