package exec

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/btree"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/txn"
)

func count(t *testing.T, db *DB, table string) string {
	t.Helper()
	st, err := db.Exec(mustParse(t, "SELECT COUNT(*) FROM "+table+";"))
	if err != nil {
		t.Fatal(err)
	}
	return FormatRaw(st)
}

func bulkInsert(t *testing.T, db *DB, table string, from, to int) {
	t.Helper()
	var sb strings.Builder
	fmt.Fprintf(&sb, "INSERT INTO %s VALUES ", table)
	for i := from; i <= to; i++ {
		if i > from {
			sb.WriteString(", ")
		}
		fmt.Fprintf(&sb, "(%d, 'row %d')", i, i)
	}
	mustRun(t, db, sb.String()+";")
}

func TestRollbackRestoresEverything(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 4, MaxInternalKeys: 4}})
	mustRun(t, db, "CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT);")
	bulkInsert(t, db, "a", 1, 200)
	bulkInsert(t, db, "b", 1, 50)
	schemaBefore, _ := db.Schema("")
	pagesBefore := db.p.PageCount()

	mustRun(t, db, "BEGIN;")
	mustRun(t, db, "DELETE FROM a WHERE id > 10;")
	mustRun(t, db, "UPDATE a SET v = 'changed';")
	bulkInsert(t, db, "b", 1000, 1100)
	mustRun(t, db, "DROP TABLE b;")
	mustRun(t, db, "CREATE TABLE c (id INTEGER PRIMARY KEY);")
	if out := count(t, db, "a"); out != "10\n" {
		t.Fatalf("inside txn a has %s", out)
	}
	mustRun(t, db, "ROLLBACK;")

	if out := count(t, db, "a"); out != "200\n" {
		t.Errorf("a after rollback: %s", out)
	}
	if out := count(t, db, "b"); out != "50\n" {
		t.Errorf("b after rollback: %s", out)
	}
	if got := strings.Join(db.Tables(), ","); got != "a,b" {
		t.Errorf("tables after rollback: %s", got)
	}
	if schemaAfter, _ := db.Schema(""); schemaAfter != schemaBefore {
		t.Errorf("schema changed: %q", schemaAfter)
	}
	if db.p.PageCount() != pagesBefore {
		t.Errorf("page count %d, want %d", db.p.PageCount(), pagesBefore)
	}
	if out := mustRun(t, db, "SELECT v FROM a WHERE id = 150;"); !strings.Contains(out, "row 150") {
		t.Errorf("row content: %s", out)
	}
	checkTable(t, db, "a")
	checkTable(t, db, "b")
}

func TestCommitPersistsAcrossReopen(t *testing.T) {
	db, path := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
	mustRun(t, db, "BEGIN;")
	bulkInsert(t, db, "t", 1, 500)
	mustRun(t, db, "UPDATE t SET v = 'x' WHERE id = 7;")
	mustRun(t, db, "COMMIT;")
	db.Close()
	db2, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if db2.Recovered() {
		t.Error("clean shutdown should not need recovery")
	}
	if out := count(t, db2, "t"); out != "500\n" {
		t.Errorf("count = %s", out)
	}
	if out := mustRun(t, db2, "SELECT v FROM t WHERE id = 7;"); !strings.Contains(out, "x\n") {
		t.Errorf("update lost: %s", out)
	}
}

func TestCloseWithOpenTransactionRollsBack(t *testing.T) {
	db, path := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY);")
	mustRun(t, db, "INSERT INTO t VALUES (1);")
	mustRun(t, db, "BEGIN;")
	mustRun(t, db, "INSERT INTO t VALUES (2), (3);")
	db.Close()
	db2, _ := Open(path, Options{})
	defer db2.Close()
	if out := count(t, db2, "t"); out != "1\n" {
		t.Errorf("count = %s", out)
	}
}

func TestStatementAtomicity(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 3, MaxInternalKeys: 3}})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
	bulkInsert(t, db, "t", 1, 20)

	// Autocommit: a multi-row INSERT that fails on its last row inserts nothing.
	runErr(t, db, "INSERT INTO t VALUES (100, 'a'), (101, 'b'), (5, 'dup');")
	if out := count(t, db, "t"); out != "20\n" {
		t.Errorf("partial insert leaked: %s", out)
	}
	// An UPDATE that fails halfway through changes nothing.
	runErr(t, db, "UPDATE t SET id = 10 + id WHERE id > 5 AND id < 12;")
	if out := mustRun(t, db, "SELECT COUNT(*) FROM t WHERE id < 12;"); !strings.Contains(out, "11") {
		t.Errorf("partial update leaked: %s", out)
	}
	checkTable(t, db, "t")

	// Inside a transaction only the failing statement is undone.
	mustRun(t, db, "BEGIN;")
	mustRun(t, db, "INSERT INTO t VALUES (50, 'keep');")
	runErr(t, db, "INSERT INTO t VALUES (51, 'gone'), (52, 'gone'), (50, 'dup');")
	if !db.tm.Active() {
		t.Fatal("a failed statement must not end the transaction")
	}
	mustRun(t, db, "INSERT INTO t VALUES (53, 'keep');")
	mustRun(t, db, "COMMIT;")
	if out := mustRun(t, db, "SELECT id FROM t WHERE id >= 50;"); !strings.Contains(out, "50\n53\n(2 rows)") {
		t.Errorf("rows = %s", out)
	}
	checkTable(t, db, "t")

	// A failing CREATE TABLE leaves no half-made table behind.
	runErr(t, db, "CREATE TABLE bad (a INTEGER);")
	if got := strings.Join(db.Tables(), ","); got != "t" {
		t.Errorf("tables = %s", got)
	}
}

func TestTransactionControlErrors(t *testing.T) {
	db, _ := openTemp(t, Options{})
	for src, want := range map[string]string{
		"COMMIT;":   "no transaction is active",
		"ROLLBACK;": "no transaction is active",
	} {
		if msg := runErr(t, db, src); !strings.Contains(msg, want) {
			t.Errorf("%s: %s", src, msg)
		}
	}
	mustRun(t, db, "BEGIN;")
	if msg := runErr(t, db, "BEGIN;"); !strings.Contains(msg, "within a transaction") {
		t.Errorf("nested begin: %s", msg)
	}
	if st := db.Stats(); !strings.Contains(st, "transaction:   active") {
		t.Errorf("stats: %s", st)
	}
	mustRun(t, db, "ROLLBACK;")
	if st := db.Stats(); !strings.Contains(st, "none (autocommit)") {
		t.Errorf("stats: %s", st)
	}
}

func TestUncommittedChangesAreVisibleToTheirTransaction(t *testing.T) {
	db, _ := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY);")
	mustRun(t, db, "BEGIN; INSERT INTO t VALUES (1), (2);")
	if out := count(t, db, "t"); out != "2\n" {
		t.Errorf("count = %s", out)
	}
	mustRun(t, db, "ROLLBACK;")
	if out := count(t, db, "t"); out != "0\n" {
		t.Errorf("count = %s", out)
	}
}

func TestBigTransactionRollback(t *testing.T) {
	db, _ := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
	bulkInsert(t, db, "t", 1, 100)
	mustRun(t, db, "BEGIN;")
	for i := 0; i < 10; i++ {
		bulkInsert(t, db, "t", 1000+i*1000, 1000+i*1000+999)
	}
	if out := count(t, db, "t"); out != "10100\n" {
		t.Fatalf("count = %s", out)
	}
	mustRun(t, db, "ROLLBACK;")
	if out := count(t, db, "t"); out != "100\n" {
		t.Errorf("count after rollback = %s", out)
	}
	checkTable(t, db, "t")
}

// Crash in the middle of COMMIT through the SQL layer, for every crash point.
func TestSQLCrashDuringCommitRestoresLastCommit(t *testing.T) {
	points := []struct {
		point txn.CrashPoint
		pages int
		keeps bool
	}{
		{txn.CrashDuringJournal, 0, false},
		{txn.CrashAfterJournalSync, 0, false},
		{txn.CrashDuringDBWrite, 0, false},
		{txn.CrashDuringDBWrite, 3, false},
		{txn.CrashAfterDBWrite, 0, false},
		{txn.CrashAfterCommit, 0, true},
	}
	for _, c := range points {
		t.Run(fmt.Sprintf("%v/%d", c.point, c.pages), func(t *testing.T) {
			db, path := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 4, MaxInternalKeys: 4}})
			mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
			bulkInsert(t, db, "t", 1, 300)
			mustRun(t, db, "BEGIN;")
			mustRun(t, db, "DELETE FROM t WHERE id > 100;")
			mustRun(t, db, "UPDATE t SET v = 'rewritten';")
			mustRun(t, db, "CREATE TABLE extra (id INTEGER PRIMARY KEY, v TEXT);")
			bulkInsert(t, db, "extra", 1, 40)

			db.TxnManager().Crash, db.TxnManager().CrashAfterPages = c.point, c.pages
			err := db.Run("COMMIT;", &strings.Builder{})
			if !errors.Is(err, txn.ErrSimulatedCrash) {
				t.Fatalf("COMMIT = %v", err)
			}
			db.TxnManager().Abandon()

			db2, err := Open(path, Options{Tree: btree.Config{MaxLeafCells: 4, MaxInternalKeys: 4}})
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			defer db2.Close()
			if c.keeps {
				if out := count(t, db2, "t"); out != "100\n" {
					t.Errorf("committed state lost: %s", out)
				}
				if got := strings.Join(db2.Tables(), ","); got != "extra,t" {
					t.Errorf("tables = %s", got)
				}
			} else {
				if !db2.Recovered() {
					t.Error("expected a recovery")
				}
				if out := count(t, db2, "t"); out != "300\n" {
					t.Errorf("count = %s, want 300", out)
				}
				if out := mustRun(t, db2, "SELECT v FROM t WHERE id = 250;"); !strings.Contains(out, "row 250") {
					t.Errorf("row content: %s", out)
				}
				if got := strings.Join(db2.Tables(), ","); got != "t" {
					t.Errorf("tables = %s", got)
				}
			}
			checkTable(t, db2, "t")
			// And it keeps working.
			mustRun(t, db2, "INSERT INTO t VALUES (9999, 'after recovery');")
		})
	}
}

func TestSQLCrashInAutocommitStatement(t *testing.T) {
	db, path := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
	mustRun(t, db, "INSERT INTO t VALUES (1, 'committed');")
	db.TxnManager().Crash = txn.CrashDuringDBWrite
	if err := db.Run("INSERT INTO t VALUES (2, 'in flight');", &strings.Builder{}); !errors.Is(err, txn.ErrSimulatedCrash) {
		t.Fatalf("err = %v", err)
	}
	if err := db.Run("SELECT 1;", &strings.Builder{}); !errors.Is(err, txn.ErrNeedsRecovery) {
		t.Errorf("crashed database must refuse work: %v", err)
	}
	db.TxnManager().Abandon()
	db2, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if out := mustRun(t, db2, "SELECT id FROM t;"); !strings.Contains(out, "1\n(1 row)") {
		t.Errorf("rows = %s", out)
	}
}
