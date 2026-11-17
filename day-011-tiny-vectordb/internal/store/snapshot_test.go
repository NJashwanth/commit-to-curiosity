package store

import (
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// churnedCollection has metadata, replaced ids, deletes, cleaned-up slots
// and live tombstones, so a snapshot exercises every part of the format.
func churnedCollection(t *testing.T) (*Collection, []Item) {
	t.Helper()
	c := newColl(t, Config{Name: "snap", Dim: 16, M: 8, EfConstruction: 48})
	c.SetCleanupRatio(0)
	items := docs(800, 16, 71)
	if _, err := c.Upsert(items); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 800; i += 4 {
		c.Delete(items[i].ID)
	}
	c.Cleanup()
	for i := 1; i < 800; i += 40 {
		c.Delete(items[i].ID)
	}
	_, _ = c.Upsert(items[2:30:30]) // re-upsert: more tombstones
	return c, docs(40, 16, 72)
}

func sameQueries(t *testing.T, a, b *Collection, queries []Item) {
	t.Helper()
	for _, filter := range []map[string]any{nil, {"lang": "go"}, {"tags": "db"}} {
		for _, q := range queries {
			x, err := a.Query(Query{Vector: q.Vector, K: 10, Filter: filter})
			if err != nil {
				t.Fatal(err)
			}
			y, err := b.Query(Query{Vector: q.Vector, K: 10, Filter: filter})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(x, y) {
				t.Fatalf("filter %v: results differ\n%v\n%v", filter, x, y)
			}
		}
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	c, queries := churnedCollection(t)
	data, _, err := c.MarshalSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	r, err := UnmarshalSnapshot(data)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d docs, %d tombstones: snapshot is %d bytes", c.Len(), c.Info().Tombstones, len(data))

	if !reflect.DeepEqual(c.Info(), r.Info()) {
		t.Errorf("info differs:\n%+v\n%+v", c.Info(), r.Info())
	}
	if !slices.Equal(c.IDs(), r.IDs()) {
		t.Fatal("ids differ")
	}
	for _, id := range c.IDs()[:50] {
		x, _ := c.Get(id)
		y, _ := r.Get(id)
		if !reflect.DeepEqual(x, y) {
			t.Fatalf("Get(%s) differs: %+v vs %+v", id, x, y)
		}
	}
	sameQueries(t, c, r, queries)

	// Both keep evolving identically after the reload.
	more := docs(60, 16, 73)
	for i := range more {
		more[i].ID = "new-" + more[i].ID
	}
	_, _ = c.Upsert(more)
	_, _ = r.Upsert(more)
	sameQueries(t, c, r, queries)

	// Re-encoding the reloaded collection is byte-identical.
	again, _, _ := r.MarshalSnapshot()
	now, _, _ := c.MarshalSnapshot()
	if !slices.Equal(again, now) {
		t.Error("snapshot of reloaded collection differs from the original's")
	}
}

func TestSnapshotEmptyCollection(t *testing.T) {
	c := newColl(t, Config{Name: "empty", Dim: 3, Metric: "l2"})
	data, _, _ := c.MarshalSnapshot()
	r, err := UnmarshalSnapshot(data)
	if err != nil {
		t.Fatal(err)
	}
	if r.Config() != c.Config() || r.Len() != 0 {
		t.Errorf("empty round trip: %+v len=%d", r.Config(), r.Len())
	}
}

// resign recomputes the checksum after a deliberate edit, to reach the
// checks behind it.
func resign(b []byte) []byte {
	n := len(b) - trailerSize
	binary.LittleEndian.PutUint32(b[n:], crc32.Checksum(b[:n], castagnoli))
	return b
}

func TestSnapshotCorruption(t *testing.T) {
	c, _ := churnedCollection(t)
	good, _, _ := c.MarshalSnapshot()

	cases := []struct {
		name    string
		corrupt func([]byte) []byte
		want    error
		msg     string
	}{
		{"flipped payload byte", func(b []byte) []byte { b[len(b)/2] ^= 0x01; return b }, ErrChecksum, "checksum mismatch"},
		{"flipped checksum byte", func(b []byte) []byte { b[len(b)-1] ^= 0x80; return b }, ErrChecksum, "corrupt"},
		{"newer version", func(b []byte) []byte { binary.LittleEndian.PutUint16(b[4:], 2); return b }, ErrUnsupportedVersion, "file is version 2, this build reads version 1"},
		{"version 0", func(b []byte) []byte { binary.LittleEndian.PutUint16(b[4:], 0); return resign(b) }, ErrUnsupportedVersion, "version 0"},
		{"bad magic", func(b []byte) []byte { copy(b, "PNG\x00"); return b }, ErrBadMagic, "not a tiny-vectordb snapshot"},
		{"empty file", func([]byte) []byte { return nil }, ErrBadMagic, "magic"},
		{"header only", func(b []byte) []byte { return b[:10] }, ErrTruncated, "truncated"},
		{"cut short", func(b []byte) []byte { return b[:len(b)-100] }, ErrTruncated, "truncated"},
		{"trailing garbage", func(b []byte) []byte { return append(b, 1, 2, 3) }, ErrCorrupt, "unexpected bytes"},
		{"bad payload, valid checksum", func(b []byte) []byte { b[headerSize] = 0xff; return resign(b) }, ErrCorrupt, "corrupt"},
		{"bad graph, valid checksum", func(b []byte) []byte { b[headerSize+20] ^= 0xff; return resign(b) }, ErrCorrupt, "corrupt"},
	}
	for _, tc := range cases {
		_, err := UnmarshalSnapshot(tc.corrupt(slices.Clone(good)))
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
			continue
		}
		if !strings.Contains(err.Error(), tc.msg) {
			t.Errorf("%s: message %q should mention %q", tc.name, err, tc.msg)
		}
	}
	if _, err := UnmarshalSnapshot(good); err != nil {
		t.Fatalf("the uncorrupted snapshot fails: %v", err)
	}
}

func TestSaveAndLoadFile(t *testing.T) {
	dir := t.TempDir()
	c, queries := churnedCollection(t)
	path := filepath.Join(dir, "snap.tvdb")
	if !c.Dirty() {
		t.Error("new collection with writes should be dirty")
	}
	if err := c.SaveFile(path); err != nil {
		t.Fatal(err)
	}
	if c.Dirty() {
		t.Error("collection still dirty after save")
	}
	r, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sameQueries(t, c, r, queries)
	c.Delete(c.IDs()[0])
	if !c.Dirty() {
		t.Error("delete after save should make the collection dirty")
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("dir has %d entries, want just the snapshot", len(entries))
	}
	if _, err := LoadFile(filepath.Join(dir, "missing.tvdb")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing file: %v", err)
	}
	if err := c.SaveFile(filepath.Join(dir, "no-such-dir", "x.tvdb")); err == nil {
		t.Error("save into a missing directory should fail")
	}
}

func TestDBPersistence(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if db.Dir() != dir {
		t.Errorf("Dir = %q", db.Dir())
	}
	docsColl, _ := db.Create(Config{Name: "docs", Dim: 16})
	_, _ = db.Create(Config{Name: "empty", Dim: 4, Metric: "dot"})
	_, _ = db.Create(Config{Name: "doomed", Dim: 4})
	items := docs(300, 16, 81)
	_, _ = docsColl.Upsert(items)

	// Create writes the file immediately; data waits for a save.
	for _, name := range []string{"docs", "empty", "doomed"} {
		if _, err := os.Stat(filepath.Join(dir, name+FileExt)); err != nil {
			t.Errorf("%s not on disk after create: %v", name, err)
		}
	}
	if n, err := db.SaveDirty(); err != nil || n != 1 {
		t.Errorf("SaveDirty = %d, %v; want 1 (only docs changed)", n, err)
	}
	if n, _ := db.SaveDirty(); n != 0 {
		t.Errorf("second SaveDirty wrote %d", n)
	}
	if err := db.Drop("doomed"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "doomed"+FileExt)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("dropped collection's file still exists: %v", err)
	}

	re, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, c := range re.List() {
		names = append(names, c.Name())
		if c.Dirty() {
			t.Errorf("%s dirty right after load", c.Name())
		}
	}
	if !slices.Equal(names, []string{"docs", "empty"}) {
		t.Fatalf("reloaded collections = %v", names)
	}
	got, _ := re.Get("docs")
	sameQueries(t, docsColl, got, docs(20, 16, 82))
	if err := re.Save("docs"); err != nil {
		t.Error(err)
	}
	if err := re.Save("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Save(nope) = %v", err)
	}
}

func TestOpenRejectsBadFiles(t *testing.T) {
	dir := t.TempDir()
	db, _ := Open(dir)
	c, _ := db.Create(Config{Name: "good", Dim: 4})
	_, _ = c.Upsert([]Item{{ID: "a", Vector: []float32{1, 2, 3, 4}}})
	_ = db.Save("good")
	path := filepath.Join(dir, "good"+FileExt)
	data, _ := os.ReadFile(path)

	data[len(data)/2] ^= 0x10
	_ = os.WriteFile(path, data, 0o644)
	_, err := Open(dir)
	if !errors.Is(err, ErrChecksum) || !strings.Contains(err.Error(), path) {
		t.Errorf("Open with corrupt file: %v (want ErrChecksum naming the file)", err)
	}

	// A valid snapshot under the wrong file name.
	data[len(data)/2] ^= 0x10
	_ = os.Remove(path)
	_ = os.WriteFile(filepath.Join(dir, "renamed"+FileExt), data, 0o644)
	if _, err := Open(dir); !errors.Is(err, ErrCorrupt) {
		t.Errorf("Open with renamed file: %v", err)
	}

	// The data path is a file, not a directory.
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o644)
	if _, err := Open(file); err == nil {
		t.Error("Open on a regular file should fail")
	}
}

func TestMaintainCleansAndSaves(t *testing.T) {
	dir := t.TempDir()
	db, _ := Open(dir)
	c, _ := db.Create(Config{Name: "m", Dim: 16})
	c.SetCleanupRatio(0)
	items := docs(100, 16, 91)
	_, _ = c.Upsert(items)
	for _, it := range items[:10] {
		c.Delete(it.ID)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		db.Maintain(ctx, 5*time.Millisecond, t.Logf)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for (c.Dirty() || c.Info().Tombstones > 0) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if c.Dirty() || c.Info().Tombstones != 0 {
		t.Fatalf("after maintenance: dirty=%v tombstones=%d", c.Dirty(), c.Info().Tombstones)
	}
	re, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := re.Get("m"); got.Len() != 90 {
		t.Errorf("reloaded %d docs, want 90", got.Len())
	}
	// Memory-only DBs have nothing to save.
	mem := NewDB()
	if n, err := mem.SaveDirty(); n != 0 || err != nil {
		t.Errorf("memory SaveDirty = %d, %v", n, err)
	}
	_, _ = mem.Create(Config{Name: "x", Dim: 2})
	if err := mem.Save("x"); err != nil {
		t.Errorf("memory Save = %v", err)
	}
}
