package pager

import (
	"bytes"
	"errors"
	"os"
	"testing"
)

type memJournal struct {
	ids     []uint32
	content map[uint32][]byte
}

func newMemJournal() *memJournal { return &memJournal{content: map[uint32][]byte{}} }
func (m *memJournal) Record(id uint32, before []byte) error {
	m.ids = append(m.ids, id)
	m.content[id] = append([]byte(nil), before...)
	return nil
}

func fill(t *testing.T, p *Pager, id uint32, b byte) {
	t.Helper()
	buf, err := p.Write(id)
	if err != nil {
		t.Fatal(err)
	}
	for i := range buf {
		buf[i] = b
	}
}

func firstByte(t *testing.T, p *Pager, id uint32) byte {
	t.Helper()
	buf, err := p.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return buf[0]
}

func committed(t *testing.T) *Pager {
	t.Helper()
	p := open(t, tmpPath(t), Options{NoSync: true})
	for i := 0; i < 4; i++ {
		_, buf, _ := p.Allocate()
		buf[0] = byte('A' + i)
	}
	if err := p.Flush(); err != nil { // pages 2..5 hold A..D
		t.Fatal(err)
	}
	return p
}

func TestJournalSeesBeforeImagesOncePerPage(t *testing.T) {
	p := committed(t)
	j := newMemJournal()
	if err := p.Begin(j); err != nil {
		t.Fatal(err)
	}
	fill(t, p, 2, 'x')
	fill(t, p, 2, 'y') // second write: no new journal entry
	fill(t, p, 4, 'z')
	if len(j.ids) != 2 || j.ids[0] != 2 || j.ids[1] != 4 {
		t.Errorf("journal ids = %v", j.ids)
	}
	if j.content[2][0] != 'A' || j.content[4][0] != 'C' {
		t.Errorf("before-images wrong: %q %q", j.content[2][0], j.content[4][0])
	}
	// New pages have no before-image.
	id, _, _ := p.Allocate()
	if id != 6 || len(j.ids) != 2 {
		t.Errorf("allocated page journaled: id=%d ids=%v", id, j.ids)
	}
}

func TestDirtyPagesNeverReachTheFileBeforeCommit(t *testing.T) {
	p := committed(t)
	p.Begin(nil)
	fill(t, p, 3, 'Q')
	p.Allocate()
	p.Get(2) // reads must not flush anything
	raw := readFileBytes(t, p.Path())
	if raw[3*PageSize] != 'B' {
		t.Error("dirty page leaked to disk during the transaction")
	}
	if int64(len(raw)) != 6*PageSize {
		t.Errorf("file grew during the transaction: %d", len(raw))
	}
}

func TestAbortRestoresEverything(t *testing.T) {
	p := committed(t)
	freeBefore := p.PageCount()
	p.Begin(newMemJournal())
	fill(t, p, 2, 'x')
	p.Allocate()
	p.Allocate()
	p.Free(3)
	p.Abort()
	if p.InTxn() {
		t.Error("still in txn")
	}
	if p.PageCount() != freeBefore {
		t.Errorf("PageCount = %d, want %d", p.PageCount(), freeBefore)
	}
	if firstByte(t, p, 2) != 'A' || firstByte(t, p, 3) != 'B' {
		t.Error("page contents not restored")
	}
	if n, _ := p.FreeCount(); n != 0 {
		t.Errorf("free list = %d", n)
	}
	if st := p.Stats(); st.Dirty != 0 {
		t.Errorf("dirty = %d", st.Dirty)
	}
}

func TestCommitStepsPersist(t *testing.T) {
	p := committed(t)
	j := newMemJournal()
	p.Begin(j)
	fill(t, p, 2, 'x')
	id, buf, _ := p.Allocate()
	buf[0] = 'N'
	if err := p.PrepareCommit(); err != nil {
		t.Fatal(err)
	}
	if len(j.ids) == 0 || j.ids[len(j.ids)-1] != 0 { // header page was journaled
		t.Errorf("header page not journaled: %v", j.ids)
	}
	dirty := p.DirtyPages()
	if len(dirty) != 3 || dirty[0] != 0 || dirty[1] != 2 || dirty[2] != id {
		t.Errorf("dirty = %v", dirty)
	}
	n, err := p.WriteDirty(-1, false)
	if err != nil || n != 3 {
		t.Fatalf("WriteDirty = %d, %v", n, err)
	}
	p.Sync()
	p.EndTxn()
	p.Close()
	p2 := open(t, p.Path(), Options{})
	if firstByte(t, p2, 2) != 'x' || firstByte(t, p2, id) != 'N' || p2.PageCount() != 7 {
		t.Error("committed data missing after reopen")
	}
}

func TestWriteDirtyTornPage(t *testing.T) {
	p := committed(t)
	p.Begin(nil)
	fill(t, p, 2, 'x')
	fill(t, p, 3, 'y')
	fill(t, p, 4, 'z')
	n, err := p.WriteDirty(1, true)
	if err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
	}
	raw := readFileBytes(t, p.Path())
	if raw[2*PageSize] != 'x' || raw[2*PageSize+PageSize-1] != 'x' {
		t.Error("first page should be fully written")
	}
	if raw[3*PageSize] != 'y' || raw[3*PageSize+PageSize-1] != 0 { // front half new, back half old
		t.Errorf("second page should be torn: %q ... %q", raw[3*PageSize], raw[3*PageSize+PageSize-1])
	}
	if raw[4*PageSize] != 'C' {
		t.Error("third page must be untouched")
	}
}

func TestBeginTwice(t *testing.T) {
	p := committed(t)
	if err := p.Begin(nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Begin(nil); !errors.Is(err, ErrInTxn) {
		t.Errorf("err = %v", err)
	}
	if p.TxnPageCount() != 6 {
		t.Errorf("TxnPageCount = %d", p.TxnPageCount())
	}
}

func TestStatementRollbackKeepsEarlierChanges(t *testing.T) {
	p := committed(t)
	p.Begin(newMemJournal())
	fill(t, p, 2, 'x') // before the statement

	p.BeginStmt()
	fill(t, p, 2, 'y') // already dirty: must roll back to 'x', not 'A'
	fill(t, p, 3, 'y') // clean at statement start: back to 'B' and clean again
	nid, nbuf, _ := p.Allocate()
	nbuf[0] = 'n'
	p.Free(4)
	p.RollbackStmt()

	if firstByte(t, p, 2) != 'x' {
		t.Errorf("page 2 = %q, want x", firstByte(t, p, 2))
	}
	if firstByte(t, p, 3) != 'B' {
		t.Errorf("page 3 = %q, want B", firstByte(t, p, 3))
	}
	if firstByte(t, p, 4) != 'C' {
		t.Errorf("freed page not restored")
	}
	if p.PageCount() != 6 {
		t.Errorf("PageCount = %d (new page %d should be gone)", p.PageCount(), nid)
	}
	if n, _ := p.FreeCount(); n != 0 {
		t.Errorf("free list = %d", n)
	}
	if d := p.DirtyPages(); len(d) != 1 || d[0] != 2 {
		t.Errorf("dirty = %v, want only page 2", d)
	}
	// The transaction continues normally and can still commit.
	p.BeginStmt()
	fill(t, p, 5, 'k')
	p.EndStmt()
	p.RollbackStmt() // no-op without a savepoint
	if firstByte(t, p, 5) != 'k' {
		t.Error("EndStmt must keep changes")
	}
}

func TestFreedPageReuseInsideStatementRollsBack(t *testing.T) {
	p := committed(t)
	p.Begin(nil)
	p.Free(3)
	p.BeginStmt()
	id, buf, _ := p.Allocate() // pops page 3 off the free list
	buf[0] = 'R'
	if id != 3 {
		t.Fatalf("expected reuse of page 3, got %d", id)
	}
	p.RollbackStmt()
	if n, _ := p.FreeCount(); n != 1 {
		t.Errorf("free list = %d, want 1", n)
	}
	id2, _, _ := p.Allocate()
	if id2 != 3 {
		t.Errorf("page 3 should be allocatable again, got %d", id2)
	}
}

func readFileBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var _ = bytes.Equal
