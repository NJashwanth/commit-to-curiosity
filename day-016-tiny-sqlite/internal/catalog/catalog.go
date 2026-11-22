// Package catalog stores table definitions in page 1 of the database file.
//
// Page 1 layout (little endian):
//
//	u16 table count
//	per table: u8 name length, name, u32 root page, u16 column count,
//	           per column: u8 name length, name, u8 type, u8 primary-key flag
//
// An all-zero page is an empty catalog.
package catalog

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/pager"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
)

var (
	ErrExists   = errors.New("table already exists")
	ErrNotFound = errors.New("no such table")
	ErrFull     = errors.New("schema catalog page is full")
	ErrCorrupt  = errors.New("schema catalog is corrupt")
)

// Column is one column of a table.
type Column struct {
	Name       string
	Type       record.Kind // Integer, Real or Text
	PrimaryKey bool
}

// Table describes a table and where its B+tree lives.
type Table struct {
	Name    string
	Columns []Column
	Root    uint32 // root page of the table's B+tree
}

// PKIndex returns the index of the INTEGER PRIMARY KEY column.
func (t *Table) PKIndex() int {
	for i, c := range t.Columns {
		if c.PrimaryKey {
			return i
		}
	}
	return -1
}

// ColumnIndex finds a column by case-insensitive name, or returns -1.
func (t *Table) ColumnIndex(name string) int {
	for i, c := range t.Columns {
		if strings.EqualFold(c.Name, name) {
			return i
		}
	}
	return -1
}

// Schema renders the CREATE TABLE statement for the table.
func (t *Table) Schema() string {
	parts := make([]string, len(t.Columns))
	for i, c := range t.Columns {
		parts[i] = c.Name + " " + c.Type.String()
		if c.PrimaryKey {
			parts[i] += " PRIMARY KEY"
		}
	}
	return "CREATE TABLE " + t.Name + " (" + strings.Join(parts, ", ") + ");"
}

// Validate checks a table definition before it is stored.
func (t *Table) Validate() error {
	if t.Name == "" || len(t.Name) > 255 {
		return fmt.Errorf("invalid table name %q", t.Name)
	}
	if len(t.Columns) == 0 {
		return fmt.Errorf("table %s needs at least one column", t.Name)
	}
	pks := 0
	seen := map[string]bool{}
	for _, c := range t.Columns {
		if c.Name == "" || len(c.Name) > 255 {
			return fmt.Errorf("invalid column name %q", c.Name)
		}
		key := strings.ToLower(c.Name)
		if seen[key] {
			return fmt.Errorf("duplicate column name %q", c.Name)
		}
		seen[key] = true
		if c.Type != record.Integer && c.Type != record.Real && c.Type != record.Text {
			return fmt.Errorf("column %s has invalid type", c.Name)
		}
		if c.PrimaryKey {
			pks++
			if c.Type != record.Integer {
				return fmt.Errorf("PRIMARY KEY column %s must be INTEGER", c.Name)
			}
		}
	}
	if pks != 1 {
		return fmt.Errorf("table %s must declare exactly one INTEGER PRIMARY KEY column", t.Name)
	}
	return nil
}

// Catalog is the in-memory copy of page 1.
type Catalog struct {
	p      *pager.Pager
	tables map[string]*Table // lower-case name -> table
}

// Load reads the catalog from page 1.
func Load(p *pager.Pager) (*Catalog, error) {
	c := &Catalog{p: p}
	if err := c.Reload(); err != nil {
		return nil, err
	}
	return c, nil
}

// Reload discards the in-memory copy and re-reads page 1. Call it after the
// pager rolls changes back.
func (c *Catalog) Reload() error {
	buf, err := c.p.Get(pager.CatalogPage)
	if err != nil {
		return err
	}
	tables, err := decode(buf)
	if err != nil {
		return err
	}
	c.tables = tables
	return nil
}

func decode(buf []byte) (map[string]*Table, error) {
	tables := map[string]*Table{}
	pos := 0
	need := func(n int) error {
		if pos+n > len(buf) {
			return fmt.Errorf("%w: truncated", ErrCorrupt)
		}
		return nil
	}
	str := func() (string, error) {
		if err := need(1); err != nil {
			return "", err
		}
		n := int(buf[pos])
		pos++
		if err := need(n); err != nil {
			return "", err
		}
		s := string(buf[pos : pos+n])
		pos += n
		return s, nil
	}
	if err := need(2); err != nil {
		return nil, err
	}
	n := int(binary.LittleEndian.Uint16(buf))
	pos = 2
	for i := 0; i < n; i++ {
		name, err := str()
		if err != nil {
			return nil, err
		}
		if err := need(6); err != nil {
			return nil, err
		}
		t := &Table{Name: name, Root: binary.LittleEndian.Uint32(buf[pos:])}
		nc := int(binary.LittleEndian.Uint16(buf[pos+4:]))
		pos += 6
		for j := 0; j < nc; j++ {
			cn, err := str()
			if err != nil {
				return nil, err
			}
			if err := need(2); err != nil {
				return nil, err
			}
			t.Columns = append(t.Columns, Column{Name: cn, Type: record.Kind(buf[pos]), PrimaryKey: buf[pos+1] == 1})
			pos += 2
		}
		if err := t.Validate(); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		tables[strings.ToLower(name)] = t
	}
	return tables, nil
}

func encode(tables map[string]*Table) ([]byte, error) {
	names := make([]string, 0, len(tables))
	for k := range tables {
		names = append(names, k)
	}
	sort.Strings(names)
	buf := binary.LittleEndian.AppendUint16(nil, uint16(len(names)))
	for _, k := range names {
		t := tables[k]
		buf = append(buf, byte(len(t.Name)))
		buf = append(buf, t.Name...)
		buf = binary.LittleEndian.AppendUint32(buf, t.Root)
		buf = binary.LittleEndian.AppendUint16(buf, uint16(len(t.Columns)))
		for _, col := range t.Columns {
			buf = append(buf, byte(len(col.Name)))
			buf = append(buf, col.Name...)
			pk := byte(0)
			if col.PrimaryKey {
				pk = 1
			}
			buf = append(buf, byte(col.Type), pk)
		}
	}
	if len(buf) > pager.PageSize {
		return nil, fmt.Errorf("%w (%d bytes needed, %d available)", ErrFull, len(buf), pager.PageSize)
	}
	return buf, nil
}

// save writes tables to page 1 and, on success, makes them current.
func (c *Catalog) save(tables map[string]*Table) error {
	buf, err := encode(tables)
	if err != nil {
		return err
	}
	page, err := c.p.Write(pager.CatalogPage)
	if err != nil {
		return err
	}
	clear(page)
	copy(page, buf)
	c.tables = tables
	return nil
}

func (c *Catalog) clone() map[string]*Table {
	m := make(map[string]*Table, len(c.tables)+1)
	for k, v := range c.tables {
		m[k] = v
	}
	return m
}

// Create validates and stores a new table.
func (c *Catalog) Create(t Table) error {
	if err := t.Validate(); err != nil {
		return err
	}
	key := strings.ToLower(t.Name)
	if _, ok := c.tables[key]; ok {
		return fmt.Errorf("%w: %s", ErrExists, t.Name)
	}
	m := c.clone()
	cp := t
	cp.Columns = append([]Column(nil), t.Columns...)
	m[key] = &cp
	return c.save(m)
}

// Drop removes a table definition and returns it (so the caller can free its pages).
func (c *Catalog) Drop(name string) (*Table, error) {
	key := strings.ToLower(name)
	t, ok := c.tables[key]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	m := c.clone()
	delete(m, key)
	if err := c.save(m); err != nil {
		return nil, err
	}
	return t, nil
}

// Get looks a table up by case-insensitive name.
func (c *Catalog) Get(name string) (*Table, bool) {
	t, ok := c.tables[strings.ToLower(name)]
	return t, ok
}

// Names lists table names in alphabetical order.
func (c *Catalog) Names() []string {
	names := make([]string, 0, len(c.tables))
	for _, t := range c.tables {
		names = append(names, t.Name)
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	return names
}
