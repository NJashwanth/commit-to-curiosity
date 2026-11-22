// Package exec runs parsed SQL statements against the storage engine.
package exec

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/btree"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/catalog"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/txn"
)

// Result is what a statement produces.
type Result struct {
	Columns []string
	Rows    [][]record.Value
	IsQuery bool
	Message string
}

// DB is an open database.
type DB struct {
	tm  *txn.Manager
	p   *pager.Pager
	cat *catalog.Catalog
	// treeCfg is only ever non-zero in tests that want small nodes.
	treeCfg btree.Config
}

// Options configure Open.
type Options struct {
	Pager pager.Options
	Tree  btree.Config
}

// Open opens (creating if needed) the database at path. If a previous process
// died in the middle of a commit, the journal is rolled back first.
func Open(path string, opts Options) (*DB, error) {
	tm, err := txn.Open(path, opts.Pager)
	if err != nil {
		return nil, err
	}
	cat, err := catalog.Load(tm.P)
	if err != nil {
		tm.Close()
		return nil, err
	}
	return &DB{tm: tm, p: tm.P, cat: cat, treeCfg: opts.Tree}, nil
}

// Close rolls back any open transaction and closes the database file.
func (db *DB) Close() error { return db.tm.Close() }

// Recovered reports whether Open had to roll back an interrupted commit.
func (db *DB) Recovered() bool { return db.tm.Recovered() }

// TxnManager exposes the transaction manager (used by tests to inject crashes).
func (db *DB) TxnManager() *txn.Manager { return db.tm }

// Run parses and executes every statement in src, printing results to w.
// It stops at the first error.
func (db *DB) Run(src string, w io.Writer) error {
	stmts, err := sql.Parse(src)
	if err != nil {
		return err
	}
	for _, st := range stmts {
		res, err := db.Exec(st)
		if err != nil {
			return err
		}
		if err := Format(w, res); err != nil {
			return err
		}
	}
	return nil
}

// Exec executes one statement. Outside BEGIN ... COMMIT every statement runs
// in its own transaction (autocommit). Inside one, a statement that fails is
// undone on its own and the transaction stays open.
func (db *DB) Exec(st sql.Stmt) (*Result, error) {
	switch st.(type) {
	case *sql.Begin:
		if err := db.tm.Begin(); err != nil {
			if errors.Is(err, txn.ErrTxnActive) {
				return nil, errors.New("cannot start a transaction within a transaction")
			}
			return nil, err
		}
		return &Result{Message: "Transaction started."}, nil
	case *sql.Commit:
		if !db.tm.Active() {
			return nil, errors.New("cannot commit: no transaction is active")
		}
		if err := db.tm.Commit(); err != nil {
			return nil, err
		}
		return &Result{Message: "Committed."}, nil
	case *sql.Rollback:
		if !db.tm.Active() {
			return nil, errors.New("cannot roll back: no transaction is active")
		}
		if err := db.tm.Rollback(); err != nil {
			return nil, err
		}
		if err := db.cat.Reload(); err != nil {
			return nil, err
		}
		return &Result{Message: "Rolled back."}, nil
	}

	auto := !db.tm.Active()
	if auto {
		if err := db.tm.Begin(); err != nil {
			return nil, err
		}
	}
	db.p.BeginStmt()
	res, err := db.dispatch(st)
	if err != nil {
		db.p.RollbackStmt()
		if auto {
			db.tm.Rollback()
		}
		if rerr := db.cat.Reload(); rerr != nil {
			return nil, rerr
		}
		return nil, err
	}
	db.p.EndStmt()
	if auto {
		if err := db.tm.Commit(); err != nil {
			return nil, err
		}
	}
	return res, nil
}

func (db *DB) dispatch(st sql.Stmt) (*Result, error) {
	switch s := st.(type) {
	case *sql.CreateTable:
		return db.createTable(s)
	case *sql.Insert:
		return db.insert(s)
	case *sql.Select:
		return db.selectRows(s)
	case *sql.Update:
		return db.update(s)
	case *sql.Delete:
		return db.delete(s)
	case *sql.DropTable:
		return db.dropTable(s)
	}
	return nil, fmt.Errorf("statement %T is not supported yet", st)
}

func (db *DB) table(name string, pos sql.Pos) (*catalog.Table, *btree.Tree, error) {
	t, ok := db.cat.Get(name)
	if !ok {
		return nil, nil, posErrorf(pos, "no such table: %s", name)
	}
	return t, btree.Open(db.p, t.Root, db.treeCfg), nil
}

func (db *DB) createTable(s *sql.CreateTable) (*Result, error) {
	if _, exists := db.cat.Get(s.Name); exists {
		if s.IfNotExists {
			return &Result{Message: fmt.Sprintf("Table %s already exists.", s.Name)}, nil
		}
		return nil, fmt.Errorf("table %s already exists", s.Name)
	}
	t := catalog.Table{Name: s.Name}
	for _, c := range s.Columns {
		kind, _ := record.ParseKind(c.Type)
		t.Columns = append(t.Columns, catalog.Column{Name: c.Name, Type: kind, PrimaryKey: c.PrimaryKey})
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	tree, err := btree.Create(db.p, db.treeCfg)
	if err != nil {
		return nil, err
	}
	t.Root = tree.Root()
	if err := db.cat.Create(t); err != nil {
		db.p.Free(t.Root)
		return nil, err
	}
	return &Result{Message: fmt.Sprintf("Table %s created.", s.Name)}, nil
}

// Tables lists table names.
func (db *DB) Tables() []string { return db.cat.Names() }

// Schema returns CREATE TABLE text for one table, or all tables when name is empty.
func (db *DB) Schema(name string) (string, error) {
	if name != "" {
		t, ok := db.cat.Get(name)
		if !ok {
			return "", fmt.Errorf("no such table: %s", name)
		}
		return t.Schema(), nil
	}
	var parts []string
	for _, n := range db.cat.Names() {
		t, _ := db.cat.Get(n)
		parts = append(parts, t.Schema())
	}
	return strings.Join(parts, "\n"), nil
}

// BTree prints the structure of a table's B+tree.
func (db *DB) BTree(name string, w io.Writer) error {
	t, ok := db.cat.Get(name)
	if !ok {
		return fmt.Errorf("no such table: %s", name)
	}
	tree := btree.Open(db.p, t.Root, db.treeCfg)
	st, err := tree.Check()
	if err != nil {
		return fmt.Errorf("tree is damaged: %w", err)
	}
	fmt.Fprintf(w, "table %s: root page #%d, height %d, %d leaves, %d internal nodes, %d rows\n",
		t.Name, t.Root, st.Height, st.Leaves, st.Internals, st.Keys)
	return tree.Dump(w, 8)
}

// Stats describes the file and cache.
func (db *DB) Stats() string {
	s := db.p.Stats()
	var sb strings.Builder
	fmt.Fprintf(&sb, "file:          %s\n", db.p.Path())
	fmt.Fprintf(&sb, "page size:     %d bytes\n", pager.PageSize)
	fmt.Fprintf(&sb, "pages:         %d (%d free)\n", s.Pages, s.FreePages)
	fmt.Fprintf(&sb, "cache:         %d pages cached, %d dirty\n", s.CachedPages, s.Dirty)
	fmt.Fprintf(&sb, "cache hits:    %d, misses: %d\n", s.CacheHits, s.CacheMiss)
	fmt.Fprintf(&sb, "disk I/O:      %d page reads, %d page writes\n", s.Reads, s.Writes)
	fmt.Fprintf(&sb, "tables:        %d\n", len(db.cat.Names()))
	if db.tm.Active() {
		fmt.Fprintf(&sb, "transaction:   active (%d dirty pages)\n", s.Dirty)
	} else {
		fmt.Fprintf(&sb, "transaction:   none (autocommit)\n")
	}
	return sb.String()
}
