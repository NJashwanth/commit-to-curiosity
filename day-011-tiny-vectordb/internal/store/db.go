package store

import (
	"fmt"
	"sort"
	"sync"
)

// DB is a set of named collections, safe for concurrent use. Its lock only
// guards the name -> collection map; each collection has its own lock, so
// a long upsert into one collection doesn't block queries on another.
type DB struct {
	mu          sync.RWMutex
	collections map[string]*Collection
}

// NewDB returns an empty database.
func NewDB() *DB {
	return &DB{collections: map[string]*Collection{}}
}

// Create adds a new, empty collection.
func (d *DB) Create(cfg Config) (*Collection, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.collections[cfg.Name]; ok {
		return nil, fmt.Errorf("collection %q: %w", cfg.Name, ErrExists)
	}
	c, err := NewCollection(cfg)
	if err != nil {
		return nil, err
	}
	d.collections[c.Name()] = c
	return c, nil
}

// Get returns a collection by name.
func (d *DB) Get(name string) (*Collection, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	c, ok := d.collections[name]
	if !ok {
		return nil, fmt.Errorf("collection %q: %w", name, ErrNotFound)
	}
	return c, nil
}

// List returns all collections sorted by name.
func (d *DB) List() []*Collection {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]*Collection, 0, len(d.collections))
	for _, c := range d.collections {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out
}

// Drop deletes a collection.
func (d *DB) Drop(name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.collections[name]; !ok {
		return fmt.Errorf("collection %q: %w", name, ErrNotFound)
	}
	delete(d.collections, name)
	return nil
}
