package exec

import (
	"errors"
	"fmt"
	"math"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/btree"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/catalog"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

// matchingRows collects the key and decoded row of every row satisfying where.
// Rows are gathered before any modification so that the scan never runs over a
// tree that is being changed underneath it.
func matchingRows(tbl *catalog.Table, tree *btree.Tree, where sql.Expr) (keys []int64, rows [][]record.Value, err error) {
	cmp := &compiler{cols: tbl.Columns}
	var pred evalFn
	lo, hi := int64(math.MinInt64), int64(math.MaxInt64)
	if where != nil {
		if pred, err = cmp.compile(where); err != nil {
			return nil, nil, err
		}
		var empty bool
		if lo, hi, empty = pkBounds(where, tbl.Columns[tbl.PKIndex()].Name); empty {
			return nil, nil, nil
		}
	}
	var cbErr error
	err = tree.Scan(lo, hi, func(key int64, val []byte) bool {
		row, err := record.Decode(val)
		if err != nil {
			cbErr = err
			return false
		}
		if pred != nil {
			v, err := pred(row)
			if err != nil {
				cbErr = err
				return false
			}
			if v.IsNull() {
				return true
			}
			ok, err := truthy(v)
			if err != nil {
				cbErr = err
				return false
			}
			if !ok {
				return true
			}
		}
		keys = append(keys, key)
		rows = append(rows, row)
		return true
	})
	if cbErr != nil {
		return nil, nil, cbErr
	}
	return keys, rows, err
}

func (db *DB) update(s *sql.Update) (*Result, error) {
	tbl, tree, err := db.table(s.Table, s.Pos)
	if err != nil {
		return nil, err
	}
	pk := tbl.PKIndex()
	cmp := &compiler{cols: tbl.Columns}
	type assign struct {
		col int
		fn  evalFn
	}
	var assigns []assign
	seen := map[int]bool{}
	for _, a := range s.Set {
		i := tbl.ColumnIndex(a.Column)
		if i < 0 {
			return nil, posErrorf(a.Pos, "table %s has no column %s", tbl.Name, a.Column)
		}
		if seen[i] {
			return nil, posErrorf(a.Pos, "column %s is assigned twice", a.Column)
		}
		seen[i] = true
		fn, err := cmp.compile(a.Value)
		if err != nil {
			return nil, err
		}
		assigns = append(assigns, assign{i, fn})
	}

	keys, rows, err := matchingRows(tbl, tree, s.Where)
	if err != nil {
		return nil, err
	}
	for n, old := range rows {
		row := append([]record.Value(nil), old...)
		for _, a := range assigns {
			v, err := a.fn(old) // every expression sees the original row
			if err != nil {
				return nil, err
			}
			if v, err = coerce(v, tbl.Columns[a.col]); err != nil {
				return nil, err
			}
			row[a.col] = v
		}
		if row[pk].IsNull() {
			return nil, fmt.Errorf("primary key %s cannot be NULL", tbl.Columns[pk].Name)
		}
		payload, err := encodeRow(row)
		if err != nil {
			return nil, err
		}
		if newKey := row[pk].Int; newKey != keys[n] {
			// The key changes, so the row moves within the tree.
			if _, err := tree.Get(newKey); err == nil {
				return nil, fmt.Errorf("duplicate primary key %d in table %s", newKey, tbl.Name)
			} else if !errors.Is(err, btree.ErrNotFound) {
				return nil, err
			}
			if err := tree.Delete(keys[n]); err != nil {
				return nil, err
			}
			if err := tree.Insert(newKey, payload); err != nil {
				return nil, err
			}
		} else if err := tree.Update(keys[n], payload); err != nil {
			return nil, err
		}
	}
	return &Result{Message: plural(len(rows), "row") + " updated."}, nil
}

func (db *DB) delete(s *sql.Delete) (*Result, error) {
	tbl, tree, err := db.table(s.Table, s.Pos)
	if err != nil {
		return nil, err
	}
	keys, _, err := matchingRows(tbl, tree, s.Where)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		if err := tree.Delete(k); err != nil {
			return nil, err
		}
	}
	return &Result{Message: plural(len(keys), "row") + " deleted."}, nil
}

func (db *DB) dropTable(s *sql.DropTable) (*Result, error) {
	t, ok := db.cat.Get(s.Name)
	if !ok {
		if s.IfExists {
			return &Result{Message: fmt.Sprintf("Table %s does not exist.", s.Name)}, nil
		}
		return nil, fmt.Errorf("no such table: %s", s.Name)
	}
	if err := btree.Open(db.p, t.Root, db.treeCfg).Destroy(); err != nil {
		return nil, err
	}
	if _, err := db.cat.Drop(s.Name); err != nil {
		return nil, err
	}
	return &Result{Message: fmt.Sprintf("Table %s dropped.", s.Name)}, nil
}
