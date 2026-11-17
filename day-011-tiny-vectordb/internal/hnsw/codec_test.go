package hnsw

import (
	"encoding/binary"
	"errors"
	"slices"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

func sameGraph(t *testing.T, a, b *Index) {
	t.Helper()
	if a.cfg != b.cfg {
		t.Fatalf("config %+v != %+v", a.cfg, b.cfg)
	}
	if a.entry != b.entry || a.top != b.top || a.hasEnt != b.hasEnt || a.live != b.live || a.tombs != b.tombs {
		t.Fatalf("header differs: entry %d/%d top %d/%d live %d/%d tombs %d/%d",
			a.entry, b.entry, a.top, b.top, a.live, b.live, a.tombs, b.tombs)
	}
	if len(a.nodes) != len(b.nodes) {
		t.Fatalf("%d vs %d slots", len(a.nodes), len(b.nodes))
	}
	for i := range a.nodes {
		x, y := a.nodes[i], b.nodes[i]
		if (x == nil) != (y == nil) {
			t.Fatalf("slot %d: nil mismatch", i)
		}
		if x == nil {
			continue
		}
		if x.level != y.level || x.deleted != y.deleted || !slices.Equal(x.vec, y.vec) {
			t.Fatalf("node %d differs", i)
		}
		for l := range x.links {
			if !slices.Equal(x.links[l], y.links[l]) {
				t.Fatalf("node %d layer %d links differ", i, l)
			}
		}
	}
}

// churned builds an index with freed slots (cleaned up) and live tombstones.
func churned(t *testing.T) (*Index, [][]float32) {
	t.Helper()
	gen := vecmath.NewClusters(61, 16, 8, 0.2)
	cfg := Config{Dim: 16, Metric: vecmath.MetricL2, M: 8, EfConstruction: 40, Seed: 61, KeepPrunedConnections: true}
	h := build(t, cfg, gen.SampleN(1500))
	for i := 0; i < 1500; i += 5 {
		h.Delete(uint32(i))
	}
	h.Cleanup()
	for i := 1; i < 1500; i += 50 {
		h.Delete(uint32(i)) // tombstones that survive into the snapshot
	}
	return h, gen.SampleN(50)
}

func TestMarshalRoundTrip(t *testing.T) {
	t.Parallel()
	h, queries := churned(t)
	data, err := h.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	g, err := UnmarshalBinary(data)
	if err != nil {
		t.Fatal(err)
	}
	sameGraph(t, h, g)
	t.Logf("%d live nodes, %d tombstones, %d slots: %d bytes", h.Len(), h.Tombstones(), h.Slots(), len(data))

	for _, q := range queries {
		a, _ := h.Search(q, 10, 50)
		b, _ := g.Search(q, 10, 50)
		if !slices.Equal(a, b) {
			t.Fatalf("search results differ after round trip:\n%v\n%v", a, b)
		}
	}
	// The RNG state is saved too: the next insert gets the same level and
	// links in both, as if the index had never been saved.
	for _, q := range queries[:10] {
		ida, _ := h.Insert(q)
		idb, _ := g.Insert(q)
		if ida != idb {
			t.Fatalf("insert ids differ: %d vs %d", ida, idb)
		}
	}
	sameGraph(t, h, g)
}

func TestMarshalEmpty(t *testing.T) {
	h, _ := New(Config{Dim: 3, Metric: vecmath.MetricDot, Seed: 4, SimpleSelection: true})
	data, _ := h.MarshalBinary()
	g, err := UnmarshalBinary(data)
	if err != nil {
		t.Fatal(err)
	}
	sameGraph(t, h, g)
	if !g.cfg.SimpleSelection || g.MaxLevel() != -1 {
		t.Errorf("flags or emptiness lost: %+v top=%d", g.cfg, g.MaxLevel())
	}
}

func smallEncoded(t *testing.T) []byte {
	t.Helper()
	h := build(t, Config{Dim: 4, Metric: vecmath.MetricCosine, M: 4, EfConstruction: 16, Seed: 3}, uniform(3, 60, 4))
	h.Delete(5)
	data, err := h.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// Every truncation must be reported as ErrCorrupt, never panic or succeed.
func TestUnmarshalTruncated(t *testing.T) {
	data := smallEncoded(t)
	for n := range len(data) {
		if _, err := UnmarshalBinary(data[:n]); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("truncated to %d of %d bytes: err = %v, want ErrCorrupt", n, len(data), err)
		}
	}
}

// Flipping any single byte must give an error or a structurally valid
// index, never a panic. (The snapshot file's checksum catches flips that
// happen to decode; this guards the decoder itself.)
func TestUnmarshalByteFlips(t *testing.T) {
	data := smallEncoded(t)
	for i := range data {
		bad := slices.Clone(data)
		bad[i] ^= 0xff
		if g, err := UnmarshalBinary(bad); err == nil {
			checkGraph(t, g)
		}
	}
}

func TestUnmarshalStructuralErrors(t *testing.T) {
	data := smallEncoded(t)
	// Locate the first slot: config, rng state, then three varints.
	d := &decoder{b: data}
	d.u8()
	for range 4 {
		d.uvarint(1<<62, "")
	}
	d.bytes(8)
	d.u8()
	d.bytes(int(d.uvarint(1<<10, "")))
	headerEnd := len(data) - len(d.b)
	d.uvarint(1<<62, "")
	d.uvarint(1<<62, "")
	d.uvarint(1<<62, "")
	firstSlot := len(data) - len(d.b)

	cases := map[string]func([]byte) []byte{
		"bad metric":       func(b []byte) []byte { b[0] = 9; return b },
		"bad slot state":   func(b []byte) []byte { b[firstSlot] = 7; return b },
		"trailing bytes":   func(b []byte) []byte { return append(b, 0) },
		"entry not on top": func(b []byte) []byte { return patchEntry(b, headerEnd) },
	}
	for name, corrupt := range cases {
		if _, err := UnmarshalBinary(corrupt(slices.Clone(data))); !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: err = %v, want ErrCorrupt", name, err)
		}
	}
}

// patchEntry points the entry at whichever node isn't on the top layer.
func patchEntry(b []byte, at int) []byte {
	slots, n1 := binary.Uvarint(b[at:])
	entry, n2 := binary.Uvarint(b[at+n1:])
	alt := uint64(1)
	if entry == 1 {
		alt = 2
	}
	_ = slots
	out := slices.Clone(b[:at+n1])
	out = binary.AppendUvarint(out, alt)
	return append(out, b[at+n1+n2:]...)
}

func FuzzUnmarshalBinary(f *testing.F) {
	h, _ := New(Config{Dim: 2, Metric: vecmath.MetricL2, M: 2, EfConstruction: 4, Seed: 1})
	for _, v := range uniform(1, 12, 2) {
		_, _ = h.Insert(v)
	}
	data, _ := h.MarshalBinary()
	f.Add(data)
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, b []byte) {
		if g, err := UnmarshalBinary(b); err == nil {
			checkGraph(t, g)
			_, _ = g.Search([]float32{0, 0}, 3, 8)
		}
	})
}
