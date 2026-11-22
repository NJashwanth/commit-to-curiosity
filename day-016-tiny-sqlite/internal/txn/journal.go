// Package txn adds BEGIN / COMMIT / ROLLBACK on top of the pager using a
// rollback journal.
//
// Protocol
//
//  1. While a transaction runs, modified pages stay in the page cache. The
//     first time a page is modified its original content is appended to the
//     journal file (<db>-journal). The database file is not touched.
//  2. COMMIT: fsync the journal, write every dirty page to the database file,
//     fsync the database file, then delete the journal. Deleting the journal
//     is the commit point.
//  3. If the process dies before the journal is deleted, the next Open finds
//     the journal, copies the original pages back, truncates the file to its
//     original length and deletes the journal. The database is back at the
//     last committed state. ROLLBACK just drops the cached pages.
package txn

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"os"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

// Journal file layout:
//
//	header (24 bytes): magic "TSQLJRNL", version u32, page size u32,
//	                   original page count u32, crc32 of the first 20 bytes
//	entry (4104 bytes): page id u32, 4096 bytes of original content,
//	                    crc32 of the preceding 4100 bytes
const (
	journalMagic = "TSQLJRNL"
	headerSize   = 24
	entrySize    = 4 + pager.PageSize + 4
)

var crcTable = crc32.MakeTable(crc32.Castagnoli)

// JournalPath returns the journal file name for a database file.
func JournalPath(dbPath string) string { return dbPath + "-journal" }

// journalFile implements pager.Journal.
type journalFile struct {
	path      string
	origPages uint32
	noSync    bool
	f         *os.File
	recorded  map[uint32]bool
	entries   int
}

func newJournal(dbPath string, origPages uint32, noSync bool) *journalFile {
	return &journalFile{path: JournalPath(dbPath), origPages: origPages, noSync: noSync, recorded: map[uint32]bool{}}
}

// Record appends the original content of page id (once per transaction).
func (j *journalFile) Record(id uint32, before []byte) error {
	if j.recorded[id] {
		return nil
	}
	if j.f == nil {
		f, err := os.OpenFile(j.path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return fmt.Errorf("creating journal: %w", err)
		}
		hdr := make([]byte, headerSize)
		copy(hdr, journalMagic)
		binary.LittleEndian.PutUint32(hdr[8:], pager.Version)
		binary.LittleEndian.PutUint32(hdr[12:], pager.PageSize)
		binary.LittleEndian.PutUint32(hdr[16:], j.origPages)
		binary.LittleEndian.PutUint32(hdr[20:], crc32.Checksum(hdr[:20], crcTable))
		if _, err := f.Write(hdr); err != nil {
			f.Close()
			return err
		}
		j.f = f
	}
	buf := make([]byte, entrySize)
	binary.LittleEndian.PutUint32(buf, id)
	copy(buf[4:], before)
	binary.LittleEndian.PutUint32(buf[entrySize-4:], crc32.Checksum(buf[:entrySize-4], crcTable))
	if _, err := j.f.Write(buf); err != nil {
		return fmt.Errorf("writing journal: %w", err)
	}
	j.recorded[id] = true
	j.entries++
	return nil
}

func (j *journalFile) sync() error {
	if j.f == nil || j.noSync {
		return nil
	}
	return j.f.Sync()
}

// truncateTorn cuts the journal in the middle of an entry, as a power failure
// during the journal write could.
func (j *journalFile) truncateTorn() error {
	if j.f == nil {
		return nil
	}
	keep := int64(headerSize) + int64(j.entries/2)*entrySize + entrySize/2
	return j.f.Truncate(keep)
}

// remove closes and deletes the journal file.
func (j *journalFile) remove() error {
	if j.f != nil {
		j.f.Close()
		j.f = nil
	}
	if err := os.Remove(j.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// closeFile closes the handle without deleting the file (a "crash").
func (j *journalFile) closeFile() {
	if j.f != nil {
		j.f.Close()
		j.f = nil
	}
}

// Recover rolls back an interrupted transaction, if the journal of the
// database at dbPath exists. It reports whether it restored anything.
func Recover(dbPath string, noSync bool) (bool, error) {
	jpath := JournalPath(dbPath)
	data, err := os.ReadFile(jpath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	valid := len(data) >= headerSize && string(data[:8]) == journalMagic &&
		binary.LittleEndian.Uint32(data[20:]) == crc32.Checksum(data[:20], crcTable)
	if !valid {
		// The journal never got past its header, so the database file was
		// never written to: just discard it.
		return false, os.Remove(jpath)
	}
	if v := binary.LittleEndian.Uint32(data[8:]); v != pager.Version {
		return false, fmt.Errorf("journal has unsupported version %d", v)
	}
	if ps := binary.LittleEndian.Uint32(data[12:]); ps != pager.PageSize {
		return false, fmt.Errorf("journal has unsupported page size %d", ps)
	}
	origPages := binary.LittleEndian.Uint32(data[16:])

	db, err := os.OpenFile(dbPath, os.O_RDWR, 0o644)
	if err != nil {
		return false, fmt.Errorf("recovering %s: %w", dbPath, err)
	}
	defer db.Close()
	restored := 0
	for off := headerSize; off+entrySize <= len(data); off += entrySize {
		e := data[off : off+entrySize]
		if binary.LittleEndian.Uint32(e[entrySize-4:]) != crc32.Checksum(e[:entrySize-4], crcTable) {
			break // torn tail: those pages were never overwritten
		}
		id := binary.LittleEndian.Uint32(e)
		if id >= origPages {
			return false, fmt.Errorf("journal entry for page %d beyond original size %d", id, origPages)
		}
		if _, err := db.WriteAt(e[4:4+pager.PageSize], int64(id)*pager.PageSize); err != nil {
			return false, err
		}
		restored++
	}
	if err := db.Truncate(int64(origPages) * pager.PageSize); err != nil {
		return false, err
	}
	if !noSync {
		if err := db.Sync(); err != nil {
			return false, err
		}
	}
	if err := os.Remove(jpath); err != nil {
		return false, err
	}
	return true, nil
}
