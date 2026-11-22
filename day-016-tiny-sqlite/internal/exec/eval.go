package exec

import (
	"fmt"
	"math"
	"strings"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/catalog"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

// evalFn evaluates a compiled expression against one row. In aggregate mode
// the "row" is the slice of finished aggregate values.
type evalFn func(row []record.Value) (record.Value, error)

type aggSpec struct {
	name string // COUNT, SUM, AVG, MIN, MAX
	star bool
	arg  evalFn
	pos  sql.Pos
}

// compiler turns AST expressions into closures, resolving column names once
// so that errors surface even when a table has no rows.
type compiler struct {
	cols []catalog.Column
	aggs *[]aggSpec // non-nil: aggregate mode
}

func posErrorf(pos sql.Pos, format string, args ...any) error {
	return fmt.Errorf("%s: %s", pos, fmt.Sprintf(format, args...))
}

func hasAggregate(x sql.Expr) bool {
	switch e := x.(type) {
	case *sql.Call:
		return true
	case *sql.Unary:
		return hasAggregate(e.X)
	case *sql.Binary:
		return hasAggregate(e.L) || hasAggregate(e.R)
	case *sql.IsNull:
		return hasAggregate(e.X)
	case *sql.Like:
		return hasAggregate(e.X) || hasAggregate(e.Pattern)
	}
	return false
}

func literalValue(l *sql.Literal) record.Value {
	switch l.Kind {
	case sql.LitInt:
		return record.NewInt(l.Int)
	case sql.LitReal:
		return record.NewReal(l.Real)
	case sql.LitText:
		return record.NewText(l.Text)
	}
	return record.NullValue()
}

func (c *compiler) compile(x sql.Expr) (evalFn, error) {
	switch e := x.(type) {
	case *sql.Literal:
		v := literalValue(e)
		return func([]record.Value) (record.Value, error) { return v, nil }, nil

	case *sql.ColumnRef:
		if c.aggs != nil {
			return nil, posErrorf(e.Pos, "column %q must be used inside an aggregate function", e.Name)
		}
		for i, col := range c.cols {
			if strings.EqualFold(col.Name, e.Name) {
				return func(row []record.Value) (record.Value, error) { return row[i], nil }, nil
			}
		}
		return nil, posErrorf(e.Pos, "no such column: %s", e.Name)

	case *sql.Call:
		if c.aggs == nil {
			return nil, posErrorf(e.Pos, "aggregate function %s is not allowed here", e.Name)
		}
		spec := aggSpec{name: e.Name, star: e.Star, pos: e.Pos}
		if !e.Star {
			sub := &compiler{cols: c.cols} // arguments are ordinary row expressions
			arg, err := sub.compile(e.Args[0])
			if err != nil {
				if hasAggregate(e.Args[0]) {
					return nil, posErrorf(e.Pos, "aggregate functions cannot be nested")
				}
				return nil, err
			}
			spec.arg = arg
		}
		idx := len(*c.aggs)
		*c.aggs = append(*c.aggs, spec)
		return func(vals []record.Value) (record.Value, error) { return vals[idx], nil }, nil

	case *sql.Unary:
		inner, err := c.compile(e.X)
		if err != nil {
			return nil, err
		}
		if e.Op == "NOT" {
			return func(row []record.Value) (record.Value, error) {
				v, err := inner(row)
				if err != nil || v.IsNull() {
					return record.NullValue(), err
				}
				t, err := truthy(v)
				return record.NewBool(!t), err
			}, nil
		}
		return func(row []record.Value) (record.Value, error) {
			v, err := inner(row)
			if err != nil {
				return v, err
			}
			switch v.Kind {
			case record.Null:
				return v, nil
			case record.Integer:
				return record.NewInt(-v.Int), nil
			case record.Real:
				return record.NewReal(-v.Real), nil
			}
			return v, fmt.Errorf("cannot negate a TEXT value")
		}, nil

	case *sql.IsNull:
		inner, err := c.compile(e.X)
		if err != nil {
			return nil, err
		}
		return func(row []record.Value) (record.Value, error) {
			v, err := inner(row)
			if err != nil {
				return v, err
			}
			return record.NewBool(v.IsNull() != e.Not), nil
		}, nil

	case *sql.Like:
		l, err := c.compile(e.X)
		if err != nil {
			return nil, err
		}
		p, err := c.compile(e.Pattern)
		if err != nil {
			return nil, err
		}
		return func(row []record.Value) (record.Value, error) {
			a, err := l(row)
			if err != nil {
				return a, err
			}
			b, err := p(row)
			if err != nil {
				return b, err
			}
			if a.IsNull() || b.IsNull() {
				return record.NullValue(), nil
			}
			return record.NewBool(like(a.String(), b.String()) != e.Not), nil
		}, nil

	case *sql.Binary:
		l, err := c.compile(e.L)
		if err != nil {
			return nil, err
		}
		r, err := c.compile(e.R)
		if err != nil {
			return nil, err
		}
		return binaryFn(e.Op, l, r), nil
	}
	return nil, fmt.Errorf("unsupported expression %T", x)
}

func binaryFn(op string, l, r evalFn) evalFn {
	switch op {
	case "AND", "OR":
		isAnd := op == "AND"
		return func(row []record.Value) (record.Value, error) {
			a, err := l(row)
			if err != nil {
				return a, err
			}
			at, an, err := tri(a)
			if err != nil {
				return a, err
			}
			if !an && at != isAnd { // FALSE AND x, TRUE OR x
				return record.NewBool(at), nil
			}
			b, err := r(row)
			if err != nil {
				return b, err
			}
			bt, bn, err := tri(b)
			if err != nil {
				return b, err
			}
			if !bn && bt != isAnd {
				return record.NewBool(bt), nil
			}
			if an || bn {
				return record.NullValue(), nil
			}
			return record.NewBool(isAnd), nil
		}
	case "=", "!=", "<", "<=", ">", ">=":
		return func(row []record.Value) (record.Value, error) {
			a, err := l(row)
			if err != nil {
				return a, err
			}
			b, err := r(row)
			if err != nil {
				return b, err
			}
			if a.IsNull() || b.IsNull() {
				return record.NullValue(), nil
			}
			c := record.Compare(a, b)
			var ok bool
			switch op {
			case "=":
				ok = c == 0
			case "!=":
				ok = c != 0
			case "<":
				ok = c < 0
			case "<=":
				ok = c <= 0
			case ">":
				ok = c > 0
			default:
				ok = c >= 0
			}
			return record.NewBool(ok), nil
		}
	}
	return func(row []record.Value) (record.Value, error) {
		a, err := l(row)
		if err != nil {
			return a, err
		}
		b, err := r(row)
		if err != nil {
			return b, err
		}
		return arith(op, a, b)
	}
}

// tri classifies a value for three-valued logic: (truth, isNull).
func tri(v record.Value) (bool, bool, error) {
	if v.IsNull() {
		return false, true, nil
	}
	t, err := truthy(v)
	return t, false, err
}

func truthy(v record.Value) (bool, error) {
	switch v.Kind {
	case record.Integer:
		return v.Int != 0, nil
	case record.Real:
		return v.Real != 0, nil
	}
	return false, fmt.Errorf("a TEXT value cannot be used as a condition")
}

func arith(op string, a, b record.Value) (record.Value, error) {
	if a.IsNull() || b.IsNull() {
		return record.NullValue(), nil
	}
	if a.Kind == record.Text || b.Kind == record.Text {
		return record.NullValue(), fmt.Errorf("operator %s needs numbers, got %s and %s", op, a.Kind, b.Kind)
	}
	if a.Kind == record.Integer && b.Kind == record.Integer {
		x, y := a.Int, b.Int
		switch op {
		case "+":
			return record.NewInt(x + y), nil
		case "-":
			return record.NewInt(x - y), nil
		case "*":
			return record.NewInt(x * y), nil
		case "/", "%":
			if y == 0 {
				return record.NullValue(), nil
			}
			if y == -1 { // avoid MinInt64 / -1 surprises
				if op == "%" {
					return record.NewInt(0), nil
				}
				return record.NewInt(-x), nil
			}
			if op == "/" {
				return record.NewInt(x / y), nil
			}
			return record.NewInt(x % y), nil
		}
	}
	x, _ := a.AsFloat()
	y, _ := b.AsFloat()
	switch op {
	case "+":
		return record.NewReal(x + y), nil
	case "-":
		return record.NewReal(x - y), nil
	case "*":
		return record.NewReal(x * y), nil
	case "/":
		if y == 0 {
			return record.NullValue(), nil
		}
		return record.NewReal(x / y), nil
	case "%":
		if y == 0 {
			return record.NullValue(), nil
		}
		return record.NewReal(math.Mod(x, y)), nil
	}
	return record.NullValue(), fmt.Errorf("unknown operator %s", op)
}

// like implements SQL LIKE: % matches any run, _ one character, and ASCII
// letters compare case-insensitively.
func like(s, pattern string) bool {
	rs, rp := []rune(s), []rune(pattern)
	fold := func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 32
		}
		return r
	}
	si, pi := 0, 0
	star, mark := -1, 0
	for si < len(rs) {
		switch {
		case pi < len(rp) && rp[pi] == '%':
			star, mark = pi, si
			pi++
		case pi < len(rp) && (rp[pi] == '_' || fold(rp[pi]) == fold(rs[si])):
			si++
			pi++
		case star >= 0:
			mark++
			si, pi = mark, star+1
		default:
			return false
		}
	}
	for pi < len(rp) && rp[pi] == '%' {
		pi++
	}
	return pi == len(rp)
}

// accumulator folds one aggregate over many rows.
type accumulator struct {
	spec    aggSpec
	n       int
	intSum  int64
	fltSum  float64
	hasReal bool
	best    record.Value
}

func (a *accumulator) add(row []record.Value) error {
	if a.spec.star {
		a.n++
		return nil
	}
	v, err := a.spec.arg(row)
	if err != nil {
		return err
	}
	if v.IsNull() {
		return nil
	}
	switch a.spec.name {
	case "COUNT":
		a.n++
	case "SUM", "AVG":
		if v.Kind == record.Text {
			return posErrorf(a.spec.pos, "%s needs numbers, got TEXT", a.spec.name)
		}
		a.n++
		if v.Kind == record.Integer {
			a.intSum += v.Int
			a.fltSum += float64(v.Int)
		} else {
			a.hasReal = true
			a.fltSum += v.Real
		}
	case "MIN", "MAX":
		if a.n == 0 {
			a.best = v
		} else if c := record.Compare(v, a.best); (a.spec.name == "MIN" && c < 0) || (a.spec.name == "MAX" && c > 0) {
			a.best = v
		}
		a.n++
	}
	return nil
}

func (a *accumulator) result() record.Value {
	switch a.spec.name {
	case "COUNT":
		return record.NewInt(int64(a.n))
	case "SUM":
		switch {
		case a.n == 0:
			return record.NullValue()
		case a.hasReal:
			return record.NewReal(a.fltSum)
		}
		return record.NewInt(a.intSum)
	case "AVG":
		if a.n == 0 {
			return record.NullValue()
		}
		return record.NewReal(a.fltSum / float64(a.n))
	}
	if a.n == 0 {
		return record.NullValue()
	}
	return a.best
}
