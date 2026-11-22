package main

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

type fakeDB struct {
	ran    []string
	tables []string
	closed bool
}

func (f *fakeDB) Run(src string, w io.Writer) error {
	f.ran = append(f.ran, strings.TrimSpace(src))
	if strings.Contains(src, "boom") {
		return errors.New("kaboom")
	}
	io.WriteString(w, "ok\n")
	return nil
}
func (f *fakeDB) Tables() []string { return f.tables }
func (f *fakeDB) Schema(name string) (string, error) {
	if name == "nope" {
		return "", errors.New("no such table: nope")
	}
	if len(f.tables) == 0 {
		return "", nil
	}
	return "CREATE TABLE t (id INTEGER PRIMARY KEY);", nil
}
func (f *fakeDB) BTree(name string, w io.Writer) error {
	if name == "nope" {
		return errors.New("no such table: nope")
	}
	io.WriteString(w, "leaf #2\n")
	return nil
}
func (f *fakeDB) Stats() string { return "pages: 2\n" }
func (f *fakeDB) Close() error  { f.closed = true; return nil }

func runREPL(t *testing.T, db *fakeDB, input string, echo bool) string {
	t.Helper()
	var out bytes.Buffer
	r := &REPL{db: db, out: &out, echo: echo}
	r.Loop(strings.NewReader(input))
	return out.String()
}

func TestMultiLineInputUntilSemicolon(t *testing.T) {
	db := &fakeDB{}
	out := runREPL(t, db, "SELECT *\nFROM t\nWHERE x = 'a;b'\n;\n", false)
	if len(db.ran) != 1 {
		t.Fatalf("want 1 statement, got %d: %q", len(db.ran), db.ran)
	}
	if !strings.Contains(db.ran[0], "FROM t") || !strings.HasSuffix(db.ran[0], ";") {
		t.Errorf("statement not joined: %q", db.ran[0])
	}
	if out != "ok\n" {
		t.Errorf("out = %q", out)
	}
}

func TestSemicolonInsideStringDoesNotEndStatement(t *testing.T) {
	db := &fakeDB{}
	runREPL(t, db, "INSERT INTO t VALUES ('it''s; fine'\n);\n", false)
	if len(db.ran) != 1 {
		t.Fatalf("ran = %q", db.ran)
	}
}

func TestComplete(t *testing.T) {
	cases := map[string]bool{
		"":                        false,
		"SELECT 1":                false,
		"SELECT 1;":               true,
		"SELECT 1;  \n":           true,
		"SELECT 'a;":              false,
		"SELECT 'a;';":            true,
		"SELECT 'it''s;'":         false,
		"SELECT 'it''s';":         true,
		"SELECT 1; SELECT 2":      false,
		"SELECT 1; SELECT 2;":     true,
		"SELECT 'x' ;":            true,
		"INSERT INTO t VALUES ('": false,
	}
	for src, want := range cases {
		if got := Complete(src); got != want {
			t.Errorf("Complete(%q) = %v, want %v", src, got, want)
		}
	}
}

func TestErrorsArePrinted(t *testing.T) {
	out := runREPL(t, &fakeDB{}, "boom;\n", false)
	if out != "Error: kaboom\n" {
		t.Errorf("out = %q", out)
	}
}

func TestIncompleteStatementAtEOF(t *testing.T) {
	out := runREPL(t, &fakeDB{}, "SELECT 1", false)
	if !strings.Contains(out, "incomplete statement") {
		t.Errorf("out = %q", out)
	}
}

func TestMetaCommands(t *testing.T) {
	db := &fakeDB{}
	out := runREPL(t, db, ".tables\n.schema\n.stats\n.btree t\n.btree\n.btree nope\n.schema nope\n.bogus\n.help\n", false)
	for _, want := range []string{
		"(no tables)",
		"pages: 2",
		"leaf #2",
		"usage: .btree <table>",
		"Error: no such table: nope",
		"unknown command .bogus",
		".schema [table]",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
	db.tables = []string{"a", "b"}
	out = runREPL(t, db, ".tables\n.schema a\n", false)
	if !strings.Contains(out, "a  b") || !strings.Contains(out, "CREATE TABLE t") {
		t.Errorf("out = %q", out)
	}
}

func TestExitStopsLoop(t *testing.T) {
	db := &fakeDB{}
	runREPL(t, db, ".exit\nSELECT 1;\n", false)
	if len(db.ran) != 0 {
		t.Errorf("statement ran after .exit: %q", db.ran)
	}
	runREPL(t, db, ".quit\nSELECT 1;\n", false)
	if len(db.ran) != 0 {
		t.Errorf("statement ran after .quit: %q", db.ran)
	}
}

func TestMetaCommandsNotRecognisedMidStatement(t *testing.T) {
	db := &fakeDB{}
	runREPL(t, db, "SELECT\n.exit\n;\n", false)
	if len(db.ran) != 1 {
		t.Errorf("ran = %q", db.ran)
	}
}

func TestTimer(t *testing.T) {
	out := runREPL(t, &fakeDB{}, ".timer on\nSELECT 1;\n.timer off\nSELECT 2;\n.timer maybe\n", false)
	if strings.Count(out, "Run time:") != 1 {
		t.Errorf("out = %q", out)
	}
	if !strings.Contains(out, "usage: .timer on|off") {
		t.Errorf("missing usage: %q", out)
	}
}

func TestEchoAndPrompts(t *testing.T) {
	out := runREPL(t, &fakeDB{}, "SELECT 1\n;\n\n", true)
	want := "tinysql> SELECT 1\n     ...> ;\nok\ntinysql> \ntinysql> "
	if out != want {
		t.Errorf("out = %q\nwant  %q", out, want)
	}
}

func TestRunUsageAndOpen(t *testing.T) {
	var out, errw bytes.Buffer
	if code := run(nil, strings.NewReader(""), &out, &errw); code != 2 {
		t.Errorf("no args: code %d", code)
	}
	if !strings.Contains(errw.String(), "usage: tinysql") {
		t.Errorf("stderr = %q", errw.String())
	}
	errw.Reset()
	if code := run([]string{"-nope"}, strings.NewReader(""), &out, &errw); code != 2 {
		t.Errorf("bad flag: code %d", code)
	}
	errw.Reset()
	out.Reset()
	code := run([]string{"-echo", "x.db"}, strings.NewReader(".tables\n.exit\n"), &out, &errw)
	if code != 0 {
		t.Fatalf("code %d, stderr %q", code, errw.String())
	}
	if !strings.Contains(out.String(), "(no tables)") {
		t.Errorf("out = %q", out.String())
	}
}

func TestIsTerminal(t *testing.T) {
	if isTerminal(strings.NewReader("")) {
		t.Error("strings.Reader is not a terminal")
	}
	if isTerminal(io.NopCloser(strings.NewReader(""))) {
		t.Error("NopCloser is not a terminal")
	}
}

func TestStubDB(t *testing.T) {
	db, err := openDatabase("x")
	if err != nil {
		t.Fatal(err)
	}
	if db.Run("SELECT 1;", io.Discard) == nil {
		t.Error("stub should error")
	}
	if db.BTree("t", io.Discard) == nil {
		t.Error("stub btree should error")
	}
	if _, err := db.Schema(""); err != nil {
		t.Error(err)
	}
	if db.Stats() == "" || db.Tables() != nil || db.Close() != nil {
		t.Error("stub misbehaves")
	}
}
