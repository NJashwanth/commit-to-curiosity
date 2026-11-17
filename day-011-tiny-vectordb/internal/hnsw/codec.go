package hnsw

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// ErrCorrupt is returned when encoded graph data is malformed.
var ErrCorrupt = errors.New("hnsw: corrupt graph data")

// Node slot states in the encoding.
const (
	slotFree    = 0
	slotLive    = 1
	slotDeleted = 2
)

// MarshalBinary encodes the whole graph:
//
//	u8      metric
//	uvarint dim, M, efConstruction, efSearch
//	u64     seed
//	u8      flags (1 = simple selection, 2 = keep pruned)
//	bytes   RNG state, so inserts after a reload match an index that never stopped
//	uvarint slots, entry+1 (0 = empty), top layer
//	per slot:
//	  u8 state (0 free, 1 live, 2 deleted); then, unless free:
//	  uvarint level, dim × float32 (little endian),
//	  per layer 0..level: uvarint count, count × uvarint neighbor id
//
// Neighbor ids are varints, so most cost 2-3 bytes instead of 4.
func (h *Index) MarshalBinary() ([]byte, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	rngState, err := h.pcg.MarshalBinary()
	if err != nil {
		return nil, err
	}
	c := h.cfg
	b := make([]byte, 0, 64+len(h.nodes)*(c.Dim*4+c.M*3+8))
	b = append(b, byte(c.Metric))
	b = binary.AppendUvarint(b, uint64(c.Dim))
	b = binary.AppendUvarint(b, uint64(c.M))
	b = binary.AppendUvarint(b, uint64(c.EfConstruction))
	b = binary.AppendUvarint(b, uint64(c.EfSearch))
	b = binary.LittleEndian.AppendUint64(b, c.Seed)
	var flags byte
	if c.SimpleSelection {
		flags |= 1
	}
	if c.KeepPrunedConnections {
		flags |= 2
	}
	b = append(b, flags)
	b = binary.AppendUvarint(b, uint64(len(rngState)))
	b = append(b, rngState...)

	b = binary.AppendUvarint(b, uint64(len(h.nodes)))
	entry := uint64(0)
	if h.hasEnt {
		entry = uint64(h.entry) + 1
	}
	b = binary.AppendUvarint(b, entry)
	b = binary.AppendUvarint(b, uint64(max(h.top, 0)))

	for _, n := range h.nodes {
		switch {
		case n == nil:
			b = append(b, slotFree)
			continue
		case n.deleted:
			b = append(b, slotDeleted)
		default:
			b = append(b, slotLive)
		}
		b = binary.AppendUvarint(b, uint64(n.level))
		for _, x := range n.vec {
			b = binary.LittleEndian.AppendUint32(b, math.Float32bits(x))
		}
		for _, links := range n.links {
			b = binary.AppendUvarint(b, uint64(len(links)))
			for _, id := range links {
				b = binary.AppendUvarint(b, uint64(id))
			}
		}
	}
	return b, nil
}

// decoder reads the encoding, remembering the first error so callers can
// check once at the end.
type decoder struct {
	b   []byte
	err error
}

func (d *decoder) fail(format string, args ...any) {
	if d.err == nil {
		d.err = fmt.Errorf("%w: %s", ErrCorrupt, fmt.Sprintf(format, args...))
	}
}

func (d *decoder) u8() byte {
	if d.err != nil || len(d.b) < 1 {
		d.fail("unexpected end of data")
		return 0
	}
	v := d.b[0]
	d.b = d.b[1:]
	return v
}

func (d *decoder) uvarint(limit uint64, what string) uint64 {
	if d.err != nil {
		return 0
	}
	v, n := binary.Uvarint(d.b)
	if n <= 0 {
		d.fail("bad varint for %s", what)
		return 0
	}
	d.b = d.b[n:]
	if v > limit {
		d.fail("%s = %d exceeds %d", what, v, limit)
		return 0
	}
	return v
}

func (d *decoder) bytes(n int) []byte {
	if d.err != nil {
		return nil
	}
	if len(d.b) < n {
		d.fail("unexpected end of data")
		return nil
	}
	v := d.b[:n]
	d.b = d.b[n:]
	return v
}

// UnmarshalBinary decodes a graph written by MarshalBinary, checking every
// structural invariant so a corrupt file can't produce an index that
// panics later.
func UnmarshalBinary(data []byte) (*Index, error) {
	d := &decoder{b: data}
	var cfg Config
	cfg.Metric = vecmath.Metric(d.u8())
	cfg.Dim = int(d.uvarint(1<<20, "dim"))
	cfg.M = int(d.uvarint(1<<16, "M"))
	cfg.EfConstruction = int(d.uvarint(1<<24, "efConstruction"))
	cfg.EfSearch = int(d.uvarint(1<<24, "efSearch"))
	seed := d.bytes(8)
	flags := d.u8()
	rngLen := d.uvarint(1<<10, "rng state length")
	rngState := d.bytes(int(rngLen))
	if d.err != nil {
		return nil, d.err
	}
	cfg.Seed = binary.LittleEndian.Uint64(seed)
	cfg.SimpleSelection = flags&1 != 0
	cfg.KeepPrunedConnections = flags&2 != 0
	if cfg.Dim == 0 || cfg.M == 0 || cfg.EfConstruction == 0 || cfg.EfSearch == 0 {
		return nil, fmt.Errorf("%w: zero parameter in config %+v", ErrCorrupt, cfg)
	}
	h, err := New(cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	if err := h.pcg.UnmarshalBinary(rngState); err != nil {
		return nil, fmt.Errorf("%w: rng state: %v", ErrCorrupt, err)
	}
	h.rng = rand.New(h.pcg)

	// Each slot takes at least one byte, which bounds the count.
	slots := d.uvarint(uint64(len(d.b)), "slot count")
	entry := d.uvarint(slots, "entry point")
	top := int(d.uvarint(levelCap, "top layer"))
	if d.err != nil {
		return nil, d.err
	}
	h.nodes = make([]*node, slots)
	for i := range h.nodes {
		state := d.u8()
		if d.err != nil {
			return nil, d.err
		}
		if state == slotFree {
			continue
		}
		if state != slotLive && state != slotDeleted {
			return nil, fmt.Errorf("%w: slot %d has state %d", ErrCorrupt, i, state)
		}
		level := int(d.uvarint(levelCap, "level"))
		raw := d.bytes(4 * cfg.Dim)
		if d.err != nil {
			return nil, d.err
		}
		n := &node{level: level, deleted: state == slotDeleted, vec: make([]float32, cfg.Dim), links: make([][]uint32, level+1)}
		for j := range n.vec {
			n.vec[j] = math.Float32frombits(binary.LittleEndian.Uint32(raw[4*j:]))
		}
		for l := range n.links {
			count := d.uvarint(uint64(h.maxLinks(l)), "link count")
			links := make([]uint32, count, h.maxLinks(l))
			for k := range links {
				links[k] = uint32(d.uvarint(slots-1, "neighbor id"))
			}
			n.links[l] = links
		}
		if d.err != nil {
			return nil, d.err
		}
		h.nodes[i] = n
		if n.deleted {
			h.tombs++
		} else {
			h.live++
		}
	}
	if len(d.b) != 0 {
		return nil, fmt.Errorf("%w: %d trailing bytes", ErrCorrupt, len(d.b))
	}

	// Cross-node checks: links point at real nodes on that layer, and the
	// entry point is a real node on the top layer.
	for i, n := range h.nodes {
		if n == nil {
			continue
		}
		for l, links := range n.links {
			for _, to := range links {
				t := h.nodes[to]
				if t == nil || t.level < l || to == uint32(i) {
					return nil, fmt.Errorf("%w: node %d layer %d has invalid link to %d", ErrCorrupt, i, l, to)
				}
			}
		}
	}
	if entry > 0 {
		e := h.nodes[entry-1]
		if e == nil || e.level != top {
			return nil, fmt.Errorf("%w: entry point %d is not on top layer %d", ErrCorrupt, entry-1, top)
		}
		h.entry, h.top, h.hasEnt = uint32(entry-1), top, true
	} else if h.live+h.tombs > 0 {
		return nil, fmt.Errorf("%w: %d nodes but no entry point", ErrCorrupt, h.live+h.tombs)
	}
	return h, nil
}
