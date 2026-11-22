package txn

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"math/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

const dataPages = 8

func newDB(t *testing.T) (*Manager, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "txn.db")
	m, err := Open(path, pager.Options{NoSync: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m, path
}

// stamp writes a recognisable pattern across a whole page.
func stamp(t *testing.T, m *Manager, id uint32, gen byte) {
	t.Helper()
	buf, err := m.P.Write(id)
	if err != nil {
		t.Fatal(err)
	}
	for i := range buf {
		buf[i] = gen + byte(i%7)
	}
}

func readStamp(t *testing.T, p *pager.Pager, id uint32) byte {
	t.Helper()
	buf, err := p.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return buf[0]
}

// commitGeneration allocates pages on first use and stamps pages 2..dataPages+1.
func commitGeneration(t *testing.T, m *Manager, gen byte) {
	t.Helper()
	if err := m.Begin(); err != nil {
		t.Fatal(err)
	}
	for id := uint32(2); id < 2+dataPages; id++ {
		if id >= m.P.PageCount() {
			if _, _, err := m.P.Allocate(); err != nil {
				t.Fatal(err)
			}
		}
		stamp(t, m, id, gen)
	}
	if err := m.Commit(); err != nil {
		t.Fatal(err)
	}
}

func assertGeneration(t *testing.T, p *pager.Pager, gen byte, pages uint32) {
	t.Helper()
	if p.PageCount() != pages {
		t.Errorf("PageCount = %d, want %d", p.PageCount(), pages)
	}
	for id := uint32(2); id < 2+dataPages; id++ {
		buf, err := p.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		for i := range buf {
			if buf[i] != gen+byte(i%7) {
				t.Fatalf("page %d byte %d = %d, want generation %d (%d)", id, i, buf[i], gen, gen+byte(i%7))
			}
		}
	}
}

func TestCommitIsDurable(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)
	if _, err := os.Stat(JournalPath(path)); !errors.Is(err, os.ErrNotExist) {
		t.Error("journal should be deleted after commit")
	}
	m.Close()
	m2, err := Open(path, pager.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer m2.Close()
	if m2.Recovered() {
		t.Error("clean database should need no recovery")
	}
	assertGeneration(t, m2.P, 10, 2+dataPages)
}

func TestRollbackUndoesChanges(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)

	m.Begin()
	stamp(t, m, 2, 99)
	stamp(t, m, 5, 99)
	m.P.Allocate()
	m.P.Allocate()
	m.P.Free(6)
	if _, err := os.Stat(JournalPath(path)); err != nil {
		t.Errorf("journal should exist while a transaction has modified pages: %v", err)
	}
	if err := m.Rollback(); err != nil {
		t.Fatal(err)
	}
	if m.Active() {
		t.Error("still active")
	}
	assertGeneration(t, m.P, 10, 2+dataPages)
	if _, err := os.Stat(JournalPath(path)); !errors.Is(err, os.ErrNotExist) {
		t.Error("journal should be gone after rollback")
	}
	// The database is usable afterwards.
	commitGeneration(t, m, 20)
	assertGeneration(t, m.P, 20, 2+dataPages)
}

func TestTransactionStateErrors(t *testing.T) {
	m, _ := newDB(t)
	if err := m.Commit(); !errors.Is(err, ErrNoTxn) {
		t.Errorf("Commit: %v", err)
	}
	if err := m.Rollback(); !errors.Is(err, ErrNoTxn) {
		t.Errorf("Rollback: %v", err)
	}
	m.Begin()
	if err := m.Begin(); !errors.Is(err, ErrTxnActive) {
		t.Errorf("Begin twice: %v", err)
	}
	if err := m.Commit(); err != nil { // empty transaction
		t.Errorf("empty commit: %v", err)
	}
	if m.Active() {
		t.Error("active after commit")
	}
}

func TestReadOnlyTransactionWritesNothing(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 1)
	before, _ := os.ReadFile(path)
	m.Begin()
	readStamp(t, m.P, 3)
	if err := m.Commit(); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Error("read-only transaction modified the file")
	}
	if _, err := os.Stat(JournalPath(path)); !errors.Is(err, os.ErrNotExist) {
		t.Error("read-only transaction left a journal")
	}
}

// The core promise: crash anywhere in COMMIT and reopening restores the last
// committed state (or the new one, if the crash came after the commit point).
func TestCrashDuringCommitRecovers(t *testing.T) {
	cases := []struct {
		point    CrashPoint
		pages    int
		survives bool // does the in-flight transaction survive?
	}{
		{CrashDuringJournal, 0, false},
		{CrashAfterJournalSync, 0, false},
		{CrashDuringDBWrite, 0, false},
		{CrashDuringDBWrite, 1, false},
		{CrashDuringDBWrite, 4, false},
		{CrashDuringDBWrite, 9, false},
		{CrashAfterDBWrite, 0, false},
		{CrashAfterCommit, 0, true},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%v/%d", c.point, c.pages), func(t *testing.T) {
			m, path := newDB(t)
			commitGeneration(t, m, 10) // last committed state
			pagesBefore := m.P.PageCount()

			// A transaction that rewrites every page and also grows the file.
			m.Crash, m.CrashAfterPages = c.point, c.pages
			m.Begin()
			for id := uint32(2); id < 2+dataPages; id++ {
				stamp(t, m, id, 50)
			}
			for i := 0; i < 3; i++ {
				_, buf, _ := m.P.Allocate()
				buf[0] = 0xEE
			}
			err := m.Commit()
			if !errors.Is(err, ErrSimulatedCrash) {
				t.Fatalf("Commit = %v, want simulated crash", err)
			}
			if err := m.Begin(); !errors.Is(err, ErrNeedsRecovery) {
				t.Errorf("a crashed manager must refuse work, got %v", err)
			}
			m.Abandon() // the process "dies"

			_, jerr := os.Stat(JournalPath(path))
			if c.point != CrashAfterCommit && jerr != nil {
				t.Errorf("expected a hot journal on disk after the crash: %v", jerr)
			}

			m2, err := Open(path, pager.Options{})
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			defer m2.Close()
			if c.survives {
				assertGeneration(t, m2.P, 50, pagesBefore+3)
				if m2.Recovered() {
					t.Error("nothing to recover after a completed commit")
				}
			} else {
				assertGeneration(t, m2.P, 10, pagesBefore)
				if !m2.Recovered() {
					t.Error("Recovered() should be true")
				}
				st, _ := os.Stat(path)
				if st.Size() != int64(pagesBefore)*pager.PageSize {
					t.Errorf("file size %d, want %d (truncated back)", st.Size(), int64(pagesBefore)*pager.PageSize)
				}
			}
			if _, err := os.Stat(JournalPath(path)); !errors.Is(err, os.ErrNotExist) {
				t.Error("journal must be gone after recovery")
			}
			// The recovered database keeps working.
			commitGeneration(t, m2, 77)
			finalPages := pagesBefore
			if c.survives {
				finalPages += 3
			}
			assertGeneration(t, m2.P, 77, finalPages)
		})
	}
}

// Randomised version: many transactions, random crash points, random page sets.
func TestRandomCrashesNeverCorrupt(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	m, path := newDB(t)
	commitGeneration(t, m, 1)
	gen := byte(1)
	expectPages := m.P.PageCount()
	points := []CrashPoint{CrashNone, CrashDuringJournal, CrashAfterJournalSync, CrashDuringDBWrite, CrashAfterDBWrite, CrashAfterCommit}

	for round := 0; round < 60; round++ {
		next := gen + 1
		point := points[rng.Intn(len(points))]
		m.Crash, m.CrashAfterPages = point, rng.Intn(6)
		m.Begin()
		for id := uint32(2); id < 2+dataPages; id++ {
			stamp(t, m, id, next)
		}
		grow := uint32(rng.Intn(3))
		for i := uint32(0); i < grow; i++ {
			m.P.Allocate()
		}
		err := m.Commit()
		durable := point == CrashNone || point == CrashAfterCommit
		if point == CrashNone && err != nil {
			t.Fatal(err)
		}
		if point != CrashNone {
			if !errors.Is(err, ErrSimulatedCrash) {
				t.Fatalf("round %d: %v", round, err)
			}
			m.Abandon()
			var oerr error
			if m, oerr = Open(path, pager.Options{NoSync: true}); oerr != nil {
				t.Fatal(oerr)
			}
		}
		if durable {
			gen = next
			expectPages += grow
		}
		assertGeneration(t, m.P, gen, expectPages)
	}
	m.Close()
}

func TestDamagedJournalHeaderIsDiscarded(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)
	m.Close()
	for name, content := range map[string][]byte{
		"empty":        {},
		"short":        []byte("TSQLJ"),
		"bad magic":    bytes.Repeat([]byte{0xAB}, 100),
		"bad checksum": append([]byte(journalMagic), make([]byte, 40)...),
	} {
		os.WriteFile(JournalPath(path), content, 0o644)
		m2, err := Open(path, pager.Options{})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if m2.Recovered() {
			t.Errorf("%s: should not count as a recovery", name)
		}
		assertGeneration(t, m2.P, 10, 2+dataPages)
		m2.Close()
		if _, err := os.Stat(JournalPath(path)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: journal not removed", name)
		}
	}
}

func TestRecoveryStopsAtCorruptEntry(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)
	m.Crash = CrashAfterDBWrite
	m.Begin()
	for id := uint32(2); id < 2+dataPages; id++ {
		stamp(t, m, id, 50)
	}
	m.Commit()
	m.Abandon()

	// Flip a byte inside the third journal entry: entries 1-2 are restored,
	// recovery stops at the bad checksum.
	jp := JournalPath(path)
	data, _ := os.ReadFile(jp)
	data[headerSize+2*entrySize+100] ^= 0xFF
	os.WriteFile(jp, data, 0o644)

	m2, err := Open(path, pager.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer m2.Close()
	restored := 0
	for id := uint32(2); id < 2+dataPages; id++ {
		if readStamp(t, m2.P, id) == 10 {
			restored++
		}
	}
	// Journal entries are in dirty-page order (page 0 first, written at commit
	// time last), so the first two data pages are the ones restored.
	if restored != 2 {
		t.Errorf("restored %d pages, want 2", restored)
	}
}

func TestJournalRejectsBadVersionAndRange(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)
	m.Crash = CrashAfterJournalSync
	m.Begin()
	stamp(t, m, 2, 50)
	m.Commit()
	m.Abandon()
	jp := JournalPath(path)
	good, _ := os.ReadFile(jp)

	bad := append([]byte(nil), good...)
	binary.LittleEndian.PutUint32(bad[8:], 7)
	binary.LittleEndian.PutUint32(bad[20:], crc(bad[:20]))
	os.WriteFile(jp, bad, 0o644)
	if _, err := Open(path, pager.Options{}); err == nil {
		t.Error("bad journal version accepted")
	}

	bad = append([]byte(nil), good...)
	binary.LittleEndian.PutUint32(bad[12:], 512)
	binary.LittleEndian.PutUint32(bad[20:], crc(bad[:20]))
	os.WriteFile(jp, bad, 0o644)
	if _, err := Open(path, pager.Options{}); err == nil {
		t.Error("bad journal page size accepted")
	}

	bad = append([]byte(nil), good...)
	binary.LittleEndian.PutUint32(bad[16:], 3) // claims the file had 3 pages
	binary.LittleEndian.PutUint32(bad[20:], crc(bad[:20]))
	os.WriteFile(jp, bad, 0o644)
	if _, err := Open(path, pager.Options{}); err == nil {
		t.Error("journal entry beyond original size accepted")
	}
}

func TestRecoverWithoutJournalIsNoop(t *testing.T) {
	ok, err := Recover(filepath.Join(t.TempDir(), "none.db"), true)
	if ok || err != nil {
		t.Errorf("%v %v", ok, err)
	}
}

func TestCloseRollsBackOpenTransaction(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)
	m.Begin()
	stamp(t, m, 2, 90)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	m2, _ := Open(path, pager.Options{})
	defer m2.Close()
	assertGeneration(t, m2.P, 10, 2+dataPages)
}

func TestCrashPointStrings(t *testing.T) {
	for p := CrashNone; p <= CrashAfterCommit; p++ {
		if p.String() == "" {
			t.Errorf("empty name for %d", p)
		}
	}
}

func TestJournalDeduplicatesPages(t *testing.T) {
	m, path := newDB(t)
	commitGeneration(t, m, 10)
	m.Begin()
	stamp(t, m, 2, 1)
	stamp(t, m, 2, 2)
	m.P.BeginStmt()
	stamp(t, m, 3, 3)
	m.P.RollbackStmt()
	stamp(t, m, 3, 4) // page 3 becomes dirty again after the savepoint rollback
	st, _ := os.Stat(JournalPath(path))
	if want := int64(headerSize + 2*entrySize); st.Size() != want {
		t.Errorf("journal size %d, want %d (one entry per page)", st.Size(), want)
	}
	m.Rollback()
}

func crc(b []byte) uint32 { return crc32.Checksum(b, crcTable) }
