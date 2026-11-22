package exec

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/btree"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

var update = flag.Bool("update", false, "rewrite golden files")

func openTemp(t *testing.T, opts Options) (*DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.db")
	opts.Pager.NoSync = true
	db, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, path
}

// splitStatements cuts a script at semicolons outside quotes.
func splitStatements(script string) []string {
	var out []string
	var cur strings.Builder
	inStr := false
	for i := 0; i < len(script); i++ {
		c := script[i]
		cur.WriteByte(c)
		switch {
		case c == '\'':
			inStr = !inStr
		case c == ';' && !inStr:
			if s := strings.TrimSpace(cur.String()); s != "" {
				out = append(out, s)
			}
			cur.Reset()
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		out = append(out, s)
	}
	return out
}

// runScript executes each statement and returns a transcript.
func runScript(db *DB, script string) string {
	var out bytes.Buffer
	for _, st := range splitStatements(script) {
		out.WriteString("> " + strings.ReplaceAll(st, "\n", "\n  ") + "\n")
		if err := db.Run(st, &out); err != nil {
			out.WriteString("Error: " + err.Error() + "\n")
		}
	}
	return out.String()
}

func TestGolden(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.sql")
	if len(files) == 0 {
		t.Fatal("no golden scripts found")
	}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".sql")
		t.Run(name, func(t *testing.T) {
			script, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			db, _ := openTemp(t, Options{})
			got := runScript(db, string(script))
			golden := strings.TrimSuffix(f, ".sql") + ".golden"
			if *update {
				os.WriteFile(golden, []byte(got), 0o644)
				return
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("missing golden file (run with -update): %v", err)
			}
			if got != string(want) {
				t.Errorf("output differs from %s\n--- got ---\n%s\n--- want ---\n%s", golden, got, want)
			}
		})
	}
}

// Golden scripts must give identical output when the tree is forced to use
// tiny nodes (many splits, several levels).
func TestGoldenWithTinyNodes(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.sql")
	for _, f := range files {
		script, _ := os.ReadFile(f)
		a, _ := openTemp(t, Options{})
		b, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 2, MaxInternalKeys: 2}})
		if x, y := runScript(a, string(script)), runScript(b, string(script)); x != y {
			t.Errorf("%s: tiny-node output differs\n%s\nvs\n%s", f, x, y)
		}
	}
}

func mustRun(t *testing.T, db *DB, src string) string {
	t.Helper()
	var out bytes.Buffer
	if err := db.Run(src, &out); err != nil {
		t.Fatalf("%s\n-> %v", src, err)
	}
	return out.String()
}

func runErr(t *testing.T, db *DB, src string) string {
	t.Helper()
	var out bytes.Buffer
	err := db.Run(src, &out)
	if err == nil {
		t.Fatalf("expected an error from %q, got output %q", src, out.String())
	}
	return err.Error()
}

func TestDataSurvivesReopen(t *testing.T) {
	db, path := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE a (id INTEGER PRIMARY KEY, s TEXT); CREATE TABLE b (id INTEGER PRIMARY KEY, x REAL);")
	for i := 0; i < 300; i++ {
		mustRun(t, db, "INSERT INTO a VALUES ("+itoa(i)+", 'row "+itoa(i)+"');")
	}
	mustRun(t, db, "INSERT INTO b VALUES (1, 2.5);")
	db.Close()

	db2, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if got := strings.Join(db2.Tables(), ","); got != "a,b" {
		t.Errorf("tables = %s", got)
	}
	out := mustRun(t, db2, "SELECT COUNT(*), MAX(s) FROM a; SELECT x FROM b;")
	if !strings.Contains(out, "300") || !strings.Contains(out, "row 99") || !strings.Contains(out, "2.5") {
		t.Errorf("out = %s", out)
	}
}

func itoa(i int) string { return strconv.Itoa(i) }

func TestLargeTableThroughSQL(t *testing.T) {
	db, _ := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE n (id INTEGER PRIMARY KEY, v INTEGER);")
	var sb strings.Builder
	sb.WriteString("INSERT INTO n VALUES ")
	for i := 1; i <= 2000; i++ {
		if i > 1 {
			sb.WriteString(", ")
		}
		sb.WriteString("(" + fmtInt(i) + ", " + fmtInt(i%7) + ")")
	}
	mustRun(t, db, sb.String()+";")
	out := mustRun(t, db, "SELECT COUNT(*), SUM(v), MIN(id), MAX(id) FROM n;")
	if !strings.Contains(out, "2000     | 6000   | 1       | 2000") {
		t.Errorf("aggregates: %s", out)
	}
	out = mustRun(t, db, "SELECT id FROM n WHERE id >= 1500 AND id <= 1503;")
	if !strings.Contains(out, "1500\n1501\n1502\n1503\n(4 rows)") {
		t.Errorf("range: %s", out)
	}
	out = mustRun(t, db, "SELECT id FROM n WHERE v = 3 ORDER BY id DESC LIMIT 2;")
	if !strings.Contains(out, "1998\n1991") {
		t.Errorf("filter/order/limit: %s", out)
	}
}

func fmtInt(i int) string { return strconv.Itoa(i) }

func TestMetaHelpers(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 3, MaxInternalKeys: 3}})
	if s, err := db.Schema(""); err != nil || s != "" {
		t.Errorf("empty schema: %q %v", s, err)
	}
	mustRun(t, db, "CREATE TABLE a (id INTEGER PRIMARY KEY, n TEXT); CREATE TABLE B (k INTEGER PRIMARY KEY);")
	for i := 1; i <= 30; i++ {
		mustRun(t, db, "INSERT INTO a (n) VALUES ('x');")
	}
	s, _ := db.Schema("")
	if s != "CREATE TABLE a (id INTEGER PRIMARY KEY, n TEXT);\nCREATE TABLE B (k INTEGER PRIMARY KEY);" {
		t.Errorf("schema = %q", s)
	}
	if s, err := db.Schema("A"); err != nil || !strings.HasPrefix(s, "CREATE TABLE a") {
		t.Errorf("%q %v", s, err)
	}
	if _, err := db.Schema("zzz"); err == nil {
		t.Error("schema of missing table")
	}
	var buf bytes.Buffer
	if err := db.BTree("a", &buf); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"table a:", "30 rows", "[internal #", "[leaf #"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("btree output lacks %q:\n%s", want, buf.String())
		}
	}
	if err := db.BTree("zzz", &buf); err == nil {
		t.Error("btree of missing table")
	}
	st := db.Stats()
	for _, want := range []string{"page size:     4096", "pages:", "tables:        2"} {
		if !strings.Contains(st, want) {
			t.Errorf("stats lack %q:\n%s", want, st)
		}
	}
}

func TestEarlyLimitStopsScan(t *testing.T) {
	db, _ := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE n (id INTEGER PRIMARY KEY, v INTEGER);")
	mustRun(t, db, "INSERT INTO n VALUES (1,1),(2,2),(3,3),(4,4),(5,5);")
	if out := mustRun(t, db, "SELECT id FROM n LIMIT 0;"); !strings.Contains(out, "(0 rows)") {
		t.Errorf("LIMIT 0: %s", out)
	}
	if out := mustRun(t, db, "SELECT id FROM n LIMIT 2 OFFSET 10;"); !strings.Contains(out, "(0 rows)") {
		t.Errorf("OFFSET past end: %s", out)
	}
	if out := mustRun(t, db, "SELECT id FROM n LIMIT 2 OFFSET 3;"); !strings.Contains(out, "4\n5\n(2 rows)") {
		t.Errorf("LIMIT/OFFSET: %s", out)
	}
}

func TestExecRejectsUnsupportedStatement(t *testing.T) {
	db, _ := openTemp(t, Options{})
	if msg := runErr(t, db, "BEGIN;"); !strings.Contains(msg, "not supported") {
		t.Errorf("msg = %s", msg)
	}
}

func TestRowTooLarge(t *testing.T) {
	db, _ := openTemp(t, Options{})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT);")
	big := strings.Repeat("x", 2000)
	if msg := runErr(t, db, "INSERT INTO t VALUES (1, '"+big+"');"); !strings.Contains(msg, "row too large") {
		t.Errorf("msg = %s", msg)
	}
}

func TestOpenRejectsForeignFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	os.WriteFile(path, bytes.Repeat([]byte("not a database "), 1000), 0o644)
	if _, err := Open(path, Options{}); err == nil || !strings.Contains(err.Error(), "bad magic") {
		t.Errorf("err = %v", err)
	}
	_ = pager.PageSize
}

func mustParse(t *testing.T, src string) sql.Stmt {
	t.Helper()
	st, err := sql.ParseOne(src)
	if err != nil {
		t.Fatal(err)
	}
	return st
}
