package btree

import (
	"encoding/binary"
	"fmt"
	"sort"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

// Node page layout (little endian):
//
//	byte 0      node type (1 = leaf, 2 = internal)
//	bytes 1-2   number of keys
//	bytes 4-7   leaf: next leaf page (0 = none); internal: rightmost child
//	bytes 16..  cells
//
// A leaf cell is  key i64 | payload length u16 | payload.
const (
	typeLeaf     = 1
	typeInternal = 2

	headerSize   = 16
	leafCellHead = 10 // key + length
	leafCapacity = pager.PageSize - headerSize

	// MaxPayload is the largest row (in encoded bytes) a leaf cell can hold.
	// Capping at a third of a page guarantees any overfull leaf splits into
	// two leaves that both fit.
	MaxPayload = 1000
)

type leaf struct {
	keys []int64
	vals [][]byte
	next uint32
}

func nodeType(buf []byte) byte { return buf[0] }

func readLeaf(buf []byte) (*leaf, error) {
	if buf[0] != typeLeaf {
		return nil, fmt.Errorf("%w: expected leaf, page has type %d", ErrCorrupt, buf[0])
	}
	n := int(binary.LittleEndian.Uint16(buf[1:]))
	l := &leaf{next: binary.LittleEndian.Uint32(buf[4:]), keys: make([]int64, n), vals: make([][]byte, n)}
	pos := headerSize
	for i := 0; i < n; i++ {
		if pos+leafCellHead > len(buf) {
			return nil, fmt.Errorf("%w: leaf cell %d past end of page", ErrCorrupt, i)
		}
		l.keys[i] = int64(binary.LittleEndian.Uint64(buf[pos:]))
		sz := int(binary.LittleEndian.Uint16(buf[pos+8:]))
		pos += leafCellHead
		if pos+sz > len(buf) {
			return nil, fmt.Errorf("%w: leaf payload %d past end of page", ErrCorrupt, i)
		}
		l.vals[i] = buf[pos : pos+sz : pos+sz]
		pos += sz
	}
	return l, nil
}

// size is the number of bytes the cells occupy.
func (l *leaf) size() int {
	n := 0
	for _, v := range l.vals {
		n += leafCellHead + len(v)
	}
	return n
}

// write encodes the leaf into buf. Values may alias buf, so it encodes to a
// scratch page first.
func (l *leaf) write(buf []byte) {
	tmp := make([]byte, pager.PageSize)
	tmp[0] = typeLeaf
	binary.LittleEndian.PutUint16(tmp[1:], uint16(len(l.keys)))
	binary.LittleEndian.PutUint32(tmp[4:], l.next)
	pos := headerSize
	for i, k := range l.keys {
		binary.LittleEndian.PutUint64(tmp[pos:], uint64(k))
		binary.LittleEndian.PutUint16(tmp[pos+8:], uint16(len(l.vals[i])))
		pos += leafCellHead
		pos += copy(tmp[pos:], l.vals[i])
	}
	copy(buf, tmp)
}

// search returns the index of key, or where it would be inserted.
func (l *leaf) search(key int64) (int, bool) {
	i := sort.Search(len(l.keys), func(i int) bool { return l.keys[i] >= key })
	return i, i < len(l.keys) && l.keys[i] == key
}

func (l *leaf) insertAt(i int, key int64, val []byte) {
	l.keys = append(l.keys, 0)
	copy(l.keys[i+1:], l.keys[i:])
	l.keys[i] = key
	l.vals = append(l.vals, nil)
	copy(l.vals[i+1:], l.vals[i:])
	l.vals[i] = val
}

func (l *leaf) removeAt(i int) {
	l.keys = append(l.keys[:i], l.keys[i+1:]...)
	l.vals = append(l.vals[:i], l.vals[i+1:]...)
}
