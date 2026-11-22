package exec

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/btree"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/catalog"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

// coerce checks v against a column's declared type. INTEGER columns take
// integers (or reals with an exact integer value), REAL columns take any
// number, TEXT columns take text. NULL is accepted everywhere here; the
// primary key rules are applied by the caller.
func coerce(v record.Value, col catalog.Column) (record.Value, error) {
	if v.IsNull() {
		return v, nil
	}
	switch col.Type {
	case record.Integer:
		switch v.Kind {
		case record.Integer:
			return v, nil
		case record.Real:
			if v.Real == math.Trunc(v.Real) && v.Real >= -9.2e18 && v.Real <= 9.2e18 {
				return record.NewInt(int64(v.Real)), nil
			}
		}
	case record.Real:
		switch v.Kind {
		case record.Real:
			return v, nil
		case record.Integer:
			return record.NewReal(float64(v.Int)), nil
		}
	case record.Text:
		if v.Kind == record.Text {
			return v, nil
		}
	}
	return v, fmt.Errorf("type mismatch: column %q is %s, got %s %s", col.Name, col.Type, v.Kind, quoteForError(v))
}

func quoteForError(v record.Value) string {
	if v.Kind == record.Text {
		return "'" + strings.ReplaceAll(v.Text, "'", "''") + "'"
	}
	return v.String()
}

// encodeRow serializes a row and reports an error if it cannot fit in a leaf.
func encodeRow(row []record.Value) ([]byte, error) {
	b := record.Encode(row)
	if len(b) > btree.MaxPayload {
		return nil, fmt.Errorf("row too large: %d bytes encoded (max %d)", len(b), btree.MaxPayload)
	}
	return b, nil
}

func (db *DB) insert(s *sql.Insert) (*Result, error) {
	tbl, tree, err := db.table(s.Table, s.Pos)
	if err != nil {
		return nil, err
	}
	pk := tbl.PKIndex()

	// Map each supplied value to a table column.
	targets := make([]int, 0, len(tbl.Columns))
	if len(s.Columns) == 0 {
		for i := range tbl.Columns {
			targets = append(targets, i)
		}
	} else {
		seen := map[int]bool{}
		for _, name := range s.Columns {
			i := tbl.ColumnIndex(name)
			if i < 0 {
				return nil, posErrorf(s.Pos, "table %s has no column %s", tbl.Name, name)
			}
			if seen[i] {
				return nil, posErrorf(s.Pos, "column %s listed twice", name)
			}
			seen[i] = true
			targets = append(targets, i)
		}
	}

	// Compile value expressions (no columns are in scope in VALUES).
	cmp := &compiler{}
	exprs := make([][]evalFn, len(s.Rows))
	for r, row := range s.Rows {
		if len(row) != len(targets) {
			return nil, posErrorf(s.Pos, "row %d has %s but %s expected", r+1, plural(len(row), "value"), plural(len(targets), "value"))
		}
		for _, e := range row {
			fn, err := cmp.compile(e)
			if err != nil {
				return nil, err
			}
			exprs[r] = append(exprs[r], fn)
		}
	}

	inserted := 0
	for r := range exprs {
		row := make([]record.Value, len(tbl.Columns))
		for j, fn := range exprs[r] {
			v, err := fn(nil)
			if err != nil {
				return nil, err
			}
			col := tbl.Columns[targets[j]]
			if row[targets[j]], err = coerce(v, col); err != nil {
				return nil, err
			}
		}
		if row[pk].IsNull() { // omitted or NULL: next free key
			max, ok, err := tree.Max()
			if err != nil {
				return nil, err
			}
			next := int64(1)
			if ok {
				if max == math.MaxInt64 {
					return nil, errors.New("primary key space exhausted")
				}
				next = max + 1
			}
			row[pk] = record.NewInt(next)
		}
		payload, err := encodeRow(row)
		if err != nil {
			return nil, err
		}
		if err := tree.Insert(row[pk].Int, payload); err != nil {
			if errors.Is(err, btree.ErrDuplicate) {
				return nil, fmt.Errorf("duplicate primary key %d in table %s", row[pk].Int, tbl.Name)
			}
			return nil, err
		}
		inserted++
	}
	return &Result{Message: plural(inserted, "row") + " inserted."}, nil
}

func plural(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
