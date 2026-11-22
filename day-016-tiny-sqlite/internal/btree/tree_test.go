package btree

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

func mustCheck(t *testing.T, tr *Tree) Stats {
	t.Helper()
	st, err := tr.Check()
	if err != nil {
		t.Fatalf("invariants violated: %v", err)
	}
	return st
}

func allKeys(t *testing.T, tr *Tree) []int64 {
	t.Helper()
	var out []int64
	if err := tr.All(func(k int64, _ []byte) bool { out = append(out, k); return true }); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTenThousandRandomInserts(t *testing.T) {
	tr, _ := newTree(t, Config{})
	rng := rand.New(rand.NewSource(20260101))
	keys := rng.Perm(10000)
	for _, k := range keys {
		if err := tr.Insert(int64(k), val(int64(k))); err != nil {
			t.Fatalf("Insert(%d): %v", k, err)
		}
	}
	st := mustCheck(t, tr)
	if st.Keys != 10000 || st.Height < 2 || st.Leaves < 50 {
		t.Errorf("stats %+v", st)
	}
	got := allKeys(t, tr)
	if len(got) != 10000 || !sort.SliceIsSorted(got, func(i, j int) bool { return got[i] < got[j] }) {
		t.Fatalf("scan returned %d keys, sorted=%v", len(got), sort.SliceIsSorted(got, func(i, j int) bool { return got[i] < got[j] }))
	}
	for i, k := range got {
		if k != int64(i) {
			t.Fatalf("missing key %d (found %d at slot %d)", i, k, i)
		}
	}
	for k := int64(0); k < 10000; k++ {
		v, err := tr.Get(k)
		if err != nil || !bytes.Equal(v, val(k)) {
			t.Fatalf("Get(%d) = %q, %v", k, v, err)
		}
	}
	if _, err := tr.Get(10000); !errors.Is(err, ErrNotFound) {
		t.Errorf("absent key: %v", err)
	}
}

func TestSmallNodesForceDeepTrees(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 4, MaxInternalKeys: 4})
	rng := rand.New(rand.NewSource(5))
	for _, k := range rng.Perm(2000) {
		if err := tr.Insert(int64(k), val(int64(k))); err != nil {
			t.Fatal(err)
		}
		if k%97 == 0 {
			mustCheck(t, tr)
		}
	}
	st := mustCheck(t, tr)
	if st.Height < 5 || st.Internals < 100 || st.Keys != 2000 {
		t.Errorf("expected a deep tree: %+v", st)
	}
	if n, _ := tr.Count(); n != 2000 {
		t.Errorf("Count = %d", n)
	}
}

func TestLargeRowsMakeThreeLevels(t *testing.T) {
	tr, _ := newTree(t, Config{})
	rng := rand.New(rand.NewSource(9))
	row := bytes.Repeat([]byte("x"), 900) // 4 rows per leaf
	for _, k := range rng.Perm(5000) {
		if err := tr.Insert(int64(k), row); err != nil {
			t.Fatal(err)
		}
	}
	st := mustCheck(t, tr)
	if st.Height != 3 {
		t.Errorf("height = %d, want 3 (%+v)", st.Height, st)
	}
	if n, _ := tr.Count(); n != 5000 {
		t.Errorf("Count = %d", n)
	}
}

func TestSequentialAndReverseInsertOrders(t *testing.T) {
	for name, order := range map[string]func(i int) int64{
		"ascending":  func(i int) int64 { return int64(i) },
		"descending": func(i int) int64 { return int64(3000 - i) },
	} {
		t.Run(name, func(t *testing.T) {
			tr, _ := newTree(t, Config{})
			for i := 0; i < 3000; i++ {
				k := order(i)
				if err := tr.Insert(k, val(k)); err != nil {
					t.Fatal(err)
				}
			}
			st := mustCheck(t, tr)
			if st.Keys != 3000 {
				t.Errorf("%+v", st)
			}
			keys := allKeys(t, tr)
			if !sort.SliceIsSorted(keys, func(i, j int) bool { return keys[i] < keys[j] }) {
				t.Error("not sorted")
			}
		})
	}
}

func TestAscendingInsertsPackLeavesFull(t *testing.T) {
	asc, _ := newTree(t, Config{})
	rnd, _ := newTree(t, Config{})
	rng := rand.New(rand.NewSource(3))
	for i := 0; i < 4000; i++ {
		asc.Insert(int64(i), val(int64(i)))
	}
	for _, k := range rng.Perm(4000) {
		rnd.Insert(int64(k), val(int64(k)))
	}
	a, r := mustCheck(t, asc), mustCheck(t, rnd)
	if a.Leaves >= r.Leaves {
		t.Errorf("sequential load should use fewer leaves: %d vs %d", a.Leaves, r.Leaves)
	}
}

func TestRootPageIDNeverChanges(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 3, MaxInternalKeys: 3})
	root := tr.Root()
	for k := int64(0); k < 500; k++ {
		tr.Insert(k, val(k))
	}
	if tr.Root() != root {
		t.Error("root moved")
	}
	// Re-open from the original root id and read everything.
	tr2 := Open(tr.p, root, Config{})
	if n, _ := tr2.Count(); n != 500 {
		t.Errorf("Count via original root = %d", n)
	}
}

func TestRangeScansMatchReference(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 5, MaxInternalKeys: 5})
	rng := rand.New(rand.NewSource(11))
	ref := map[int64]bool{}
	for len(ref) < 1500 {
		k := int64(rng.Intn(100000)) - 50000
		if ref[k] {
			continue
		}
		ref[k] = true
		if err := tr.Insert(k, val(k)); err != nil {
			t.Fatal(err)
		}
	}
	sorted := make([]int64, 0, len(ref))
	for k := range ref {
		sorted = append(sorted, k)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	for trial := 0; trial < 300; trial++ {
		lo := int64(rng.Intn(120000)) - 60000
		hi := lo + int64(rng.Intn(20000))
		var want []int64
		for _, k := range sorted {
			if k >= lo && k <= hi {
				want = append(want, k)
			}
		}
		var got []int64
		err := tr.Scan(lo, hi, func(k int64, v []byte) bool {
			if !bytes.Equal(v, val(k)) {
				t.Fatalf("wrong value for %d", k)
			}
			got = append(got, k)
			return true
		})
		if err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("Scan(%d,%d): got %d keys, want %d", lo, hi, len(got), len(want))
		}
	}
	// Boundaries at the extremes of int64.
	var n int
	tr.Scan(math.MinInt64, math.MaxInt64, func(int64, []byte) bool { n++; return true })
	if n != 1500 {
		t.Errorf("full scan = %d", n)
	}
	// Early termination across leaves.
	n = 0
	tr.Scan(sorted[0], sorted[len(sorted)-1], func(int64, []byte) bool { n++; return n < 12 })
	if n != 12 {
		t.Errorf("early stop = %d", n)
	}
}

func TestDuplicateAcrossSplitsRejected(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 4, MaxInternalKeys: 4})
	for k := int64(0); k < 200; k++ {
		tr.Insert(k*2, val(k))
	}
	for k := int64(0); k < 200; k++ {
		if err := tr.Insert(k*2, val(k)); !errors.Is(err, ErrDuplicate) {
			t.Fatalf("re-insert %d: %v", k*2, err)
		}
	}
	if n, _ := tr.Count(); n != 200 {
		t.Errorf("Count = %d", n)
	}
	mustCheck(t, tr)
}

func TestDeleteKeepsTreeValid(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 4, MaxInternalKeys: 4})
	rng := rand.New(rand.NewSource(21))
	for k := int64(0); k < 1000; k++ {
		tr.Insert(k, val(k))
	}
	deleted := map[int64]bool{}
	for _, k := range rng.Perm(1000)[:700] {
		if err := tr.Delete(int64(k)); err != nil {
			t.Fatal(err)
		}
		deleted[int64(k)] = true
	}
	mustCheck(t, tr)
	for k := int64(0); k < 1000; k++ {
		_, err := tr.Get(k)
		if deleted[k] != errors.Is(err, ErrNotFound) {
			t.Fatalf("key %d: deleted=%v err=%v", k, deleted[k], err)
		}
	}
	if n, _ := tr.Count(); n != 300 {
		t.Errorf("Count = %d", n)
	}
	// Re-insert some deleted keys; tree should accept them again.
	for k := range deleted {
		if k%2 == 0 {
			if err := tr.Insert(k, val(k)); err != nil {
				t.Fatal(err)
			}
		}
	}
	mustCheck(t, tr)
}

func TestDeleteEverythingThenReuse(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 4, MaxInternalKeys: 4})
	for k := int64(0); k < 300; k++ {
		tr.Insert(k, val(k))
	}
	for k := int64(0); k < 300; k++ {
		tr.Delete(k)
	}
	mustCheck(t, tr)
	if n, _ := tr.Count(); n != 0 {
		t.Errorf("Count = %d", n)
	}
	if _, ok, _ := tr.Max(); ok {
		t.Error("Max on an emptied tree")
	}
	for k := int64(0); k < 50; k++ {
		if err := tr.Insert(k, val(k)); err != nil {
			t.Fatal(err)
		}
	}
	mustCheck(t, tr)
	if k, ok, _ := tr.Max(); !ok || k != 49 {
		t.Errorf("Max = %d, %v", k, ok)
	}
}

func TestUpdateGrowingValuesSplitsLeaves(t *testing.T) {
	tr, _ := newTree(t, Config{})
	for k := int64(0); k < 400; k++ {
		tr.Insert(k, []byte("s"))
	}
	before := mustCheck(t, tr)
	big := bytes.Repeat([]byte("B"), 800)
	for k := int64(0); k < 400; k += 2 {
		if err := tr.Update(k, big); err != nil {
			t.Fatalf("Update(%d): %v", k, err)
		}
	}
	after := mustCheck(t, tr)
	if after.Leaves <= before.Leaves || after.Keys != 400 {
		t.Errorf("before %+v after %+v", before, after)
	}
	for k := int64(0); k < 400; k++ {
		v, err := tr.Get(k)
		want := []byte("s")
		if k%2 == 0 {
			want = big
		}
		if err != nil || !bytes.Equal(v, want) {
			t.Fatalf("Get(%d): %v", k, err)
		}
	}
	if err := tr.Update(9999, []byte("x")); !errors.Is(err, ErrNotFound) {
		t.Errorf("update missing: %v", err)
	}
	if err := tr.Update(1, make([]byte, MaxPayload+1)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("update too large: %v", err)
	}
}

func TestMax(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 3, MaxInternalKeys: 3})
	if _, ok, _ := tr.Max(); ok {
		t.Error("empty tree has no max")
	}
	for _, k := range []int64{5, -3, 99, 42, 7, 8, 9, 10} {
		tr.Insert(k, val(k))
	}
	if k, ok, err := tr.Max(); err != nil || !ok || k != 99 {
		t.Errorf("Max = %d %v %v", k, ok, err)
	}
	tr.Delete(99) // rightmost leaf may now be empty
	if k, _, _ := tr.Max(); k != 42 {
		t.Errorf("Max after delete = %d", k)
	}
}

func TestDestroyFreesAllPages(t *testing.T) {
	tr, p := newTree(t, Config{MaxLeafCells: 4, MaxInternalKeys: 4})
	for k := int64(0); k < 500; k++ {
		tr.Insert(k, val(k))
	}
	st := mustCheck(t, tr)
	total := st.Leaves + st.Internals
	if err := tr.Destroy(); err != nil {
		t.Fatal(err)
	}
	free, err := p.FreeCount()
	if err != nil || free != total {
		t.Errorf("free pages = %d (err %v), tree had %d", free, err, total)
	}
}

func TestPersistDeepTreeAcrossReopen(t *testing.T) {
	p, path := newPager(t)
	tr, _ := Create(p, Config{MaxLeafCells: 6, MaxInternalKeys: 6})
	for _, k := range rand.New(rand.NewSource(2)).Perm(1200) {
		tr.Insert(int64(k), val(int64(k)))
	}
	root := tr.Root()
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	p.Close()
	p2, err := pager.Open(path, pager.Options{CacheSize: 8})
	if err != nil {
		t.Fatal(err)
	}
	defer p2.Close()
	tr2 := Open(p2, root, Config{})
	st := mustCheck(t, tr2)
	if st.Keys != 1200 {
		t.Errorf("%+v", st)
	}
}

func TestDumpShowsStructure(t *testing.T) {
	tr, _ := newTree(t, Config{MaxLeafCells: 3, MaxInternalKeys: 3})
	var empty bytes.Buffer
	tr.Dump(&empty, 0)
	if !strings.Contains(empty.String(), "(empty)") {
		t.Errorf("empty dump: %q", empty.String())
	}
	for _, k := range []int64{10, 20, 30, 40, 50, 60, 70} {
		tr.Insert(k, val(k))
	}
	var buf bytes.Buffer
	if err := tr.Dump(&buf, 0); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{"[internal #", "[leaf #", "separators", "-> end", "rows)"} {
		if !strings.Contains(out, want) {
			t.Errorf("dump lacks %q:\n%s", want, out)
		}
	}
	// Truncated dump of a wide node.
	wide, _ := newTree(t, Config{MaxLeafCells: 2})
	for k := int64(0); k < 100; k++ {
		wide.Insert(k, val(k))
	}
	buf.Reset()
	wide.Dump(&buf, 6)
	if !strings.Contains(buf.String(), "more children") {
		t.Errorf("expected elision:\n%s", buf.String())
	}
	if strings.Count(buf.String(), "\n") > 12 {
		t.Errorf("dump too long:\n%s", buf.String())
	}
}

func TestCheckDetectsCorruption(t *testing.T) {
	build := func() (*Tree, *pager.Pager) {
		tr, p := newTree(t, Config{MaxLeafCells: 3, MaxInternalKeys: 3})
		for k := int64(0); k < 60; k++ {
			tr.Insert(k*10, val(k))
		}
		return tr, p
	}
	// Find a leaf via the sibling chain.
	firstLeaf := func(tr *Tree) uint32 { id, _ := tr.findLeaf(math.MinInt64); return id }

	tr, p := build()
	id := firstLeaf(tr)
	l, _ := tr.readLeaf(id)
	l.keys[0], l.keys[1] = l.keys[1], l.keys[0] // out of order
	tr.writeLeaf(id, l)
	if _, err := tr.Check(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("unsorted leaf not caught: %v", err)
	}

	tr, _ = build()
	id = firstLeaf(tr)
	l, _ = tr.readLeaf(id)
	l.keys[len(l.keys)-1] = 1 << 40 // beyond the parent's separator
	tr.writeLeaf(id, l)
	if _, err := tr.Check(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("out-of-range key not caught: %v", err)
	}

	tr, _ = build()
	id = firstLeaf(tr)
	l, _ = tr.readLeaf(id)
	l.next = 0 // break the sibling chain
	tr.writeLeaf(id, l)
	if _, err := tr.Check(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("broken sibling chain not caught: %v", err)
	}

	tr, p = build()
	buf, _ := p.Write(tr.Root())
	in, _ := readInternal(buf)
	in.children[1] = in.children[0] // same page twice
	in.write(buf)
	if _, err := tr.Check(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("shared child not caught: %v", err)
	}

	tr, p = build()
	buf, _ = p.Write(tr.Root())
	buf[0] = 77 // unknown node type
	if _, err := tr.Check(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("bad node type not caught: %v", err)
	}
	if _, err := tr.Get(5); !errors.Is(err, ErrCorrupt) {
		t.Errorf("Get on bad node: %v", err)
	}
	if err := tr.Insert(5, nil); !errors.Is(err, ErrCorrupt) {
		t.Errorf("Insert on bad node: %v", err)
	}
}

func TestInternalNodeEncoding(t *testing.T) {
	in := &internal{keys: []int64{-10, 5, 900}, children: []uint32{7, 8, 9, 10}}
	buf := make([]byte, pager.PageSize)
	in.write(buf)
	got, err := readInternal(buf)
	if err != nil || fmt.Sprint(got.keys) != "[-10 5 900]" || fmt.Sprint(got.children) != "[7 8 9 10]" {
		t.Errorf("%+v %v", got, err)
	}
	if got.childIndex(-11) != 0 || got.childIndex(-10) != 1 || got.childIndex(5) != 2 || got.childIndex(899) != 2 || got.childIndex(900) != 3 {
		t.Error("childIndex routing")
	}
	buf[0] = typeLeaf
	if _, err := readInternal(buf); !errors.Is(err, ErrCorrupt) {
		t.Error("wrong type accepted")
	}
	buf[0] = typeInternal
	buf[1], buf[2] = 0xff, 0xff
	if _, err := readInternal(buf); !errors.Is(err, ErrCorrupt) {
		t.Error("absurd key count accepted")
	}
}
