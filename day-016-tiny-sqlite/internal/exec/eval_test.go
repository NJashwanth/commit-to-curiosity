package exec

import (
	"math"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/catalog"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/record"
	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

func TestLike(t *testing.T) {
	cases := []struct {
		s, p string
		want bool
	}{
		{"hello", "hello", true}, {"hello", "HELLO", true}, {"hello", "h%", true}, {"hello", "%o", true},
		{"hello", "%ll%", true}, {"hello", "h_llo", true}, {"hello", "h_lo", false}, {"hello", "", false},
		{"", "", true}, {"", "%", true}, {"", "_", false}, {"abc", "a%c%", true}, {"abcbc", "a%bc", true},
		{"abc", "%%%", true}, {"abc", "abcd", false}, {"世界", "世_", true}, {"é", "_", true},
		{"100%", "100\\%", false}, {"a.b", "a.b", true}, {"axb", "a.b", false}, {"mississippi", "m%iss%ppi", true},
		{"mississippi", "m%iss%ppx", false},
	}
	for _, c := range cases {
		if got := like(c.s, c.p); got != c.want {
			t.Errorf("like(%q, %q) = %v, want %v", c.s, c.p, got, c.want)
		}
	}
}

func TestArith(t *testing.T) {
	i, f := record.NewInt, record.NewReal
	cases := []struct {
		op   string
		a, b record.Value
		want record.Value
	}{
		{"+", i(2), i(3), i(5)}, {"-", i(2), i(3), i(-1)}, {"*", i(4), i(5), i(20)},
		{"/", i(7), i(2), i(3)}, {"/", i(-7), i(2), i(-3)}, {"%", i(7), i(3), i(1)},
		{"/", i(1), i(0), record.NullValue()}, {"%", i(1), i(0), record.NullValue()},
		{"/", i(math.MinInt64), i(-1), i(math.MinInt64)}, {"%", i(5), i(-1), i(0)},
		{"+", i(1), f(0.5), f(1.5)}, {"/", f(1), i(4), f(0.25)}, {"/", f(1), f(0), record.NullValue()},
		{"%", f(7.5), i(2), f(1.5)}, {"%", f(1), f(0), record.NullValue()}, {"*", f(1.5), f(2), f(3)},
		{"-", f(1), i(2), f(-1)}, {"+", record.NullValue(), i(1), record.NullValue()},
	}
	for _, c := range cases {
		got, err := arith(c.op, c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("%v %s %v = %v (%v), want %v", c.a, c.op, c.b, got, err, c.want)
		}
	}
	if _, err := arith("+", record.NewText("a"), i(1)); err == nil {
		t.Error("text arithmetic should fail")
	}
	if _, err := arith("^", i(1), i(1)); err == nil {
		t.Error("unknown operator should fail")
	}
}

func TestCoerce(t *testing.T) {
	intCol := catalog.Column{Name: "n", Type: record.Integer}
	realCol := catalog.Column{Name: "r", Type: record.Real}
	textCol := catalog.Column{Name: "s", Type: record.Text}
	ok := []struct {
		v    record.Value
		col  catalog.Column
		want record.Value
	}{
		{record.NewInt(3), intCol, record.NewInt(3)}, {record.NewReal(4), intCol, record.NewInt(4)},
		{record.NewInt(3), realCol, record.NewReal(3)}, {record.NewReal(1.5), realCol, record.NewReal(1.5)},
		{record.NewText("x"), textCol, record.NewText("x")}, {record.NullValue(), intCol, record.NullValue()},
	}
	for _, c := range ok {
		if got, err := coerce(c.v, c.col); err != nil || got != c.want {
			t.Errorf("coerce(%v, %s) = %v, %v", c.v, c.col.Type, got, err)
		}
	}
	bad := []struct {
		v   record.Value
		col catalog.Column
	}{
		{record.NewText("a"), intCol}, {record.NewReal(2.5), intCol}, {record.NewReal(1e30), intCol},
		{record.NewText("a"), realCol}, {record.NewInt(1), textCol}, {record.NewReal(1), textCol},
	}
	for _, c := range bad {
		if _, err := coerce(c.v, c.col); err == nil {
			t.Errorf("coerce(%v, %s) should fail", c.v, c.col.Type)
		}
	}
}

func bounds(t *testing.T, where string) (int64, int64, bool) {
	t.Helper()
	st, err := sql.ParseOne("SELECT 1 FROM t WHERE " + where)
	if err != nil {
		t.Fatal(err)
	}
	return pkBounds(st.(*sql.Select).Where, "id")
}

func TestPKBounds(t *testing.T) {
	const min, max = math.MinInt64, math.MaxInt64
	cases := []struct {
		where  string
		lo, hi int64
		empty  bool
	}{
		{"id = 5", 5, 5, false},
		{"id > 5", 6, max, false},
		{"id >= 5", 5, max, false},
		{"id < 5", min, 4, false},
		{"id <= 5", min, 5, false},
		{"5 < id", 6, max, false},
		{"5 >= id", min, 5, false},
		{"id > 2 AND id < 10", 3, 9, false},
		{"id >= 3 AND id <= 3", 3, 3, false},
		{"id > 10 AND id < 5", 11, 4, true},
		{"id = 3 AND id = 4", 4, 3, true},
		{"id > 9223372036854775807", 0, 0, true},
		{"id < -9223372036854775808", 0, 0, true},
		{"id > 2 OR id < 0", min, max, false}, // OR: no narrowing
		{"name = 'x'", min, max, false},
		{"id = 2.5", min, max, false},
		{"ID > 1 AND name = 'x'", 2, max, false},
		{"id != 5", min, max, false},
		{"id > -3", -2, max, false},
	}
	for _, c := range cases {
		lo, hi, empty := bounds(t, c.where)
		if empty != c.empty || (!empty && (lo != c.lo || hi != c.hi)) {
			t.Errorf("%s -> [%d, %d] empty=%v, want [%d, %d] empty=%v", c.where, lo, hi, empty, c.lo, c.hi, c.empty)
		}
	}
}

func TestOutputNames(t *testing.T) {
	cases := map[string]string{
		"SELECT age FROM t": "age", "SELECT age * 2 FROM t": "age * 2", "SELECT COUNT(*) FROM t": "COUNT(*)",
		"SELECT -age FROM t": "-age", "SELECT age IS NULL FROM t": "age IS NULL", "SELECT 1": "1",
		"SELECT AVG(score) FROM t": "AVG(score)", "SELECT 'a' FROM t": "'a'",
		"SELECT 1 + 2 * 3 FROM t": "1 + 2 * 3", "SELECT (1 + 2) * 3 FROM t": "(1 + 2) * 3", "SELECT 1 - (2 - 3) FROM t": "1 - (2 - 3)",
		"SELECT a = 1 AND NOT b OR c FROM t": "a = 1 AND NOT b OR c", "SELECT a NOT LIKE 'x%' FROM t": "a NOT LIKE 'x%'", "SELECT 4.0 FROM t": "4.0",
		"SELECT (a OR b) AND c FROM t": "(a OR b) AND c", "SELECT -(a + 1) FROM t": "-(a + 1)",
	}
	for src, want := range cases {
		st, _ := sql.ParseOne(src)
		if got := outputName(st.(*sql.Select).Items[0].Expr); got != want {
			t.Errorf("%s: got %q want %q", src, got, want)
		}
	}
}
