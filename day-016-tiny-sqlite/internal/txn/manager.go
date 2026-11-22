package txn

import (
	"errors"
	"fmt"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
)

var (
	ErrNoTxn          = errors.New("no transaction is active")
	ErrTxnActive      = errors.New("a transaction is already active")
	ErrSimulatedCrash = errors.New("simulated crash")
	ErrNeedsRecovery  = errors.New("database needs recovery after a failed commit; close and reopen it")
)

// CrashPoint selects where Commit should simulate a process crash. It exists
// so tests can prove that recovery works at every step of the protocol.
type CrashPoint int

const (
	CrashNone             CrashPoint = iota
	CrashDuringJournal               // journal half written, database untouched
	CrashAfterJournalSync            // journal complete, database untouched
	CrashDuringDBWrite               // some pages written, one torn in half
	CrashAfterDBWrite                // all pages written, journal still present
	CrashAfterCommit                 // journal deleted: the commit is durable
)

func (c CrashPoint) String() string {
	return [...]string{"none", "during journal write", "after journal sync", "during database write",
		"after database write", "after commit"}[c]
}

// Manager owns a pager and runs transactions on it.
type Manager struct {
	P         *pager.Pager
	path      string
	noSync    bool
	j         *journalFile
	active    bool
	poisoned  bool
	recovered bool

	// Fault injection for tests.
	Crash           CrashPoint
	CrashAfterPages int // CrashDuringDBWrite: pages written completely before the tear
}

// Open recovers the database if a journal is present, then opens it.
func Open(path string, opts pager.Options) (*Manager, error) {
	recovered, err := Recover(path, opts.NoSync)
	if err != nil {
		return nil, fmt.Errorf("recovery failed: %w", err)
	}
	p, err := pager.Open(path, opts)
	if err != nil {
		return nil, err
	}
	return &Manager{P: p, path: path, noSync: opts.NoSync, recovered: recovered}, nil
}

// Recovered reports whether Open rolled back an interrupted transaction.
func (m *Manager) Recovered() bool { return m.recovered }

// Active reports whether a transaction is open.
func (m *Manager) Active() bool { return m.active }

// Begin starts a transaction.
func (m *Manager) Begin() error {
	if m.poisoned {
		return ErrNeedsRecovery
	}
	if m.active {
		return ErrTxnActive
	}
	m.j = newJournal(m.path, m.P.PageCount(), m.noSync)
	if err := m.P.Begin(m.j); err != nil {
		return err
	}
	m.active = true
	return nil
}

// Rollback discards every change since Begin.
func (m *Manager) Rollback() error {
	if m.poisoned {
		return ErrNeedsRecovery
	}
	if !m.active {
		return ErrNoTxn
	}
	m.P.Abort()
	m.active = false
	err := m.j.remove()
	m.j = nil
	return err
}

func (m *Manager) crash() error {
	m.poisoned = true
	m.active = false
	return ErrSimulatedCrash
}

// fail marks the database unusable until it is reopened (and so recovered).
func (m *Manager) fail(err error) error {
	m.poisoned = true
	m.active = false
	return fmt.Errorf("commit failed: %w", err)
}

// Commit makes the transaction durable.
func (m *Manager) Commit() error {
	if m.poisoned {
		return ErrNeedsRecovery
	}
	if !m.active {
		return ErrNoTxn
	}
	if err := m.P.PrepareCommit(); err != nil {
		return m.fail(err)
	}
	if len(m.P.DirtyPages()) == 0 { // read-only transaction
		m.P.EndTxn()
		m.active = false
		return m.j.remove()
	}

	// 1. The journal must be on disk before any database page changes.
	if m.Crash == CrashDuringJournal {
		m.j.truncateTorn()
		m.j.closeFile()
		return m.crash()
	}
	if err := m.j.sync(); err != nil {
		return m.fail(err)
	}
	if m.Crash == CrashAfterJournalSync {
		m.j.closeFile()
		return m.crash()
	}

	// 2. Overwrite the database pages.
	if m.Crash == CrashDuringDBWrite {
		if _, err := m.P.WriteDirty(m.CrashAfterPages, true); err != nil {
			return m.fail(err)
		}
		m.j.closeFile()
		return m.crash()
	}
	if _, err := m.P.WriteDirty(-1, false); err != nil {
		return m.fail(err)
	}
	if err := m.P.Sync(); err != nil {
		return m.fail(err)
	}
	if m.Crash == CrashAfterDBWrite {
		m.j.closeFile()
		return m.crash()
	}

	// 3. Deleting the journal is the commit point.
	if err := m.j.remove(); err != nil {
		return m.fail(err)
	}
	m.P.EndTxn()
	m.active = false
	m.j = nil
	if m.Crash == CrashAfterCommit {
		return m.crash()
	}
	return nil
}

// Close rolls back any open transaction and closes the file.
func (m *Manager) Close() error {
	if m.active {
		m.Rollback()
	}
	return m.P.Close()
}

// Abandon closes the files without any cleanup, as if the process had been
// killed. The journal (if any) is left on disk.
func (m *Manager) Abandon() {
	if m.j != nil {
		m.j.closeFile()
	}
	m.P.Close()
}
