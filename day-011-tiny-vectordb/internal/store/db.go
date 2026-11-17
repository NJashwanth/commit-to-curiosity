package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// DB is a set of named collections, safe for concurrent use. Its lock only
// guards the name -> collection map; each collection has its own lock, so
// a long upsert into one collection doesn't block queries on another.
//
// A DB opened with a directory keeps one snapshot file per collection
// there (<name>.tvdb). Writes go to memory; SaveDirty, Maintain or Save
// write them to disk.
type DB struct {
	mu          sync.RWMutex
	dir         string // "" = memory only
	collections map[string]*Collection
}

// NewDB returns an empty, memory-only database.
func NewDB() *DB {
	return &DB{collections: map[string]*Collection{}}
}

// Open loads every snapshot in dir, creating dir if needed. A corrupt or
// unreadable snapshot is an error rather than being skipped, so data never
// silently disappears.
func Open(dir string) (*DB, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*"+FileExt))
	if err != nil {
		return nil, err
	}
	db := &DB{dir: dir, collections: map[string]*Collection{}}
	for _, p := range paths {
		c, err := LoadFile(p)
		if err != nil {
			return nil, err
		}
		if want := strings.TrimSuffix(filepath.Base(p), FileExt); c.Name() != want {
			return nil, fmt.Errorf("load %s: %w: file holds collection %q", p, ErrCorrupt, c.Name())
		}
		c.markSaved(c.version)
		db.collections[c.Name()] = c
	}
	return db, nil
}

// Dir returns the data directory, or "" for a memory-only DB.
func (d *DB) Dir() string { return d.dir }

func (d *DB) path(name string) string { return filepath.Join(d.dir, name+FileExt) }

// Create adds a new, empty collection, writing its snapshot right away
// when the DB has a directory.
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
	if d.dir != "" {
		if err := c.SaveFile(d.path(c.Name())); err != nil {
			return nil, err
		}
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

// Drop deletes a collection and its snapshot file.
func (d *DB) Drop(name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.collections[name]; !ok {
		return fmt.Errorf("collection %q: %w", name, ErrNotFound)
	}
	if d.dir != "" {
		if err := os.Remove(d.path(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	delete(d.collections, name)
	return nil
}

// Save writes one collection's snapshot now, dirty or not.
func (d *DB) Save(name string) error {
	// Hold the read lock so a concurrent Drop can't delete the file and
	// then have this save bring it back.
	d.mu.RLock()
	defer d.mu.RUnlock()
	c, ok := d.collections[name]
	if !ok {
		return fmt.Errorf("collection %q: %w", name, ErrNotFound)
	}
	if d.dir == "" {
		return nil
	}
	return c.SaveFile(d.path(name))
}

// SaveDirty snapshots every collection that changed since its last save
// and returns how many it wrote.
func (d *DB) SaveDirty() (int, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.dir == "" {
		return 0, nil
	}
	saved := 0
	var errs []error
	for name, c := range d.collections {
		if !c.Dirty() {
			continue
		}
		if err := c.SaveFile(d.path(name)); err != nil {
			errs = append(errs, fmt.Errorf("save %s: %w", name, err))
			continue
		}
		saved++
	}
	return saved, errors.Join(errs...)
}

// CleanupAll removes tombstones from every collection that has any and
// returns the total removed.
func (d *DB) CleanupAll() int {
	removed := 0
	for _, c := range d.List() {
		if c.Info().Tombstones > 0 {
			removed += c.Cleanup()
		}
	}
	return removed
}

// Maintain runs periodic upkeep until ctx is cancelled: every interval it
// cleans up tombstones and snapshots dirty collections. Errors go to
// logf (which may be nil).
func (d *DB) Maintain(ctx context.Context, interval time.Duration, logf func(format string, args ...any)) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.CleanupAll()
			if _, err := d.SaveDirty(); err != nil && logf != nil {
				logf("snapshot: %v", err)
			}
		}
	}
}
