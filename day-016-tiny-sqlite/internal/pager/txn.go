package pager

import (
	"fmt"
	"sort"
)

// Begin starts a transaction. Until it ends, dirty pages are never written to
// the database file, and j (if not nil) is told about every page's original
// content before the page is first modified.
func (p *Pager) Begin(j Journal) error {
	if p.inTxn {
		return ErrInTxn
	}
	p.inTxn = true
	p.journal = j
	p.txnPages = p.pages
	p.txnFree = p.freeHead
	return nil
}

// InTxn reports whether a transaction is open.
func (p *Pager) InTxn() bool { return p.inTxn }

// TxnPageCount is the number of pages the file had when the transaction began.
func (p *Pager) TxnPageCount() uint32 { return p.txnPages }

// PrepareCommit copies header fields into page 0 (journaling its original
// content) so that every page to be written is known and journaled.
func (p *Pager) PrepareCommit() error { return p.syncHeader() }

// DirtyPages lists modified pages in ascending order.
func (p *Pager) DirtyPages() []uint32 {
	ids := make([]uint32, 0, len(p.dirty))
	for id := range p.dirty {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// WriteDirty writes dirty pages to the file in ascending order without
// syncing. limit < 0 writes all of them; otherwise only the first limit pages
// are written and, if tear is set, the following page is written only half way
// (a torn write, used to simulate a crash). It returns how many pages were
// written completely.
func (p *Pager) WriteDirty(limit int, tear bool) (int, error) {
	ids := p.DirtyPages()
	n := 0
	for _, id := range ids {
		if limit >= 0 && n >= limit {
			if tear {
				if _, err := p.f.WriteAt(p.cache[id].data[:PageSize/2], int64(id)*PageSize); err != nil {
					return n, err
				}
			}
			return n, nil
		}
		if _, err := p.f.WriteAt(p.cache[id].data, int64(id)*PageSize); err != nil {
			return n, fmt.Errorf("writing page %d: %w", id, err)
		}
		p.stats.Writes++
		n++
	}
	return n, nil
}

// Sync flushes file contents to stable storage.
func (p *Pager) Sync() error { return p.sync() }

// EndTxn finishes a committed transaction: its pages are now on disk.
func (p *Pager) EndTxn() {
	clear(p.dirty)
	p.inTxn, p.journal, p.stmt = false, nil, nil
	p.hdrDirty = false
	p.evict(0)
}

// Abort throws away every change made since Begin. Nothing was written to the
// database file, so dropping the dirty pages from the cache is enough.
func (p *Pager) Abort() {
	for id := range p.dirty {
		p.drop(id)
	}
	clear(p.dirty)
	p.pages, p.freeHead = p.txnPages, p.txnFree
	p.hdrDirty = false
	p.inTxn, p.journal, p.stmt = false, nil, nil
}

func (p *Pager) drop(id uint32) {
	if fr, ok := p.cache[id]; ok {
		if fr.elem != nil {
			p.lru.Remove(fr.elem)
		}
		delete(p.cache, id)
	}
}

// BeginStmt takes a savepoint at the start of a statement.
func (p *Pager) BeginStmt() {
	p.stmt = &stmtState{pages: p.pages, freeHead: p.freeHead, hdrDirty: p.hdrDirty,
		saved: map[uint32][]byte{}, wasDirty: map[uint32]bool{}}
}

// EndStmt discards the savepoint; the statement's changes stay in the transaction.
func (p *Pager) EndStmt() { p.stmt = nil }

// RollbackStmt undoes everything since BeginStmt, leaving earlier changes in
// the transaction intact.
func (p *Pager) RollbackStmt() {
	s := p.stmt
	if s == nil {
		return
	}
	for id, orig := range s.saved {
		if fr, ok := p.cache[id]; ok {
			copy(fr.data, orig)
		}
		if !s.wasDirty[id] {
			delete(p.dirty, id)
		}
	}
	for id := s.pages; id < p.pages; id++ { // pages allocated by the statement
		delete(p.dirty, id)
		p.drop(id)
	}
	p.pages, p.freeHead, p.hdrDirty = s.pages, s.freeHead, s.hdrDirty
	p.stmt = nil
}
