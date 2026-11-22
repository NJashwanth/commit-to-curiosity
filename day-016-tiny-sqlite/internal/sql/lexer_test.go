package sql

import (
	"errors"
	"reflect"
	"testing"
)

func toks(t *testing.T, src string) []Token {
	t.Helper()
	ts, err := Tokenize(src)
	if err != nil {
		t.Fatalf("Tokenize(%q): %v", src, err)
	}
	return ts
}

func TestTokenizeBasics(t *testing.T) {
	ts := toks(t, "SELECT name, age FROM users WHERE age >= 25;")
	var got []string
	for _, tk := range ts {
		got = append(got, tk.Text)
	}
	want := []string{"SELECT", "name", ",", "age", "FROM", "users", "WHERE", "age", ">=", "25", ";", ""}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
	if ts[0].Kind != Keyword || ts[1].Kind != Ident || ts[9].Kind != Integer || ts[len(ts)-1].Kind != EOF {
		t.Errorf("kinds wrong: %+v", ts)
	}
}

func TestKeywordsCaseInsensitive(t *testing.T) {
	ts := toks(t, "select From wHeRe")
	for _, tk := range ts[:3] {
		if tk.Kind != Keyword {
			t.Errorf("%v not keyword", tk)
		}
	}
	if ts[1].Text != "FROM" {
		t.Errorf("keyword text should be upper-cased, got %q", ts[1].Text)
	}
}

func TestTokenizeNumbers(t *testing.T) {
	cases := []struct {
		src  string
		kind TokenKind
	}{
		{"42", Integer}, {"3.14", Real}, {".5", Real}, {"1e3", Real}, {"2.5E-2", Real}, {"7.", Real},
	}
	for _, c := range cases {
		ts := toks(t, c.src)
		if ts[0].Kind != c.kind || ts[0].Text != c.src {
			t.Errorf("%q -> %+v", c.src, ts[0])
		}
	}
	// "1e" is the integer 1 followed by identifier e... except letters after digits are rejected.
	if _, err := Tokenize("12abc"); err == nil {
		t.Error("12abc should be a malformed number")
	}
	if _, err := Tokenize("1e+"); err == nil {
		t.Error("1e+ should be malformed")
	}
}

func TestStringEscaping(t *testing.T) {
	cases := map[string]string{
		`'hello'`:          "hello",
		`'it''s'`:          "it's",
		`''`:               "",
		`''''`:             "'",
		`'a''''b'`:         "a''b",
		"'line\nbreak'":    "line\nbreak",
		`'héllo 世界 🙂'`:     "héllo 世界 🙂",
		`'semi;colon'`:     "semi;colon",
		`'-- not comment'`: "-- not comment",
	}
	for src, want := range cases {
		ts := toks(t, src)
		if ts[0].Kind != String || ts[0].Text != want {
			t.Errorf("%s -> %+v, want text %q", src, ts[0], want)
		}
	}
}

func TestQuotedIdentifier(t *testing.T) {
	ts := toks(t, `"select" "a""b"`)
	if ts[0].Kind != Ident || ts[0].Text != "select" || ts[1].Text != `a"b` {
		t.Errorf("%+v", ts)
	}
	if _, err := Tokenize(`"abc`); err == nil {
		t.Error("unterminated quoted identifier")
	}
	if _, err := Tokenize(`""`); err == nil {
		t.Error("empty quoted identifier")
	}
}

func TestOperators(t *testing.T) {
	ts := toks(t, "= == != <> < <= > >= + - * / % ( ) , ;")
	var got []string
	for _, tk := range ts[:len(ts)-1] {
		got = append(got, tk.Text)
	}
	want := []string{"=", "=", "!=", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "(", ")", ",", ";"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q", got)
	}
}

func TestComments(t *testing.T) {
	ts := toks(t, "SELECT -- trailing\n1 /* block\ncomment */ + 2")
	if len(ts) != 5 { // SELECT 1 + 2 EOF
		t.Errorf("tokens: %+v", ts)
	}
	if _, err := Tokenize("SELECT /* never closed"); err == nil {
		t.Error("unterminated comment should fail")
	}
}

func TestPositions(t *testing.T) {
	ts := toks(t, "SELECT a,\n  b\nFROM t")
	want := map[string]Pos{"SELECT": {1, 1}, "a": {1, 8}, "b": {2, 3}, "FROM": {3, 1}, "t": {3, 6}}
	for _, tk := range ts {
		if p, ok := want[tk.Text]; ok && tk.Pos != p {
			t.Errorf("%s at %v, want %v", tk.Text, tk.Pos, p)
		}
	}
}

func TestLexErrors(t *testing.T) {
	cases := []struct {
		src  string
		pos  Pos
		part string
	}{
		{"SELECT 'abc", Pos{1, 8}, "unterminated string"},
		{"SELECT @", Pos{1, 8}, "unexpected character"},
		{"a ! b", Pos{1, 3}, "did you mean"},
		{"x\n  /* open", Pos{2, 3}, "unterminated comment"},
		{"SELECT 12abc", Pos{1, 10}, "malformed number"},
	}
	for _, c := range cases {
		_, err := Tokenize(c.src)
		var se *Error
		if !errors.As(err, &se) {
			t.Errorf("%q: want *Error, got %v", c.src, err)
			continue
		}
		if se.Pos != c.pos {
			t.Errorf("%q: pos %v, want %v", c.src, se.Pos, c.pos)
		}
		if !contains(se.Msg, c.part) {
			t.Errorf("%q: msg %q lacks %q", c.src, se.Msg, c.part)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestTokenKindString(t *testing.T) {
	if EOF.String() != "end of input" || Op.String() != "symbol" {
		t.Error("TokenKind.String")
	}
	if (Pos{3, 4}).String() != "line 3, column 4" {
		t.Error("Pos.String")
	}
}
