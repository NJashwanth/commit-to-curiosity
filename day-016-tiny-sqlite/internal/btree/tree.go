// Package btree implements a B+tree keyed by int64 on top of the pager.
// Rows live only in leaf nodes; leaves are linked for range scans.
package btree

import (
	"errors"
	"fmt"
	"math"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

var (
	ErrDuplicate = errors.New("duplicate key")
	ErrNotFound  = errors.New("key not found")
	ErrTooLarge  = errors.New("row too large")
	ErrCorrupt   = errors.New("b+tree page is corrupt")
	ErrNodeFull  = errors.New("leaf node is full")
)

// Config lets tests shrink nodes so deep trees form quickly. Zero values mean
// "limited only by the 4096-byte page".
type Config struct {
	MaxLeafCells int
}

// Tree is a handle on one B+tree. The root page never changes.
type Tree struct {
	p    *pager.Pager
	root uint32
	cfg  Config
}

// Create allocates an empty tree (a single empty leaf).
func Create(p *pager.Pager, cfg Config) (*Tree, error) {
	id, buf, err := p.Allocate()
	if err != nil {
		return nil, err
	}
	(&leaf{}).write(buf)
	return &Tree{p: p, root: id, cfg: cfg}, nil
}

// Open attaches to an existing tree.
func Open(p *pager.Pager, root uint32, cfg Config) *Tree {
	return &Tree{p: p, root: root, cfg: cfg}
}

// Root returns the root page id.
func (t *Tree) Root() uint32 { return t.root }

func (t *Tree) leafFits(l *leaf) bool {
	if t.cfg.MaxLeafCells > 0 && len(l.keys) > t.cfg.MaxLeafCells {
		return false
	}
	return l.size() <= leafCapacity
}

func (t *Tree) readLeaf(id uint32) (*leaf, error) {
	buf, err := t.p.Get(id)
	if err != nil {
		return nil, err
	}
	return readLeaf(buf)
}

func (t *Tree) writeLeaf(id uint32, l *leaf) error {
	buf, err := t.p.Write(id)
	if err != nil {
		return err
	}
	l.write(buf)
	return nil
}

// Insert adds a new key. It fails with ErrDuplicate if the key exists.
func (t *Tree) Insert(key int64, val []byte) error {
	if len(val) > MaxPayload {
		return fmt.Errorf("%w: %d bytes (max %d)", ErrTooLarge, len(val), MaxPayload)
	}
	l, err := t.readLeaf(t.root)
	if err != nil {
		return err
	}
	i, found := l.search(key)
	if found {
		return fmt.Errorf("%w: %d", ErrDuplicate, key)
	}
	l.insertAt(i, key, append([]byte(nil), val...))
	if !t.leafFits(l) {
		return ErrNodeFull
	}
	return t.writeLeaf(t.root, l)
}

// Get returns a copy of the value stored under key.
func (t *Tree) Get(key int64) ([]byte, error) {
	l, err := t.readLeaf(t.root)
	if err != nil {
		return nil, err
	}
	i, found := l.search(key)
	if !found {
		return nil, fmt.Errorf("%w: %d", ErrNotFound, key)
	}
	return append([]byte(nil), l.vals[i]...), nil
}

// Delete removes key.
func (t *Tree) Delete(key int64) error {
	l, err := t.readLeaf(t.root)
	if err != nil {
		return err
	}
	i, found := l.search(key)
	if !found {
		return fmt.Errorf("%w: %d", ErrNotFound, key)
	}
	l.removeAt(i)
	return t.writeLeaf(t.root, l)
}

// Update replaces the value of an existing key.
func (t *Tree) Update(key int64, val []byte) error {
	if len(val) > MaxPayload {
		return fmt.Errorf("%w: %d bytes (max %d)", ErrTooLarge, len(val), MaxPayload)
	}
	l, err := t.readLeaf(t.root)
	if err != nil {
		return err
	}
	i, found := l.search(key)
	if !found {
		return fmt.Errorf("%w: %d", ErrNotFound, key)
	}
	l.vals[i] = append([]byte(nil), val...)
	if !t.leafFits(l) {
		return ErrNodeFull
	}
	return t.writeLeaf(t.root, l)
}

// Scan calls fn for every key in [lo, hi] in ascending order until fn returns
// false. The value slice is only valid during the callback and must not be
// retained; the tree must not be modified from inside fn.
func (t *Tree) Scan(lo, hi int64, fn func(key int64, val []byte) bool) error {
	if lo > hi {
		return nil
	}
	id := t.root
	for id != 0 {
		l, err := t.readLeaf(id)
		if err != nil {
			return err
		}
		start, _ := l.search(lo)
		for i := start; i < len(l.keys); i++ {
			if l.keys[i] > hi {
				return nil
			}
			if !fn(l.keys[i], l.vals[i]) {
				return nil
			}
		}
		id = l.next
		lo = math.MinInt64
	}
	return nil
}

// All scans the whole tree in key order.
func (t *Tree) All(fn func(key int64, val []byte) bool) error {
	return t.Scan(math.MinInt64, math.MaxInt64, fn)
}

// Count returns the number of keys.
func (t *Tree) Count() (int, error) {
	n := 0
	err := t.All(func(int64, []byte) bool { n++; return true })
	return n, err
}

// Check verifies the tree's structural invariants.
func (t *Tree) Check() error {
	l, err := t.readLeaf(t.root)
	if err != nil {
		return err
	}
	for i := 1; i < len(l.keys); i++ {
		if l.keys[i-1] >= l.keys[i] {
			return fmt.Errorf("%w: leaf keys out of order at %d", ErrCorrupt, i)
		}
	}
	if l.size() > leafCapacity {
		return fmt.Errorf("%w: leaf overflows its page", ErrCorrupt)
	}
	return nil
}
