package sql

import (
	"errors"
	"strings"
	"testing"
)

func one(t *testing.T, src string) Stmt {
	t.Helper()
	st, err := ParseOne(src)
	if err != nil {
		t.Fatalf("ParseOne(%q): %v", src, err)
	}
	return st
}

func expr(t *testing.T, src string) string {
	t.Helper()
	sel := one(t, "SELECT "+src).(*Select)
	return sel.Items[0].Expr.String()
}

func TestCreateTable(t *testing.T) {
	ct := one(t, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL);").(*CreateTable)
	if ct.Name != "users" || len(ct.Columns) != 4 || ct.IfNotExists {
		t.Fatalf("%+v", ct)
	}
	want := []ColumnDef{{Name: "id", Type: "INTEGER", PrimaryKey: true}, {Name: "name", Type: "TEXT"},
		{Name: "age", Type: "INTEGER"}, {Name: "score", Type: "REAL"}}
	for i, w := range want {
		g := ct.Columns[i]
		if g.Name != w.Name || g.Type != w.Type || g.PrimaryKey != w.PrimaryKey {
			t.Errorf("col %d = %+v, want %+v", i, g, w)
		}
	}
	ct = one(t, "create table if not exists t (a integer primary key)").(*CreateTable)
	if !ct.IfNotExists {
		t.Error("IF NOT EXISTS lost")
	}
}

func TestDropTable(t *testing.T) {
	d := one(t, "DROP TABLE users").(*DropTable)
	if d.Name != "users" || d.IfExists {
		t.Errorf("%+v", d)
	}
	d = one(t, "DROP TABLE IF EXISTS users;").(*DropTable)
	if !d.IfExists {
		t.Error("IF EXISTS lost")
	}
}

func TestInsert(t *testing.T) {
	ins := one(t, "INSERT INTO users VALUES (1, 'Jash', 27, 98.5);").(*Insert)
	if ins.Table != "users" || len(ins.Columns) != 0 || len(ins.Rows) != 1 || len(ins.Rows[0]) != 4 {
		t.Fatalf("%+v", ins)
	}
	ins = one(t, "INSERT INTO users (id, name) VALUES (1, 'a'), (2, NULL), (3, -4)").(*Insert)
	if len(ins.Columns) != 2 || len(ins.Rows) != 3 {
		t.Fatalf("%+v", ins)
	}
	if got := ins.Rows[1][1].String(); got != "NULL" {
		t.Errorf("NULL literal: %s", got)
	}
	if lit := ins.Rows[2][1].(*Literal); lit.Kind != LitInt || lit.Int != -4 {
		t.Errorf("negative literal: %+v", lit)
	}
}

func TestSelectFull(t *testing.T) {
	s := one(t, "SELECT name, age FROM users WHERE age > 25 ORDER BY name DESC, age ASC, id LIMIT 10 OFFSET 5;").(*Select)
	if s.Table != "users" || len(s.Items) != 2 || s.Where == nil {
		t.Fatalf("%+v", s)
	}
	if len(s.OrderBy) != 3 || s.OrderBy[0].Desc != true || s.OrderBy[1].Desc || s.OrderBy[2].Desc {
		t.Errorf("order: %+v", s.OrderBy)
	}
	if s.Limit == nil || *s.Limit != 10 || s.Offset == nil || *s.Offset != 5 {
		t.Errorf("limit/offset: %v %v", s.Limit, s.Offset)
	}
}

func TestSelectStarAliasAndNoFrom(t *testing.T) {
	s := one(t, "SELECT * FROM t").(*Select)
	if !s.Items[0].Star {
		t.Error("star")
	}
	s = one(t, "SELECT age * 2 AS double, name n FROM t").(*Select)
	if s.Items[0].Alias != "double" || s.Items[1].Alias != "n" {
		t.Errorf("aliases: %+v", s.Items)
	}
	s = one(t, "SELECT 1 + 1").(*Select)
	if s.Table != "" {
		t.Errorf("table = %q", s.Table)
	}
}

func TestAggregates(t *testing.T) {
	s := one(t, "SELECT COUNT(*), count(age), SUM(score), AVG(score), MIN(age), MAX(age) FROM users").(*Select)
	var got []string
	for _, it := range s.Items {
		got = append(got, it.Expr.String())
	}
	want := "COUNT(*) COUNT(age) SUM(score) AVG(score) MIN(age) MAX(age)"
	if strings.Join(got, " ") != want {
		t.Errorf("got %v", got)
	}
}

func TestUpdateDelete(t *testing.T) {
	u := one(t, "UPDATE users SET age = age + 1, name = 'x' WHERE id = 3").(*Update)
	if u.Table != "users" || len(u.Set) != 2 || u.Set[0].Column != "age" || u.Where == nil {
		t.Errorf("%+v", u)
	}
	if u.Set[0].Value.String() != "(age + 1)" {
		t.Errorf("set expr: %s", u.Set[0].Value)
	}
	u = one(t, "UPDATE t SET a = 1").(*Update)
	if u.Where != nil {
		t.Error("where should be nil")
	}
	d := one(t, "DELETE FROM users WHERE id < 5").(*Delete)
	if d.Table != "users" || d.Where == nil {
		t.Errorf("%+v", d)
	}
	d = one(t, "DELETE FROM users").(*Delete)
	if d.Where != nil {
		t.Error("where should be nil")
	}
}

func TestTransactionStatements(t *testing.T) {
	if _, ok := one(t, "BEGIN").(*Begin); !ok {
		t.Error("BEGIN")
	}
	if _, ok := one(t, "BEGIN TRANSACTION;").(*Begin); !ok {
		t.Error("BEGIN TRANSACTION")
	}
	if _, ok := one(t, "commit").(*Commit); !ok {
		t.Error("COMMIT")
	}
	if _, ok := one(t, "ROLLBACK;").(*Rollback); !ok {
		t.Error("ROLLBACK")
	}
}

func TestMultipleStatements(t *testing.T) {
	stmts, err := Parse("BEGIN; ;; INSERT INTO t VALUES (1); COMMIT")
	if err != nil {
		t.Fatal(err)
	}
	if len(stmts) != 3 {
		t.Fatalf("got %d statements", len(stmts))
	}
	if stmts, err := Parse("  ;  "); err != nil || len(stmts) != 0 {
		t.Errorf("empty input: %v %v", stmts, err)
	}
	if _, err := ParseOne("BEGIN; COMMIT"); err == nil {
		t.Error("ParseOne should reject two statements")
	}
	if _, err := ParseOne(""); err == nil {
		t.Error("ParseOne should reject zero statements")
	}
}

func TestOperatorPrecedence(t *testing.T) {
	cases := map[string]string{
		"1 + 2 * 3":                     "(1 + (2 * 3))",
		"(1 + 2) * 3":                   "((1 + 2) * 3)",
		"1 - 2 - 3":                     "((1 - 2) - 3)",
		"8 / 4 / 2":                     "((8 / 4) / 2)",
		"10 % 3 * 2":                    "((10 % 3) * 2)",
		"-a * b":                        "((-a) * b)",
		"- - a":                         "(-(-a))",
		"a OR b AND c":                  "(a OR (b AND c))",
		"a AND b OR c":                  "((a AND b) OR c)",
		"NOT a AND b":                   "((NOT a) AND b)",
		"NOT a OR b":                    "((NOT a) OR b)",
		"NOT NOT a":                     "(NOT (NOT a))",
		"a = 1 AND b > 2 OR c < 3":      "(((a = 1) AND (b > 2)) OR (c < 3))",
		"a + 1 > b * 2":                 "((a + 1) > (b * 2))",
		"a IS NULL AND b IS NOT NULL":   "((a IS NULL) AND (b IS NOT NULL))",
		"a LIKE 'x%' OR b NOT LIKE 'y'": "((a LIKE 'x%') OR (b NOT LIKE 'y'))",
		"NOT a LIKE 'x'":                "(NOT (a LIKE 'x'))",
		"a != 1 AND a <> 2":             "((a != 1) AND (a != 2))",
		"a <= 1 AND a >= 2":             "((a <= 1) AND (a >= 2))",
		"x = 'it''s'":                   "(x = 'it''s')",
		"2 * (3 + 4) - 5":               "((2 * (3 + 4)) - 5)",
		"1.5 + .5":                      "(1.5 + 0.5)",
	}
	for src, want := range cases {
		if got := expr(t, src); got != want {
			t.Errorf("%s\n got  %s\n want %s", src, got, want)
		}
	}
}

func TestNegativeLiteralFolding(t *testing.T) {
	lit := one(t, "SELECT -9223372036854775808").(*Select).Items[0].Expr.(*Literal)
	if lit.Kind != LitInt || lit.Int != -9223372036854775808 {
		t.Errorf("%+v", lit)
	}
	if _, err := ParseOne("SELECT 9223372036854775808"); err == nil {
		t.Error("overflow should fail")
	}
	lit = one(t, "SELECT -1.5").(*Select).Items[0].Expr.(*Literal)
	if lit.Kind != LitReal || lit.Real != -1.5 {
		t.Errorf("%+v", lit)
	}
}

func TestStringLiteralsInSQL(t *testing.T) {
	ins := one(t, `INSERT INTO t VALUES ('it''s', 'héllo 世界', '')`).(*Insert)
	got := []string{ins.Rows[0][0].(*Literal).Text, ins.Rows[0][1].(*Literal).Text, ins.Rows[0][2].(*Literal).Text}
	if got[0] != "it's" || got[1] != "héllo 世界" || got[2] != "" {
		t.Errorf("%q", got)
	}
	if s := (&Literal{Kind: LitText, Text: "it's"}).String(); s != "'it''s'" {
		t.Errorf("round-trip quoting: %s", s)
	}
}

func TestSyntaxErrorsHavePositions(t *testing.T) {
	cases := []struct {
		src  string
		pos  Pos
		part string
	}{
		{"SELEC 1", Pos{1, 1}, "expected a statement"},
		{"SELECT FROM t", Pos{1, 8}, "expected an expression"},
		{"SELECT a FROM", Pos{1, 14}, "expected table name"},
		{"SELECT a FROM t WHERE", Pos{1, 22}, "expected an expression"},
		{"SELECT a FROM t\nWHERE a >", Pos{2, 10}, "expected an expression"},
		{"SELECT a FROM t LIMIT x", Pos{1, 23}, "non-negative integer"},
		{"SELECT a FROM t OFFSET 3", Pos{1, 17}, "OFFSET requires LIMIT"},
		{"SELECT a FROM t ORDER a", Pos{1, 23}, "expected BY"},
		{"CREATE TABLE t (a BLOB)", Pos{1, 19}, "expected a column type"},
		{"CREATE TABLE t a INTEGER", Pos{1, 16}, "expected '('"},
		{"CREATE TABLE t (a INTEGER", Pos{1, 26}, "expected ')'"},
		{"CREATE TABLE t (a INTEGER PRIMARY)", Pos{1, 34}, "expected KEY"},
		{"CREATE INDEX i", Pos{1, 8}, "expected TABLE"},
		{"CREATE TABLE IF EXISTS t (a INTEGER)", Pos{1, 17}, "expected NOT"},
		{"DROP t", Pos{1, 6}, "expected TABLE"},
		{"INSERT t VALUES (1)", Pos{1, 8}, "expected INTO"},
		{"INSERT INTO t (1)", Pos{1, 16}, "expected column name"},
		{"INSERT INTO t VALUES 1", Pos{1, 22}, "expected '('"},
		{"INSERT INTO t VALUES (1,)", Pos{1, 25}, "expected an expression"},
		{"INSERT INTO t VALUES (1", Pos{1, 24}, "expected ')'"},
		{"UPDATE t a = 1", Pos{1, 10}, "expected SET"},
		{"UPDATE t SET a 1", Pos{1, 16}, "expected '='"},
		{"DELETE t", Pos{1, 8}, "expected FROM"},
		{"SELECT (1 + 2", Pos{1, 14}, "expected ')'"},
		{"SELECT a IS 3", Pos{1, 13}, "expected NULL"},
		{"SELECT foo(1)", Pos{1, 8}, "unknown function foo"},
		{"SELECT SUM(*)", Pos{1, 8}, "only COUNT(*)"},
		{"SELECT 1 2", Pos{1, 10}, "expected ';' or end of input"},
		{"SELECT 1;\nSELECT 2 3;", Pos{2, 10}, "expected ';' or end of input"},
		{"SELECT 'abc", Pos{1, 8}, "unterminated string"},
		{"1", Pos{1, 1}, "expected a statement"},
	}
	for _, c := range cases {
		_, err := Parse(c.src)
		var se *Error
		if !errors.As(err, &se) {
			t.Errorf("%q: want *Error, got %v", c.src, err)
			continue
		}
		if se.Pos != c.pos {
			t.Errorf("%q: pos %v, want %v (msg %q)", c.src, se.Pos, c.pos, se.Msg)
		}
		if !strings.Contains(se.Msg, c.part) {
			t.Errorf("%q: msg %q lacks %q", c.src, se.Msg, c.part)
		}
		if !strings.HasPrefix(se.Error(), "syntax error at line ") {
			t.Errorf("Error() = %q", se.Error())
		}
	}
}

func TestExprStrings(t *testing.T) {
	cases := map[string]string{
		"SELECT NULL":           "NULL",
		"SELECT COUNT(*)":       "COUNT(*)",
		"SELECT a NOT LIKE 'x'": "(a NOT LIKE 'x')",
		"SELECT -a":             "(-a)",
		"SELECT 'x' LIKE a":     "('x' LIKE a)",
	}
	for src, want := range cases {
		if got := one(t, src).(*Select).Items[0].Expr.String(); got != want {
			t.Errorf("%s: got %s want %s", src, got, want)
		}
	}
}
