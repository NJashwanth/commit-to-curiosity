package pager

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func tmpPath(t *testing.T) string { return filepath.Join(t.TempDir(), "test.db") }

func open(t *testing.T, path string, opts Options) *Pager {
	t.Helper()
	p, err := Open(path, opts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { p.Close() })
	return p
}

func TestNewFileHasHeaderAndCatalogPage(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{})
	if p.PageCount() != 2 {
		t.Errorf("PageCount = %d, want 2", p.PageCount())
	}
	st, _ := os.Stat(path)
	if st.Size() != 2*PageSize {
		t.Errorf("file size %d", st.Size())
	}
	raw, _ := os.ReadFile(path)
	if string(raw[:8]) != "TINYSQLT" {
		t.Errorf("magic = %q", raw[:8])
	}
	if v := binary.LittleEndian.Uint32(raw[8:]); v != Version {
		t.Errorf("version = %d", v)
	}
	if ps := binary.LittleEndian.Uint32(raw[12:]); ps != 4096 {
		t.Errorf("page size = %d", ps)
	}
}

func TestWriteReadPersistAcrossReopen(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{})
	id, buf, err := p.Allocate()
	if err != nil || id != 2 {
		t.Fatalf("Allocate = %d, %v", id, err)
	}
	copy(buf, "hello pager")
	id2, buf2, _ := p.Allocate()
	copy(buf2, "second page")
	cat, _ := p.Write(CatalogPage)
	copy(cat, "catalog bytes")
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	p.Close()

	p2 := open(t, path, Options{})
	if p2.PageCount() != 4 {
		t.Fatalf("PageCount = %d", p2.PageCount())
	}
	for id, want := range map[uint32]string{id: "hello pager", id2: "second page", CatalogPage: "catalog bytes"} {
		got, err := p2.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.HasPrefix(got, []byte(want)) {
			t.Errorf("page %d = %q, want prefix %q", id, got[:16], want)
		}
		if len(got) != PageSize {
			t.Errorf("page len %d", len(got))
		}
	}
}

func TestUnflushedChangesAreLost(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{})
	buf, _ := p.Write(CatalogPage)
	copy(buf, "never flushed")
	p.Close()
	p2 := open(t, path, Options{})
	got, _ := p2.Get(CatalogPage)
	if got[0] != 0 {
		t.Error("unflushed write reached disk")
	}
}

func TestRejectsBadMagic(t *testing.T) {
	path := tmpPath(t)
	os.WriteFile(path, append([]byte("NOTADB!!"), make([]byte, 2*PageSize)...), 0o644)
	if _, err := Open(path, Options{}); !errors.Is(err, ErrBadMagic) {
		t.Errorf("err = %v, want ErrBadMagic", err)
	}
}

func TestRejectsTinyFile(t *testing.T) {
	path := tmpPath(t)
	os.WriteFile(path, []byte("short"), 0o644)
	if _, err := Open(path, Options{}); !errors.Is(err, ErrBadMagic) {
		t.Errorf("err = %v, want ErrBadMagic", err)
	}
}

func TestRejectsBadVersionAndPageSize(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{})
	p.Close()
	raw, _ := os.ReadFile(path)

	bad := append([]byte(nil), raw...)
	binary.LittleEndian.PutUint32(bad[8:], 99)
	os.WriteFile(path, bad, 0o644)
	if _, err := Open(path, Options{}); !errors.Is(err, ErrBadVersion) {
		t.Errorf("err = %v, want ErrBadVersion", err)
	}

	bad = append([]byte(nil), raw...)
	binary.LittleEndian.PutUint32(bad[12:], 8192)
	os.WriteFile(path, bad, 0o644)
	if _, err := Open(path, Options{}); !errors.Is(err, ErrBadPageSize) {
		t.Errorf("err = %v, want ErrBadPageSize", err)
	}

	bad = append([]byte(nil), raw...)
	binary.LittleEndian.PutUint32(bad[16:], 50) // claims 50 pages, file has 2
	os.WriteFile(path, bad, 0o644)
	if _, err := Open(path, Options{}); !errors.Is(err, ErrCorrupt) {
		t.Errorf("err = %v, want ErrCorrupt", err)
	}
}

func TestOutOfRange(t *testing.T) {
	p := open(t, tmpPath(t), Options{})
	if _, err := p.Get(2); !errors.Is(err, ErrRange) {
		t.Errorf("Get: %v", err)
	}
	if _, err := p.Write(99); !errors.Is(err, ErrRange) {
		t.Errorf("Write: %v", err)
	}
	if err := p.Free(0); !errors.Is(err, ErrRange) {
		t.Errorf("Free(0): %v", err)
	}
	if err := p.Free(1); !errors.Is(err, ErrRange) {
		t.Errorf("Free(1): %v", err)
	}
	if err := p.Free(7); !errors.Is(err, ErrRange) {
		t.Errorf("Free(7): %v", err)
	}
}

func TestFreeListReusesPages(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{})
	var ids []uint32
	for i := 0; i < 5; i++ {
		id, buf, _ := p.Allocate()
		buf[0] = byte(i + 1)
		ids = append(ids, id)
	}
	p.Flush()
	p.Free(ids[1])
	p.Free(ids[3])
	if n, _ := p.FreeCount(); n != 2 {
		t.Errorf("FreeCount = %d", n)
	}
	p.Flush()
	p.Close()

	p2 := open(t, path, Options{})
	if n, _ := p2.FreeCount(); n != 2 {
		t.Fatalf("FreeCount after reopen = %d", n)
	}
	id, buf, _ := p2.Allocate()
	if id != ids[3] { // LIFO
		t.Errorf("reused %d, want %d", id, ids[3])
	}
	if !bytes.Equal(buf, make([]byte, PageSize)) {
		t.Error("reused page not zeroed")
	}
	id, _, _ = p2.Allocate()
	if id != ids[1] {
		t.Errorf("reused %d, want %d", id, ids[1])
	}
	id, _, _ = p2.Allocate()
	if id != 7 {
		t.Errorf("fresh page id %d, want 7", id)
	}
	if p2.PageCount() != 8 {
		t.Errorf("PageCount = %d", p2.PageCount())
	}
}

func TestCacheEvictsCleanPagesOnly(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{CacheSize: 4})
	for i := 0; i < 20; i++ {
		_, buf, _ := p.Allocate()
		buf[0] = byte(i)
	}
	if st := p.Stats(); st.CachedPages < 20 || st.Dirty != 20 {
		t.Errorf("dirty pages must stay pinned: %+v", st)
	}
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	if st := p.Stats(); st.CachedPages > 4 || st.Dirty != 0 {
		t.Errorf("after flush cache should shrink: %+v", st)
	}
	// Reading every page again must return the right bytes despite evictions.
	for i := 0; i < 20; i++ {
		buf, err := p.Get(uint32(i + 2))
		if err != nil || buf[0] != byte(i) {
			t.Fatalf("page %d: %v, first byte %d", i+2, err, buf[0])
		}
	}
	st := p.Stats()
	if st.CacheMiss == 0 || st.Reads == 0 {
		t.Errorf("expected cache misses: %+v", st)
	}
	if st.CachedPages > 4 {
		t.Errorf("cache holds %d pages, cap 4", st.CachedPages)
	}
}

func TestCacheHitsCounted(t *testing.T) {
	p := open(t, tmpPath(t), Options{})
	p.Get(1)
	before := p.Stats()
	p.Get(1)
	p.Get(1)
	after := p.Stats()
	if after.CacheHits-before.CacheHits != 2 || after.Reads != before.Reads {
		t.Errorf("before %+v after %+v", before, after)
	}
	if after.Pages != 2 || after.FreePages != 0 {
		t.Errorf("%+v", after)
	}
}

func TestHeaderRoundTripThroughFlush(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{NoSync: true})
	p.Allocate()
	p.Allocate()
	p.Flush()
	raw, _ := os.ReadFile(path)
	if n := binary.LittleEndian.Uint32(raw[16:]); n != 4 {
		t.Errorf("page count in header = %d", n)
	}
	if int64(len(raw)) != 4*PageSize {
		t.Errorf("file size %d", len(raw))
	}
	if err := p.Flush(); err != nil { // no-op flush
		t.Error(err)
	}
}

func TestCloseIsIdempotentAndPathReported(t *testing.T) {
	path := tmpPath(t)
	p := open(t, path, Options{})
	if p.Path() != path {
		t.Error("Path")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Error("second Close should be a no-op")
	}
}

func TestOpenFailsOnDirectory(t *testing.T) {
	if _, err := Open(t.TempDir(), Options{}); err == nil {
		t.Error("opening a directory should fail")
	}
}
