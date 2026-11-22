package exec

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/catalog"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

type selectItem struct {
	name    string
	aliased bool // name came from an AS alias
	fn      evalFn
}

// outputName derives the column heading for an unaliased expression,
// printing only the parentheses the expression needs.
func outputName(e sql.Expr) string { return render(e, 0) }

func precedence(e sql.Expr) int {
	switch x := e.(type) {
	case *sql.Binary:
		switch x.Op {
		case "OR":
			return 1
		case "AND":
			return 2
		case "=", "!=", "<", "<=", ">", ">=":
			return 4
		case "+", "-":
			return 5
		}
		return 6
	case *sql.Unary:
		if x.Op == "NOT" {
			return 3
		}
		return 7
	case *sql.IsNull, *sql.Like:
		return 4
	}
	return 8
}

func render(e sql.Expr, parent int) string {
	var s string
	p := precedence(e)
	switch x := e.(type) {
	case *sql.Binary:
		s = render(x.L, p) + " " + x.Op + " " + render(x.R, p+1)
	case *sql.Unary:
		if x.Op == "NOT" {
			s = "NOT " + render(x.X, p)
		} else {
			s = "-" + render(x.X, p)
		}
	case *sql.IsNull:
		s = render(x.X, p+1) + " IS NULL"
		if x.Not {
			s = render(x.X, p+1) + " IS NOT NULL"
		}
	case *sql.Like:
		op := " LIKE "
		if x.Not {
			op = " NOT LIKE "
		}
		s = render(x.X, p+1) + op + render(x.Pattern, p+1)
	default:
		return e.String()
	}
	if p < parent {
		return "(" + s + ")"
	}
	return s
}

func (db *DB) selectRows(s *sql.Select) (*Result, error) {
	var cols []catalog.Column
	var rowsOf func(lo, hi int64, fn func(row []record.Value) (bool, error)) error
	pkName := ""
	if s.Table != "" {
		tbl, tree, err := db.table(s.Table, s.Pos)
		if err != nil {
			return nil, err
		}
		cols = tbl.Columns
		pkName = tbl.Columns[tbl.PKIndex()].Name
		rowsOf = func(lo, hi int64, fn func(row []record.Value) (bool, error)) error {
			var cbErr error
			err := tree.Scan(lo, hi, func(_ int64, val []byte) bool {
				row, err := record.Decode(val)
				if err != nil {
					cbErr = err
					return false
				}
				more, err := fn(row)
				if err != nil {
					cbErr = err
					return false
				}
				return more
			})
			if cbErr != nil {
				return cbErr
			}
			return err
		}
	} else {
		// SELECT without FROM evaluates against a single empty row.
		rowsOf = func(_, _ int64, fn func(row []record.Value) (bool, error)) error {
			_, err := fn(nil)
			return err
		}
	}

	aggregate := false
	for _, it := range s.Items {
		if !it.Star && hasAggregate(it.Expr) {
			aggregate = true
		}
	}

	// Expand the select list.
	var items []selectItem
	var aggs []aggSpec
	rowCmp := &compiler{cols: cols}
	aggCmp := &compiler{cols: cols, aggs: &aggs}
	for _, it := range s.Items {
		if it.Star {
			if s.Table == "" {
				return nil, posErrorf(s.Pos, "SELECT * requires a FROM clause")
			}
			if aggregate {
				return nil, posErrorf(s.Pos, "cannot mix * with aggregate functions")
			}
			for i, c := range cols {
				i := i
				items = append(items, selectItem{name: c.Name, fn: func(row []record.Value) (record.Value, error) { return row[i], nil }})
			}
			continue
		}
		cmp := rowCmp
		if aggregate {
			cmp = aggCmp
		}
		fn, err := cmp.compile(it.Expr)
		if err != nil {
			return nil, err
		}
		name := it.Alias
		if name == "" {
			name = outputName(it.Expr)
		}
		items = append(items, selectItem{name: name, aliased: it.Alias != "", fn: fn})
	}

	var where evalFn
	lo, hi := int64(math.MinInt64), int64(math.MaxInt64)
	empty := false
	if s.Where != nil {
		var err error
		if where, err = rowCmp.compile(s.Where); err != nil {
			return nil, err
		}
		if pkName != "" {
			lo, hi, empty = pkBounds(s.Where, pkName)
		}
	}

	res := &Result{IsQuery: true}
	for _, it := range items {
		res.Columns = append(res.Columns, it.name)
	}

	offset, limit := int64(0), int64(-1)
	if s.Offset != nil {
		offset = *s.Offset
	}
	if s.Limit != nil {
		limit = *s.Limit
	}

	matches := func(row []record.Value) (bool, error) {
		if where == nil {
			return true, nil
		}
		v, err := where(row)
		if err != nil || v.IsNull() {
			return false, err
		}
		return truthy(v)
	}

	if aggregate {
		accs := make([]*accumulator, len(aggs))
		for i := range aggs {
			accs[i] = &accumulator{spec: aggs[i]}
		}
		if !empty {
			err := rowsOf(lo, hi, func(row []record.Value) (bool, error) {
				ok, err := matches(row)
				if err != nil || !ok {
					return true, err
				}
				for _, a := range accs {
					if err := a.add(row); err != nil {
						return false, err
					}
				}
				return true, nil
			})
			if err != nil {
				return nil, err
			}
		}
		vals := make([]record.Value, len(accs))
		for i, a := range accs {
			vals[i] = a.result()
		}
		out := make([]record.Value, len(items))
		for i, it := range items {
			v, err := it.fn(vals)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		if offset == 0 && limit != 0 {
			res.Rows = [][]record.Value{out}
		}
		return res, nil
	}

	// ORDER BY terms may be output aliases, 1-based ordinals, or expressions.
	type orderTerm struct {
		fn   evalFn // evaluated on the source row
		item int    // >= 0: sort by this output column instead
		desc bool
	}
	var order []orderTerm
	for _, o := range s.OrderBy {
		term := orderTerm{item: -1, desc: o.Desc}
		switch e := o.Expr.(type) {
		case *sql.ColumnRef:
			for i, it := range items {
				if it.aliased && strings.EqualFold(it.name, e.Name) {
					term.item = i
					break
				}
			}
		case *sql.Literal:
			if e.Kind == sql.LitInt {
				if e.Int < 1 || int(e.Int) > len(items) {
					return nil, fmt.Errorf("ORDER BY position %d is out of range (1..%d)", e.Int, len(items))
				}
				term.item = int(e.Int) - 1
			}
		}
		if term.item < 0 {
			fn, err := rowCmp.compile(o.Expr)
			if err != nil {
				return nil, err
			}
			term.fn = fn
		}
		order = append(order, term)
	}
	// ORDER BY <primary key> ASC is already the scan order.
	if len(s.OrderBy) == 1 && !s.OrderBy[0].Desc && pkName != "" {
		if c, ok := s.OrderBy[0].Expr.(*sql.ColumnRef); ok && strings.EqualFold(c.Name, pkName) {
			order = nil
		}
	}
	needSort := len(order) > 0

	type outRow struct {
		vals []record.Value
		keys []record.Value
	}
	var rows []outRow
	want := int64(-1) // stop scanning early once enough rows are collected
	if !needSort && limit >= 0 {
		want = offset + limit
	}
	if !empty && want != 0 {
		err := rowsOf(lo, hi, func(row []record.Value) (bool, error) {
			ok, err := matches(row)
			if err != nil || !ok {
				return true, err
			}
			out := outRow{vals: make([]record.Value, len(items))}
			for i, it := range items {
				if out.vals[i], err = it.fn(row); err != nil {
					return false, err
				}
			}
			if needSort {
				out.keys = make([]record.Value, len(order))
				for i, t := range order {
					if t.item >= 0 {
						out.keys[i] = out.vals[t.item]
					} else if out.keys[i], err = t.fn(row); err != nil {
						return false, err
					}
				}
			}
			rows = append(rows, out)
			return want < 0 || int64(len(rows)) < want, nil
		})
		if err != nil {
			return nil, err
		}
	}
	if needSort {
		sort.SliceStable(rows, func(i, j int) bool {
			for k, t := range order {
				c := record.Compare(rows[i].keys[k], rows[j].keys[k])
				if c == 0 {
					continue
				}
				if t.desc {
					return c > 0
				}
				return c < 0
			}
			return false
		})
	}
	if offset > int64(len(rows)) {
		offset = int64(len(rows))
	}
	rows = rows[offset:]
	if limit >= 0 && limit < int64(len(rows)) {
		rows = rows[:limit]
	}
	for _, r := range rows {
		res.Rows = append(res.Rows, r.vals)
	}
	return res, nil
}

// pkBounds inspects the top-level AND terms of a WHERE clause for comparisons
// between the primary key and an integer literal, and turns them into an
// inclusive key range so the B+tree can seek instead of scanning everything.
// The full predicate is still evaluated on every row that is visited.
func pkBounds(where sql.Expr, pk string) (lo, hi int64, empty bool) {
	lo, hi = math.MinInt64, math.MaxInt64
	var terms []sql.Expr
	var walk func(e sql.Expr)
	walk = func(e sql.Expr) {
		if b, ok := e.(*sql.Binary); ok && b.Op == "AND" {
			walk(b.L)
			walk(b.R)
			return
		}
		terms = append(terms, e)
	}
	walk(where)
	flip := map[string]string{"<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "="}
	for _, t := range terms {
		b, ok := t.(*sql.Binary)
		if !ok {
			continue
		}
		op := b.Op
		col, lit := b.L, b.R
		if _, isCol := col.(*sql.ColumnRef); !isCol {
			col, lit = b.R, b.L
			op = flip[op]
		}
		c, ok1 := col.(*sql.ColumnRef)
		l, ok2 := lit.(*sql.Literal)
		if !ok1 || !ok2 || l.Kind != sql.LitInt || !strings.EqualFold(c.Name, pk) {
			continue
		}
		k := l.Int
		switch op {
		case "=":
			lo, hi = max(lo, k), min(hi, k)
		case ">":
			if k == math.MaxInt64 {
				empty = true
			} else {
				lo = max(lo, k+1)
			}
		case ">=":
			lo = max(lo, k)
		case "<":
			if k == math.MinInt64 {
				empty = true
			} else {
				hi = min(hi, k-1)
			}
		case "<=":
			hi = min(hi, k)
		}
	}
	return lo, hi, empty || lo > hi
}
