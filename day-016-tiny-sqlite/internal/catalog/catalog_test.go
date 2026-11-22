package catalog

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
)

func newCatalog(t *testing.T) (*Catalog, *pager.Pager, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c.db")
	p, err := pager.Open(path, pager.Options{NoSync: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	return c, p, path
}

func users() Table {
	return Table{Name: "users", Root: 2, Columns: []Column{
		{"id", record.Integer, true}, {"name", record.Text, false},
		{"age", record.Integer, false}, {"score", record.Real, false},
	}}
}

func TestEmptyCatalog(t *testing.T) {
	c, _, _ := newCatalog(t)
	if len(c.Names()) != 0 {
		t.Error("new database should have no tables")
	}
	if _, ok := c.Get("users"); ok {
		t.Error("Get on empty")
	}
}

func TestCreateGetPersistAcrossReopen(t *testing.T) {
	c, p, path := newCatalog(t)
	if err := c.Create(users()); err != nil {
		t.Fatal(err)
	}
	if err := c.Create(Table{Name: "Events", Root: 9, Columns: []Column{{"k", record.Integer, true}}}); err != nil {
		t.Fatal(err)
	}
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	p.Close()

	p2, err := pager.Open(path, pager.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p2.Close()
	c2, err := Load(p2)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(c2.Names(), ","); got != "Events,users" {
		t.Errorf("Names = %s", got)
	}
	tbl, ok := c2.Get("USERS")
	if !ok || tbl.Root != 2 || len(tbl.Columns) != 4 {
		t.Fatalf("%+v %v", tbl, ok)
	}
	if tbl.Columns[3].Type != record.Real || tbl.Columns[0].PrimaryKey != true || tbl.Columns[1].PrimaryKey {
		t.Errorf("columns: %+v", tbl.Columns)
	}
	if tbl.PKIndex() != 0 || tbl.ColumnIndex("AGE") != 2 || tbl.ColumnIndex("nope") != -1 {
		t.Error("index helpers")
	}
}

func TestCatalogLivesOnPageOne(t *testing.T) {
	c, p, path := newCatalog(t)
	c.Create(users())
	p.Flush()
	p.Close()
	raw := mustRead(t, path)
	page1 := raw[pager.PageSize : 2*pager.PageSize]
	if n := binary.LittleEndian.Uint16(page1); n != 1 {
		t.Errorf("table count on page 1 = %d", n)
	}
	if !strings.Contains(string(page1), "users") {
		t.Error("table name not on page 1")
	}
}

func TestSchemaText(t *testing.T) {
	u := users()
	want := "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL);"
	if got := u.Schema(); got != want {
		t.Errorf("got %s", got)
	}
}

func TestCreateErrors(t *testing.T) {
	c, _, _ := newCatalog(t)
	if err := c.Create(users()); err != nil {
		t.Fatal(err)
	}
	if err := c.Create(Table{Name: "USERS", Columns: []Column{{"id", record.Integer, true}}}); !errors.Is(err, ErrExists) {
		t.Errorf("duplicate (case-insensitive): %v", err)
	}
	bad := map[string]Table{
		"no columns":   {Name: "t"},
		"no name":      {Name: "", Columns: []Column{{"id", record.Integer, true}}},
		"no pk":        {Name: "t", Columns: []Column{{"a", record.Integer, false}}},
		"two pks":      {Name: "t", Columns: []Column{{"a", record.Integer, true}, {"b", record.Integer, true}}},
		"text pk":      {Name: "t", Columns: []Column{{"a", record.Text, true}}},
		"dup column":   {Name: "t", Columns: []Column{{"a", record.Integer, true}, {"A", record.Text, false}}},
		"empty column": {Name: "t", Columns: []Column{{"", record.Integer, true}}},
		"null type":    {Name: "t", Columns: []Column{{"a", record.Integer, true}, {"b", record.Null, false}}},
		"long name":    {Name: strings.Repeat("x", 256), Columns: []Column{{"a", record.Integer, true}}},
	}
	for name, tbl := range bad {
		if err := c.Create(tbl); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if len(c.Names()) != 1 {
		t.Errorf("failed creates must not change the catalog: %v", c.Names())
	}
}

func TestDrop(t *testing.T) {
	c, p, path := newCatalog(t)
	c.Create(users())
	c.Create(Table{Name: "b", Root: 5, Columns: []Column{{"id", record.Integer, true}}})
	tbl, err := c.Drop("Users")
	if err != nil || tbl.Root != 2 {
		t.Fatalf("%+v %v", tbl, err)
	}
	if _, err := c.Drop("users"); !errors.Is(err, ErrNotFound) {
		t.Errorf("second drop: %v", err)
	}
	p.Flush()
	p.Close()
	p2, _ := pager.Open(path, pager.Options{})
	defer p2.Close()
	c2, _ := Load(p2)
	if got := c2.Names(); len(got) != 1 || got[0] != "b" {
		t.Errorf("after reopen: %v", got)
	}
}

func TestReloadRereadsPageOne(t *testing.T) {
	c, p, _ := newCatalog(t)
	c.Create(users())
	p.Flush()
	c.Create(Table{Name: "tmp", Root: 7, Columns: []Column{{"id", record.Integer, true}}})
	// Simulate the pager dropping the unflushed page: reload from what the page says now.
	if len(c.Names()) != 2 {
		t.Fatal("setup")
	}
	if err := c.Reload(); err != nil {
		t.Fatal(err)
	}
	if len(c.Names()) != 2 { // page 1 in cache still holds tmp since Write mutated it
		t.Errorf("Reload reads the current page: %v", c.Names())
	}
}

func TestCatalogFull(t *testing.T) {
	c, _, _ := newCatalog(t)
	var err error
	n := 0
	for ; err == nil && n < 1000; n++ {
		err = c.Create(Table{Name: fmt.Sprintf("table_with_a_long_name_%04d", n), Root: uint32(n + 2),
			Columns: []Column{{"id", record.Integer, true}, {"payload", record.Text, false}}})
	}
	if !errors.Is(err, ErrFull) {
		t.Fatalf("err = %v after %d tables", err, n)
	}
	if got := len(c.Names()); got != n-1 {
		t.Errorf("failed create left %d tables, want %d", got, n-1)
	}
}

func TestCorruptCatalogRejected(t *testing.T) {
	c, p, _ := newCatalog(t)
	page, _ := p.Write(pager.CatalogPage)
	page[0] = 1 // claims one table, but nothing follows
	if err := c.Reload(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("truncated entry: %v", err)
	}
	clear(page)
	page[0] = 1
	page[2] = 200 // name length beyond page
	for i := 3; i < len(page); i++ {
		page[i] = 0
	}
	page[pager.PageSize-1] = 0
	if err := c.Reload(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("bad length: %v", err)
	}
	// Valid framing but invalid definition (no primary key).
	clear(page)
	buf := []byte{1, 0, 1, 't', 2, 0, 0, 0, 1, 0, 1, 'a', byte(record.Integer), 0}
	copy(page, buf)
	if err := c.Reload(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("invalid table: %v", err)
	}
	if _, err := Load(p); !errors.Is(err, ErrCorrupt) {
		t.Errorf("Load: %v", err)
	}
}

func TestDecodeTruncationEverywhere(t *testing.T) {
	buf, err := encode(map[string]*Table{"users": func() *Table { u := users(); return &u }()})
	if err != nil {
		t.Fatal(err)
	}
	for cut := 0; cut < len(buf); cut++ {
		if _, err := decode(buf[:cut]); err == nil {
			t.Errorf("cut at %d accepted", cut)
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
