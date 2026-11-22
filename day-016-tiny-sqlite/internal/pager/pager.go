// Package pager provides fixed-size page I/O over a single file, a page cache
// and the file header.
//
// File layout:
//
//	page 0   header: magic, version, page size, page count, free list head
//	page 1   schema catalog (owned by package catalog)
//	page 2+  B+tree nodes and free-list pages
package pager

import (
	"container/list"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
)

const (
	PageSize    = 4096
	Version     = 1
	CatalogPage = 1 // page holding the schema catalog
	firstFree   = 2 // first page id the allocator may hand out

	headerMagic = "TINYSQLT"
	offVersion  = 8
	offPageSize = 12
	offPages    = 16
	offFreeHead = 20
)

var (
	ErrBadMagic    = errors.New("not a tinysql database file (bad magic bytes)")
	ErrBadVersion  = errors.New("unsupported database file version")
	ErrBadPageSize = errors.New("unsupported page size")
	ErrCorrupt     = errors.New("database file is corrupt")
	ErrRange       = errors.New("page id out of range")
)

// Options tune a Pager.
type Options struct {
	CacheSize int  // max cached pages (default 256)
	NoSync    bool // skip fsync (tests and benchmarks only)
}

// Stats are counters since the pager was opened.
type Stats struct {
	Reads, Writes        int // physical page reads and writes
	CacheHits, CacheMiss int
	Pages, FreePages     int
	CachedPages, Dirty   int
}

// Journal receives the original content of each page the first time a
// transaction modifies it. Package txn implements it with a journal file.
type Journal interface {
	Record(id uint32, before []byte) error
}

// ErrInTxn is returned by Begin when a transaction is already open.
var ErrInTxn = errors.New("a transaction is already active")

// stmtState is an in-memory savepoint taken around each statement, so a
// failing statement inside a longer transaction can be undone on its own.
type stmtState struct {
	pages    uint32
	freeHead uint32
	hdrDirty bool
	saved    map[uint32][]byte // page content at first touch in the statement
	wasDirty map[uint32]bool
}

type frame struct {
	id   uint32
	data []byte
	elem *list.Element
}

// Pager reads and writes 4096-byte pages through a write-back cache.
// Pages returned by Get must not be modified; call Write to modify a page.
type Pager struct {
	f        *os.File
	path     string
	opts     Options
	cache    map[uint32]*frame
	lru      *list.List // front = most recently used
	dirty    map[uint32]struct{}
	pages    uint32 // total pages, including 0 and 1
	freeHead uint32
	hdrDirty bool
	stats    Stats

	// transaction state (see Begin)
	inTxn    bool
	journal  Journal
	txnPages uint32 // page count when the transaction began
	txnFree  uint32 // free list head when the transaction began
	stmt     *stmtState
}

// Open opens or creates the database file at path.
func Open(path string, opts Options) (*Pager, error) {
	if opts.CacheSize <= 0 {
		opts.CacheSize = 256
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	p := &Pager{f: f, path: path, opts: opts, cache: map[uint32]*frame{},
		lru: list.New(), dirty: map[uint32]struct{}{}}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.Size() == 0 {
		if err := p.initialize(); err != nil {
			f.Close()
			return nil, err
		}
		return p, nil
	}
	if err := p.readHeader(st.Size()); err != nil {
		f.Close()
		return nil, err
	}
	return p, nil
}

func (p *Pager) initialize() error {
	buf := make([]byte, 2*PageSize)
	copy(buf, headerMagic)
	binary.LittleEndian.PutUint32(buf[offVersion:], Version)
	binary.LittleEndian.PutUint32(buf[offPageSize:], PageSize)
	binary.LittleEndian.PutUint32(buf[offPages:], 2)
	if _, err := p.f.WriteAt(buf, 0); err != nil {
		return err
	}
	if err := p.sync(); err != nil {
		return err
	}
	p.pages = 2
	return nil
}

func (p *Pager) readHeader(size int64) error {
	if size < PageSize {
		return fmt.Errorf("%w: file is only %d bytes", ErrBadMagic, size)
	}
	buf := make([]byte, PageSize)
	if _, err := p.f.ReadAt(buf, 0); err != nil {
		return err
	}
	if string(buf[:8]) != headerMagic {
		return ErrBadMagic
	}
	if v := binary.LittleEndian.Uint32(buf[offVersion:]); v != Version {
		return fmt.Errorf("%w: file has version %d, this build reads version %d", ErrBadVersion, v, Version)
	}
	if ps := binary.LittleEndian.Uint32(buf[offPageSize:]); ps != PageSize {
		return fmt.Errorf("%w: %d", ErrBadPageSize, ps)
	}
	p.pages = binary.LittleEndian.Uint32(buf[offPages:])
	p.freeHead = binary.LittleEndian.Uint32(buf[offFreeHead:])
	if p.pages < firstFree || int64(p.pages)*PageSize > size {
		return fmt.Errorf("%w: header says %d pages but file holds %d", ErrCorrupt, p.pages, size/PageSize)
	}
	return nil
}

// Path returns the database file path.
func (p *Pager) Path() string { return p.path }

// PageCount is the number of pages in the database, including the header.
func (p *Pager) PageCount() uint32 { return p.pages }

func (p *Pager) sync() error {
	if p.opts.NoSync {
		return nil
	}
	return p.f.Sync()
}

func (p *Pager) touch(fr *frame) {
	if fr.elem == nil {
		fr.elem = p.lru.PushFront(fr)
	} else {
		p.lru.MoveToFront(fr.elem)
	}
}

func (p *Pager) load(id uint32) (*frame, error) {
	if id >= p.pages {
		return nil, fmt.Errorf("%w: %d (database has %d pages)", ErrRange, id, p.pages)
	}
	if fr, ok := p.cache[id]; ok {
		p.stats.CacheHits++
		p.touch(fr)
		return fr, nil
	}
	p.stats.CacheMiss++
	data := make([]byte, PageSize)
	n, err := p.f.ReadAt(data, int64(id)*PageSize)
	if err != nil && !(errors.Is(err, io.EOF) && n == PageSize) {
		return nil, fmt.Errorf("reading page %d: %w", id, err)
	}
	p.stats.Reads++
	fr := &frame{id: id, data: data}
	p.cache[id] = fr
	p.touch(fr)
	p.evict(id)
	return fr, nil
}

// evict drops least recently used clean pages while the cache is over capacity.
// Dirty pages stay pinned until they are flushed, and keep is never dropped.
func (p *Pager) evict(keep uint32) {
	for e := p.lru.Back(); e != nil && len(p.cache) > p.opts.CacheSize; {
		prev := e.Prev()
		fr := e.Value.(*frame)
		if _, d := p.dirty[fr.id]; !d && fr.id != keep {
			p.lru.Remove(e)
			delete(p.cache, fr.id)
		}
		e = prev
	}
}

// Get returns the page for reading. The slice is only valid until the next
// call into the pager that may evict it; do not modify it.
func (p *Pager) Get(id uint32) ([]byte, error) {
	fr, err := p.load(id)
	if err != nil {
		return nil, err
	}
	return fr.data, nil
}

// Write returns the page for modification and marks it dirty.
func (p *Pager) Write(id uint32) ([]byte, error) {
	fr, err := p.load(id)
	if err != nil {
		return nil, err
	}
	if _, d := p.dirty[id]; !d {
		// A clean page still matches the file, so this is its before-image.
		if p.journal != nil && id < p.txnPages {
			if err := p.journal.Record(id, fr.data); err != nil {
				return nil, err
			}
		}
		p.dirty[id] = struct{}{}
		if p.stmt != nil && id < p.stmt.pages {
			p.stmt.wasDirty[id] = false
		}
	} else if p.stmt != nil && id < p.stmt.pages {
		if _, seen := p.stmt.wasDirty[id]; !seen {
			p.stmt.wasDirty[id] = true
		}
	}
	if p.stmt != nil && id < p.stmt.pages {
		if _, ok := p.stmt.saved[id]; !ok {
			p.stmt.saved[id] = append([]byte(nil), fr.data...)
		}
	}
	return fr.data, nil
}

// Allocate returns a zeroed page, reusing a freed page when one exists.
func (p *Pager) Allocate() (uint32, []byte, error) {
	if p.freeHead != 0 {
		id := p.freeHead
		buf, err := p.Write(id)
		if err != nil {
			return 0, nil, err
		}
		p.freeHead = binary.LittleEndian.Uint32(buf)
		clear(buf)
		p.hdrDirty = true
		return id, buf, nil
	}
	id := p.pages
	p.pages++
	fr := &frame{id: id, data: make([]byte, PageSize)}
	p.cache[id] = fr
	p.touch(fr)
	p.dirty[id] = struct{}{}
	p.hdrDirty = true
	return id, fr.data, nil
}

// Free returns a page to the free list.
func (p *Pager) Free(id uint32) error {
	if id < firstFree || id >= p.pages {
		return fmt.Errorf("%w: cannot free page %d", ErrRange, id)
	}
	buf, err := p.Write(id)
	if err != nil {
		return err
	}
	clear(buf)
	binary.LittleEndian.PutUint32(buf, p.freeHead)
	p.freeHead = id
	p.hdrDirty = true
	return nil
}

// FreeCount walks the free list and returns its length.
func (p *Pager) FreeCount() (int, error) {
	n := 0
	for id := p.freeHead; id != 0; n++ {
		if n > int(p.pages) {
			return 0, fmt.Errorf("%w: free list loops", ErrCorrupt)
		}
		buf, err := p.Get(id)
		if err != nil {
			return 0, err
		}
		id = binary.LittleEndian.Uint32(buf)
	}
	return n, nil
}

// syncHeader copies header fields into the page 0 frame.
func (p *Pager) syncHeader() error {
	if !p.hdrDirty {
		return nil
	}
	buf, err := p.Write(0)
	if err != nil {
		return err
	}
	copy(buf, headerMagic)
	binary.LittleEndian.PutUint32(buf[offVersion:], Version)
	binary.LittleEndian.PutUint32(buf[offPageSize:], PageSize)
	binary.LittleEndian.PutUint32(buf[offPages:], p.pages)
	binary.LittleEndian.PutUint32(buf[offFreeHead:], p.freeHead)
	p.hdrDirty = false
	return nil
}

// Flush writes every dirty page (and the header) to disk and syncs the file.
func (p *Pager) Flush() error {
	if err := p.syncHeader(); err != nil {
		return err
	}
	ids := make([]uint32, 0, len(p.dirty))
	for id := range p.dirty {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if _, err := p.f.WriteAt(p.cache[id].data, int64(id)*PageSize); err != nil {
			return fmt.Errorf("writing page %d: %w", id, err)
		}
		p.stats.Writes++
	}
	if len(ids) > 0 {
		if err := p.sync(); err != nil {
			return err
		}
	}
	clear(p.dirty)
	p.evict(0)
	return nil
}

// Stats returns a snapshot of the counters.
func (p *Pager) Stats() Stats {
	s := p.stats
	s.Pages = int(p.pages)
	s.FreePages, _ = p.FreeCount()
	s.CachedPages = len(p.cache)
	s.Dirty = len(p.dirty)
	return s
}

// Close flushes nothing: callers must Flush first. Unflushed changes are lost.
func (p *Pager) Close() error {
	if p.f == nil {
		return nil
	}
	err := p.f.Close()
	p.f = nil
	return err
}
