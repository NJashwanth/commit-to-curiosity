// Package btree implements a B+tree keyed by int64 on top of the pager.
// Rows live only in leaf nodes; leaves are linked for range scans.
//
// Inserts split full nodes bottom-up. The root page id never changes: when
// the root splits, its contents move to a fresh page and the root becomes a
// new internal node. Deletes do not rebalance: leaves may become underfull or
// empty (scans skip empty leaves) and all pages are reclaimed by Destroy.
package btree

import (
	"errors"
	"fmt"
	"io"
	"math"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

var (
	ErrDuplicate = errors.New("duplicate key")
	ErrNotFound  = errors.New("key not found")
	ErrTooLarge  = errors.New("row too large")
	ErrCorrupt   = errors.New("b+tree page is corrupt")
)

// Config lets tests shrink nodes so deep trees form quickly. Zero values mean
// "limited only by the 4096-byte page".
type Config struct {
	MaxLeafCells    int
	MaxInternalKeys int
}

// Tree is a handle on one B+tree.
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

func (t *Tree) internalFits(in *internal) bool {
	max := internalCapacity
	if t.cfg.MaxInternalKeys > 0 && t.cfg.MaxInternalKeys < max {
		max = t.cfg.MaxInternalKeys
	}
	return len(in.keys) <= max
}

func (t *Tree) readLeaf(id uint32) (*leaf, error) {
	buf, err := t.p.Get(id)
	if err != nil {
		return nil, err
	}
	return readLeaf(buf)
}

func (t *Tree) readInternal(id uint32) (*internal, error) {
	buf, err := t.p.Get(id)
	if err != nil {
		return nil, err
	}
	return readInternal(buf)
}

func (t *Tree) writeLeaf(id uint32, l *leaf) error {
	buf, err := t.p.Write(id)
	if err != nil {
		return err
	}
	l.write(buf)
	return nil
}

func (t *Tree) writeInternal(id uint32, in *internal) error {
	buf, err := t.p.Write(id)
	if err != nil {
		return err
	}
	in.write(buf)
	return nil
}

// findLeaf descends to the leaf that would hold key.
func (t *Tree) findLeaf(key int64) (uint32, error) {
	id := t.root
	for {
		buf, err := t.p.Get(id)
		if err != nil {
			return 0, err
		}
		switch buf[0] {
		case typeLeaf:
			return id, nil
		case typeInternal:
			in, err := readInternal(buf)
			if err != nil {
				return 0, err
			}
			id = in.children[in.childIndex(key)]
		default:
			return 0, fmt.Errorf("%w: page %d has type %d", ErrCorrupt, id, buf[0])
		}
	}
}

type split struct {
	sep   int64  // smallest key reachable through right
	right uint32 // new right sibling
}

// Insert adds a new key. It fails with ErrDuplicate if the key exists.
func (t *Tree) Insert(key int64, val []byte) error {
	if len(val) > MaxPayload {
		return fmt.Errorf("%w: %d bytes (max %d)", ErrTooLarge, len(val), MaxPayload)
	}
	sp, err := t.insert(t.root, key, append([]byte(nil), val...))
	if err != nil || sp == nil {
		return err
	}
	return t.growRoot(sp)
}

func (t *Tree) insert(id uint32, key int64, val []byte) (*split, error) {
	buf, err := t.p.Get(id)
	if err != nil {
		return nil, err
	}
	switch buf[0] {
	case typeLeaf:
		l, err := readLeaf(buf)
		if err != nil {
			return nil, err
		}
		i, found := l.search(key)
		if found {
			return nil, fmt.Errorf("%w: %d", ErrDuplicate, key)
		}
		l.insertAt(i, key, val)
		if t.leafFits(l) {
			return nil, t.writeLeaf(id, l)
		}
		return t.splitLeaf(id, l, i)
	case typeInternal:
		in, err := readInternal(buf)
		if err != nil {
			return nil, err
		}
		ci := in.childIndex(key)
		sp, err := t.insert(in.children[ci], key, val)
		if err != nil || sp == nil {
			return nil, err
		}
		in.insertChild(ci, sp.sep, sp.right)
		if t.internalFits(in) {
			return nil, t.writeInternal(id, in)
		}
		return t.splitInternal(id, in)
	}
	return nil, fmt.Errorf("%w: page %d has type %d", ErrCorrupt, id, buf[0])
}

// splitLeaf divides an overfull leaf. inserted is the index of the new cell.
func (t *Tree) splitLeaf(id uint32, l *leaf, inserted int) (*split, error) {
	n := len(l.keys)
	k := 0
	if l.next == 0 && inserted == n-1 {
		// Appending to the rightmost leaf (sequential keys): keep the old
		// leaf full instead of leaving it half empty.
		k = n - 1
	} else {
		total, acc := l.size(), 0
		for k = 0; k < n && acc*2 < total; k++ {
			acc += leafCellHead + len(l.vals[k])
		}
		if k < 1 {
			k = 1
		}
		if k > n-1 {
			k = n - 1
		}
	}
	rid, rbuf, err := t.p.Allocate()
	if err != nil {
		return nil, err
	}
	right := &leaf{keys: append([]int64(nil), l.keys[k:]...), vals: append([][]byte(nil), l.vals[k:]...), next: l.next}
	left := &leaf{keys: l.keys[:k], vals: l.vals[:k], next: rid}
	right.write(rbuf)
	if err := t.writeLeaf(id, left); err != nil {
		return nil, err
	}
	return &split{sep: right.keys[0], right: rid}, nil
}

// splitInternal divides an overfull internal node; the middle key moves up.
func (t *Tree) splitInternal(id uint32, in *internal) (*split, error) {
	m := len(in.keys) / 2
	up := in.keys[m]
	right := &internal{
		keys:     append([]int64(nil), in.keys[m+1:]...),
		children: append([]uint32(nil), in.children[m+1:]...),
	}
	left := &internal{keys: in.keys[:m], children: in.children[:m+1]}
	rid, rbuf, err := t.p.Allocate()
	if err != nil {
		return nil, err
	}
	right.write(rbuf)
	if err := t.writeInternal(id, left); err != nil {
		return nil, err
	}
	return &split{sep: up, right: rid}, nil
}

// growRoot handles a root split while keeping the root page id stable.
func (t *Tree) growRoot(sp *split) error {
	old, err := t.p.Get(t.root)
	if err != nil {
		return err
	}
	lid, lbuf, err := t.p.Allocate()
	if err != nil {
		return err
	}
	copy(lbuf, old)
	return t.writeInternal(t.root, &internal{keys: []int64{sp.sep}, children: []uint32{lid, sp.right}})
}

// Get returns a copy of the value stored under key.
func (t *Tree) Get(key int64) ([]byte, error) {
	id, err := t.findLeaf(key)
	if err != nil {
		return nil, err
	}
	l, err := t.readLeaf(id)
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
	id, err := t.findLeaf(key)
	if err != nil {
		return err
	}
	l, err := t.readLeaf(id)
	if err != nil {
		return err
	}
	i, found := l.search(key)
	if !found {
		return fmt.Errorf("%w: %d", ErrNotFound, key)
	}
	l.removeAt(i)
	return t.writeLeaf(id, l)
}

// Update replaces the value of an existing key, splitting the leaf if the
// new value no longer fits.
func (t *Tree) Update(key int64, val []byte) error {
	if len(val) > MaxPayload {
		return fmt.Errorf("%w: %d bytes (max %d)", ErrTooLarge, len(val), MaxPayload)
	}
	id, err := t.findLeaf(key)
	if err != nil {
		return err
	}
	l, err := t.readLeaf(id)
	if err != nil {
		return err
	}
	i, found := l.search(key)
	if !found {
		return fmt.Errorf("%w: %d", ErrNotFound, key)
	}
	old := l.vals[i]
	l.vals[i] = append([]byte(nil), val...)
	if t.leafFits(l) {
		return t.writeLeaf(id, l)
	}
	l.vals[i] = old
	if err := t.Delete(key); err != nil {
		return err
	}
	return t.Insert(key, val)
}

// Scan calls fn for every key in [lo, hi] in ascending order until fn returns
// false. It descends once to the leaf holding lo, then follows sibling
// pointers. The value slice is only valid during the callback; the tree must
// not be modified from inside fn.
func (t *Tree) Scan(lo, hi int64, fn func(key int64, val []byte) bool) error {
	if lo > hi {
		return nil
	}
	id, err := t.findLeaf(lo)
	if err != nil {
		return err
	}
	for id != 0 {
		l, err := t.readLeaf(id)
		if err != nil {
			return err
		}
		start, _ := l.search(lo)
		for i := start; i < len(l.keys); i++ {
			if l.keys[i] > hi || !fn(l.keys[i], l.vals[i]) {
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

// Max returns the largest key, or false if the tree is empty.
func (t *Tree) Max() (int64, bool, error) { return t.maxIn(t.root) }

func (t *Tree) maxIn(id uint32) (int64, bool, error) {
	buf, err := t.p.Get(id)
	if err != nil {
		return 0, false, err
	}
	if buf[0] == typeLeaf {
		l, err := readLeaf(buf)
		if err != nil || len(l.keys) == 0 {
			return 0, false, err
		}
		return l.keys[len(l.keys)-1], true, nil
	}
	in, err := readInternal(buf)
	if err != nil {
		return 0, false, err
	}
	for i := len(in.children) - 1; i >= 0; i-- { // deletes can leave empty leaves
		if k, ok, err := t.maxIn(in.children[i]); err != nil || ok {
			return k, ok, err
		}
	}
	return 0, false, nil
}

// Destroy returns every page of the tree, root included, to the free list.
func (t *Tree) Destroy() error { return t.destroy(t.root) }

func (t *Tree) destroy(id uint32) error {
	buf, err := t.p.Get(id)
	if err != nil {
		return err
	}
	if buf[0] == typeInternal {
		in, err := readInternal(buf)
		if err != nil {
			return err
		}
		for _, c := range in.children {
			if err := t.destroy(c); err != nil {
				return err
			}
		}
	}
	return t.p.Free(id)
}

// Stats summarises the shape of a tree.
type Stats struct {
	Height    int // 1 = a single leaf
	Leaves    int
	Internals int
	Keys      int
}

// Check verifies the tree's invariants and returns its shape:
// keys sorted and within the bounds set by ancestors, all leaves at the same
// depth, every page reachable exactly once, and the sibling chain visiting the
// leaves in key order.
func (t *Tree) Check() (Stats, error) {
	c := &checker{t: t, seen: map[uint32]bool{}, leafDepth: -1}
	if err := c.walk(t.root, nil, nil, 1); err != nil {
		return Stats{}, err
	}
	for i, id := range c.leaves {
		l, err := t.readLeaf(id)
		if err != nil {
			return Stats{}, err
		}
		want := uint32(0)
		if i+1 < len(c.leaves) {
			want = c.leaves[i+1]
		}
		if l.next != want {
			return Stats{}, fmt.Errorf("%w: leaf %d links to %d, expected %d", ErrCorrupt, id, l.next, want)
		}
	}
	return Stats{Height: c.leafDepth, Leaves: len(c.leaves), Internals: c.internals, Keys: c.keys}, nil
}

type checker struct {
	t         *Tree
	seen      map[uint32]bool
	leaves    []uint32 // in left-to-right order
	internals int
	keys      int
	leafDepth int
}

func (c *checker) walk(id uint32, lo, hi *int64, depth int) error {
	if c.seen[id] {
		return fmt.Errorf("%w: page %d is referenced twice", ErrCorrupt, id)
	}
	c.seen[id] = true
	buf, err := c.t.p.Get(id)
	if err != nil {
		return err
	}
	inRange := func(k int64) error {
		if (lo != nil && k < *lo) || (hi != nil && k >= *hi) {
			return fmt.Errorf("%w: key %d on page %d outside its parent's range", ErrCorrupt, k, id)
		}
		return nil
	}
	switch buf[0] {
	case typeLeaf:
		l, err := readLeaf(buf)
		if err != nil {
			return err
		}
		if c.leafDepth == -1 {
			c.leafDepth = depth
		} else if c.leafDepth != depth {
			return fmt.Errorf("%w: leaf %d at depth %d, others at %d", ErrCorrupt, id, depth, c.leafDepth)
		}
		for i, k := range l.keys {
			if i > 0 && l.keys[i-1] >= k {
				return fmt.Errorf("%w: leaf %d keys out of order at %d", ErrCorrupt, id, i)
			}
			if err := inRange(k); err != nil {
				return err
			}
		}
		if l.size() > leafCapacity {
			return fmt.Errorf("%w: leaf %d overflows its page", ErrCorrupt, id)
		}
		c.leaves = append(c.leaves, id)
		c.keys += len(l.keys)
	case typeInternal:
		in, err := readInternal(buf)
		if err != nil {
			return err
		}
		if len(in.keys) == 0 {
			return fmt.Errorf("%w: internal node %d has no keys", ErrCorrupt, id)
		}
		if len(in.keys) > internalCapacity {
			return fmt.Errorf("%w: internal node %d overflows its page", ErrCorrupt, id)
		}
		c.internals++
		for i, k := range in.keys {
			if i > 0 && in.keys[i-1] >= k {
				return fmt.Errorf("%w: internal %d keys out of order at %d", ErrCorrupt, id, i)
			}
			if err := inRange(k); err != nil {
				return err
			}
		}
		for i, child := range in.children {
			clo, chi := lo, hi
			if i > 0 {
				clo = &in.keys[i-1]
			}
			if i < len(in.keys) {
				chi = &in.keys[i]
			}
			if err := c.walk(child, clo, chi, depth+1); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("%w: page %d has type %d", ErrCorrupt, id, buf[0])
	}
	return nil
}

// Dump prints the tree structure. When a node has more than maxChildren
// children (maxChildren > 0) the middle ones are elided.
func (t *Tree) Dump(w io.Writer, maxChildren int) error {
	return t.dump(w, t.root, 0, maxChildren)
}

func (t *Tree) dump(w io.Writer, id uint32, depth, maxChildren int) error {
	pad := make([]byte, depth*2)
	for i := range pad {
		pad[i] = ' '
	}
	buf, err := t.p.Get(id)
	if err != nil {
		return err
	}
	if buf[0] == typeLeaf {
		l, err := readLeaf(buf)
		if err != nil {
			return err
		}
		next := "end"
		if l.next != 0 {
			next = fmt.Sprintf("#%d", l.next)
		}
		if len(l.keys) == 0 {
			_, err = fmt.Fprintf(w, "%s[leaf #%d] (empty) -> %s\n", pad, id, next)
			return err
		}
		_, err = fmt.Fprintf(w, "%s[leaf #%d] keys %d..%d (%d rows) -> %s\n", pad, id, l.keys[0], l.keys[len(l.keys)-1], len(l.keys), next)
		return err
	}
	in, err := readInternal(buf)
	if err != nil {
		return err
	}
	keys := fmt.Sprint(in.keys)
	if len(in.keys) > 8 {
		keys = fmt.Sprintf("[%d %d %d ... %d %d] (%d keys)", in.keys[0], in.keys[1], in.keys[2], in.keys[len(in.keys)-2], in.keys[len(in.keys)-1], len(in.keys))
	}
	if _, err := fmt.Fprintf(w, "%s[internal #%d] separators %s\n", pad, id, keys); err != nil {
		return err
	}
	n := len(in.children)
	for i, c := range in.children {
		if maxChildren > 0 && n > maxChildren && i >= maxChildren-2 && i < n-2 {
			if i == maxChildren-2 {
				if _, err := fmt.Fprintf(w, "%s  ... %d more children ...\n", pad, n-maxChildren); err != nil {
					return err
				}
			}
			continue
		}
		if err := t.dump(w, c, depth+1, maxChildren); err != nil {
			return err
		}
	}
	return nil
}
