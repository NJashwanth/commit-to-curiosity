package btree

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"path/filepath"
	"sort"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

func newPager(t *testing.T) (*pager.Pager, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bt.db")
	p, err := pager.Open(path, pager.Options{NoSync: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p, path
}

func newTree(t *testing.T, cfg Config) (*Tree, *pager.Pager) {
	t.Helper()
	p, _ := newPager(t)
	tr, err := Create(p, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return tr, p
}

func val(k int64) []byte { return []byte(fmt.Sprintf("value-%d", k)) }

func TestLeafEncodeDecodeRoundTrip(t *testing.T) {
	l := &leaf{next: 42}
	for i, k := range []int64{-5, 0, 7, math.MaxInt64} {
		l.insertAt(i, k, bytes.Repeat([]byte{byte(i + 1)}, i*10))
	}
	buf := make([]byte, pager.PageSize)
	l.write(buf)
	got, err := readLeaf(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.next != 42 || len(got.keys) != 4 {
		t.Fatalf("%+v", got)
	}
	for i := range l.keys {
		if got.keys[i] != l.keys[i] || !bytes.Equal(got.vals[i], l.vals[i]) {
			t.Errorf("cell %d differs", i)
		}
	}
	if nodeType(buf) != typeLeaf {
		t.Error("node type")
	}
}

func TestLeafDecodeRejectsGarbage(t *testing.T) {
	buf := make([]byte, pager.PageSize)
	if _, err := readLeaf(buf); !errors.Is(err, ErrCorrupt) { // type 0
		t.Errorf("wrong type: %v", err)
	}
	buf[0] = typeLeaf
	buf[1], buf[2] = 0xff, 0xff // 65535 cells
	if _, err := readLeaf(buf); !errors.Is(err, ErrCorrupt) {
		t.Errorf("too many cells: %v", err)
	}
	buf[1], buf[2] = 1, 0
	buf[headerSize+8], buf[headerSize+9] = 0xff, 0xff // payload longer than the page
	if _, err := readLeaf(buf); !errors.Is(err, ErrCorrupt) {
		t.Errorf("oversized payload: %v", err)
	}
}

func TestInsertGetSortedOrder(t *testing.T) {
	tr, _ := newTree(t, Config{})
	keys := []int64{50, 10, 90, 30, 70, 20, 80, 40, 60, 0, -10}
	for _, k := range keys {
		if err := tr.Insert(k, val(k)); err != nil {
			t.Fatalf("Insert(%d): %v", k, err)
		}
	}
	var got []int64
	tr.All(func(k int64, v []byte) bool {
		got = append(got, k)
		if !bytes.Equal(v, val(k)) {
			t.Errorf("value for %d = %q", k, v)
		}
		return true
	})
	want := append([]int64(nil), keys...)
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("scan order %v, want %v", got, want)
	}
	for _, k := range keys {
		v, err := tr.Get(k)
		if err != nil || !bytes.Equal(v, val(k)) {
			t.Errorf("Get(%d) = %q, %v", k, v, err)
		}
	}
	if _, err := tr.Get(12345); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing key: %v", err)
	}
	if n, _ := tr.Count(); n != len(keys) {
		t.Errorf("Count = %d", n)
	}
	if err := tr.Check(); err != nil {
		t.Error(err)
	}
}

func TestDuplicateKeyRejected(t *testing.T) {
	tr, _ := newTree(t, Config{})
	tr.Insert(1, []byte("a"))
	err := tr.Insert(1, []byte("b"))
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("err = %v", err)
	}
	if v, _ := tr.Get(1); string(v) != "a" {
		t.Errorf("original value overwritten: %q", v)
	}
}

func TestDeleteAndUpdate(t *testing.T) {
	tr, _ := newTree(t, Config{})
	for k := int64(1); k <= 5; k++ {
		tr.Insert(k, val(k))
	}
	if err := tr.Delete(3); err != nil {
		t.Fatal(err)
	}
	if err := tr.Delete(3); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
	if err := tr.Update(4, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if err := tr.Update(99, []byte("x")); !errors.Is(err, ErrNotFound) {
		t.Errorf("update missing: %v", err)
	}
	if v, _ := tr.Get(4); string(v) != "new" {
		t.Errorf("Get(4) = %q", v)
	}
	if n, _ := tr.Count(); n != 4 {
		t.Errorf("Count = %d", n)
	}
}

func TestScanRanges(t *testing.T) {
	tr, _ := newTree(t, Config{})
	for k := int64(0); k < 100; k += 10 {
		tr.Insert(k, val(k))
	}
	collect := func(lo, hi int64) []int64 {
		var out []int64
		tr.Scan(lo, hi, func(k int64, _ []byte) bool { out = append(out, k); return true })
		return out
	}
	cases := []struct {
		lo, hi int64
		want   string
	}{
		{20, 50, "[20 30 40 50]"}, {21, 49, "[30 40]"}, {-100, 5, "[0]"}, {95, 1000, "[]"},
		{0, 90, "[0 10 20 30 40 50 60 70 80 90]"}, {30, 30, "[30]"}, {31, 39, "[]"}, {50, 20, "[]"},
	}
	for _, c := range cases {
		if got := fmt.Sprint(collect(c.lo, c.hi)); got != c.want {
			t.Errorf("Scan(%d,%d) = %s, want %s", c.lo, c.hi, got, c.want)
		}
	}
	n := 0
	tr.All(func(int64, []byte) bool { n++; return n < 3 })
	if n != 3 {
		t.Errorf("early stop visited %d", n)
	}
}

func TestPayloadLimit(t *testing.T) {
	tr, _ := newTree(t, Config{})
	if err := tr.Insert(1, make([]byte, MaxPayload)); err != nil {
		t.Errorf("max payload: %v", err)
	}
	if err := tr.Insert(2, make([]byte, MaxPayload+1)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("oversize insert: %v", err)
	}
	if err := tr.Update(1, make([]byte, MaxPayload+1)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("oversize update: %v", err)
	}
}

func TestSingleLeafFillsUp(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 4})
	for k := int64(0); k < 4; k++ {
		if err := tr.Insert(k, val(k)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tr.Insert(4, val(4)); !errors.Is(err, ErrNodeFull) {
		t.Errorf("5th insert: %v", err)
	}
	if n, _ := tr.Count(); n != 4 {
		t.Errorf("failed insert changed the leaf: %d", n)
	}
	// Byte-limited fill
	tr2, _ := newTree(t, Config{})
	var err error
	for k := int64(0); err == nil && k < 100; k++ {
		err = tr2.Insert(k, make([]byte, MaxPayload))
	}
	if !errors.Is(err, ErrNodeFull) {
		t.Errorf("byte-limited fill: %v", err)
	}
}

func TestPersistAcrossReopen(t *testing.T) {
	p, path := newPager(t)
	tr, _ := Create(p, Config{})
	rng := rand.New(rand.NewSource(1))
	perm := rng.Perm(50)
	for _, k := range perm {
		tr.Insert(int64(k), val(int64(k)))
	}
	root := tr.Root()
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	p.Close()

	p2, err := pager.Open(path, pager.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p2.Close()
	tr2 := Open(p2, root, Config{})
	for k := int64(0); k < 50; k++ {
		if v, err := tr2.Get(k); err != nil || !bytes.Equal(v, val(k)) {
			t.Fatalf("Get(%d) after reopen = %q, %v", k, v, err)
		}
	}
}

func TestGetReturnsCopy(t *testing.T) {
	tr, _ := newTree(t, Config{})
	tr.Insert(1, []byte("abc"))
	v, _ := tr.Get(1)
	v[0] = 'X'
	if v2, _ := tr.Get(1); string(v2) != "abc" {
		t.Errorf("mutation leaked into tree: %q", v2)
	}
}
