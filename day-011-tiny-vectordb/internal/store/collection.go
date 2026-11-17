// Package store turns an HNSW index into a collection of documents: string
// ids, JSON metadata, upserts, deletes and filtered queries.
package store

import (
	"errors"
	"fmt"
	"hash/fnv"
	"regexp"
	"sort"
	"sync"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/hnsw"
	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

var (
	// ErrNotFound is returned for unknown collections and ids.
	ErrNotFound = errors.New("not found")
	// ErrExists is returned when creating a collection that already exists.
	ErrExists = errors.New("already exists")
	// ErrInvalid wraps every validation error, so callers can map it to a
	// client error.
	ErrInvalid = errors.New("invalid")
)

// Limits that keep a single request from doing something silly.
const (
	MaxDim      = 4096
	MaxK        = 1000
	MaxEf       = 4096
	MaxIDLen    = 256
	MaxMetaSize = 64 << 10 // bytes of JSON per item
	maxM        = 128
)

// DefaultCleanupRatio triggers a cleanup once this fraction of the graph
// is tombstones.
const DefaultCleanupRatio = 0.2

// minCleanup is the fewest tombstones worth a cleanup pass.
const minCleanup = 32

var nameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// Config describes a collection. Zero values get defaults.
type Config struct {
	Name           string `json:"name"`
	Dim            int    `json:"dim"`
	Metric         string `json:"metric"`
	M              int    `json:"m"`
	EfConstruction int    `json:"ef_construction"`
	EfSearch       int    `json:"ef_search"`
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// normalize validates c, fills in defaults and returns the parsed metric.
func (c *Config) normalize() (vecmath.Metric, error) {
	if !nameRE.MatchString(c.Name) {
		return 0, invalid("collection name %q must be 1-64 letters, digits, '-' or '_', starting with a letter or digit", c.Name)
	}
	if c.Dim < 1 || c.Dim > MaxDim {
		return 0, invalid("dim must be in [1, %d], got %d", MaxDim, c.Dim)
	}
	if c.Metric == "" {
		c.Metric = "cosine"
	}
	m, err := vecmath.ParseMetric(c.Metric)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	c.Metric = m.String()
	if c.M == 0 {
		c.M = hnsw.DefaultM
	}
	if c.EfConstruction == 0 {
		c.EfConstruction = hnsw.DefaultEfConstruction
	}
	if c.EfSearch == 0 {
		c.EfSearch = hnsw.DefaultEfSearch
	}
	if c.M < 2 || c.M > maxM {
		return 0, invalid("m must be in [2, %d], got %d", maxM, c.M)
	}
	if c.EfConstruction < 1 || c.EfConstruction > MaxEf {
		return 0, invalid("ef_construction must be in [1, %d], got %d", MaxEf, c.EfConstruction)
	}
	if c.EfSearch < 1 || c.EfSearch > MaxEf {
		return 0, invalid("ef_search must be in [1, %d], got %d", MaxEf, c.EfSearch)
	}
	return m, nil
}

// seedFor derives the level-assignment seed from the collection name, so
// the same inserts into the same collection always build the same graph.
func seedFor(name string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(name))
	return h.Sum64()
}

// Item is one document: an id, its vector and optional metadata.
type Item struct {
	ID       string         `json:"id"`
	Vector   []float32      `json:"vector"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// Hit is one query result.
type Hit struct {
	ID       string         `json:"id"`
	Distance float32        `json:"distance"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// Query is a nearest-neighbour request. Ef 0 uses the collection default.
type Query struct {
	Vector []float32
	K      int
	Ef     int
	Filter map[string]any
}

// Collection is a named set of documents backed by one HNSW index.
//
// It is safe for concurrent use. Queries, gets and stats share a read lock
// and run in parallel; upserts, deletes and cleanups take the write lock,
// so writes are serialized and never interleave with a query. The lock
// also covers the id maps, so an upsert's tombstone-then-insert is atomic
// to readers.
//
// Metadata maps are never modified after they are stored (an upsert
// replaces the whole map), so they can be handed to readers without copying.
type Collection struct {
	mu           sync.RWMutex
	cfg          Config
	metric       vecmath.Metric
	index        *hnsw.Index
	byID         map[string]uint32 // live id -> node
	keys         []string          // node -> id ("" once deleted)
	meta         []map[string]any  // node -> metadata
	cleanupRatio float64
}

// NewCollection makes an empty collection.
func NewCollection(cfg Config) (*Collection, error) {
	metric, err := cfg.normalize()
	if err != nil {
		return nil, err
	}
	idx, err := hnsw.New(hnsw.Config{
		Dim:            cfg.Dim,
		Metric:         metric,
		M:              cfg.M,
		EfConstruction: cfg.EfConstruction,
		EfSearch:       cfg.EfSearch,
		Seed:           seedFor(cfg.Name),
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return &Collection{
		cfg:          cfg,
		metric:       metric,
		index:        idx,
		byID:         map[string]uint32{},
		cleanupRatio: DefaultCleanupRatio,
	}, nil
}

// Config returns the collection's configuration with defaults filled in.
func (c *Collection) Config() Config { return c.cfg }

// Name returns the collection name.
func (c *Collection) Name() string { return c.cfg.Name }

// Len returns the number of documents.
func (c *Collection) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.byID)
}

// SetCleanupRatio sets the tombstone fraction that triggers an automatic
// cleanup. Zero or less turns automatic cleanup off.
func (c *Collection) SetCleanupRatio(r float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cleanupRatio = r
}

// validateVector checks length, finiteness and, for cosine, direction.
func (c *Collection) validateVector(v []float32) error {
	if len(v) != c.cfg.Dim {
		return fmt.Errorf("%w: %w: collection is %d-d, vector is %d-d", ErrInvalid, vecmath.ErrDimensionMismatch, c.cfg.Dim, len(v))
	}
	if err := vecmath.CheckFinite(v); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if c.metric == vecmath.MetricCosine && vecmath.Norm(v) == 0 {
		return fmt.Errorf("%w: %w (cosine needs a direction)", ErrInvalid, vecmath.ErrZeroVector)
	}
	return nil
}

func validateMeta(m map[string]any) (map[string]any, error) {
	if len(m) == 0 {
		return nil, nil
	}
	norm, size, err := normalizeJSON(m)
	if err != nil {
		return nil, invalid("metadata is not valid JSON: %v", err)
	}
	if size > MaxMetaSize {
		return nil, invalid("metadata is %d bytes, max %d", size, MaxMetaSize)
	}
	return norm, nil
}

// Upsert inserts or replaces documents and returns how many it wrote. The
// whole batch is validated first: if any item is invalid, nothing is
// written. An existing id is replaced by tombstoning its old node and
// inserting a new one. Within a batch, a repeated id keeps the last copy.
func (c *Collection) Upsert(items []Item) (int, error) {
	metas := make([]map[string]any, len(items))
	for i, it := range items {
		if it.ID == "" || len(it.ID) > MaxIDLen {
			return 0, invalid("item %d: id must be 1-%d bytes", i, MaxIDLen)
		}
		if err := c.validateVector(it.Vector); err != nil {
			return 0, fmt.Errorf("item %d (%q): %w", i, it.ID, err)
		}
		m, err := validateMeta(it.Metadata)
		if err != nil {
			return 0, fmt.Errorf("item %d (%q): %w", i, it.ID, err)
		}
		metas[i] = m
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for i, it := range items {
		if old, ok := c.byID[it.ID]; ok {
			c.removeNode(old)
		}
		node, err := c.index.Insert(it.Vector)
		if err != nil { // unreachable after validation, but don't hide it
			return i, err
		}
		for int(node) >= len(c.keys) {
			c.keys = append(c.keys, "")
			c.meta = append(c.meta, nil)
		}
		c.keys[node] = it.ID
		c.meta[node] = metas[i]
		c.byID[it.ID] = node
	}
	c.maybeCleanup()
	return len(items), nil
}

func (c *Collection) removeNode(node uint32) {
	c.index.Delete(node)
	delete(c.byID, c.keys[node])
	c.keys[node] = ""
	c.meta[node] = nil
}

// Get returns a document by id. For cosine collections the vector comes
// back normalized, because that is what the index stores.
func (c *Collection) Get(id string) (Item, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	node, ok := c.byID[id]
	if !ok {
		return Item{}, fmt.Errorf("id %q: %w", id, ErrNotFound)
	}
	vec, _ := c.index.Vector(node)
	return Item{ID: id, Vector: vec, Metadata: c.meta[node]}, nil
}

// Delete removes a document, reporting whether it existed. The graph node
// becomes a tombstone until the next cleanup.
func (c *Collection) Delete(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	node, ok := c.byID[id]
	if !ok {
		return false
	}
	c.removeNode(node)
	c.maybeCleanup()
	return true
}

// maybeCleanup runs a cleanup once tombstones pass the configured ratio.
func (c *Collection) maybeCleanup() {
	tombs := c.index.Tombstones()
	if c.cleanupRatio <= 0 || tombs < minCleanup {
		return
	}
	if float64(tombs) >= c.cleanupRatio*float64(tombs+c.index.Len()) {
		c.index.Cleanup()
	}
}

// Cleanup removes all tombstones from the graph now and returns how many.
func (c *Collection) Cleanup() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.index.Cleanup()
}

// Query returns the k nearest documents that match the filter, closest
// first.
func (c *Collection) Query(q Query) ([]Hit, error) {
	if q.K < 1 || q.K > MaxK {
		return nil, invalid("k must be in [1, %d], got %d", MaxK, q.K)
	}
	if q.Ef < 0 || q.Ef > MaxEf {
		return nil, invalid("ef must be in [0, %d], got %d", MaxEf, q.Ef)
	}
	if err := c.validateVector(q.Vector); err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	filter, err := CompileFilter(q.Filter)
	if err != nil {
		return nil, err
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	var accept func(uint32) bool
	if filter != nil {
		accept = func(node uint32) bool { return filter(c.meta[node]) }
	}
	res, err := c.index.SearchFilter(q.Vector, q.K, q.Ef, accept)
	if err != nil {
		return nil, err
	}
	hits := make([]Hit, len(res))
	for i, r := range res {
		hits[i] = Hit{ID: c.keys[r.ID], Distance: r.Distance, Metadata: c.meta[r.ID]}
	}
	return hits, nil
}

// Info is a summary of a collection for listings and /stats.
type Info struct {
	Config
	Count      int        `json:"count"`
	Tombstones int        `json:"tombstones"`
	Graph      hnsw.Stats `json:"graph"`
}

// Info returns the collection's config, size and graph shape.
func (c *Collection) Info() Info {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Info{
		Config:     c.cfg,
		Count:      len(c.byID),
		Tombstones: c.index.Tombstones(),
		Graph:      c.index.Stats(),
	}
}

// IDs returns every document id, sorted.
func (c *Collection) IDs() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	ids := make([]string, 0, len(c.byID))
	for id := range c.byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
