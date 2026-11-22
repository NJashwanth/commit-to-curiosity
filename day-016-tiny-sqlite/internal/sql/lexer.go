// Package sql contains the tokenizer, AST and recursive-descent parser.
package sql

import (
	"fmt"
	"strings"
)

// Pos is a 1-based line and column in the source text.
type Pos struct{ Line, Col int }

func (p Pos) String() string { return fmt.Sprintf("line %d, column %d", p.Line, p.Col) }

// Error is a syntax error with a position.
type Error struct {
	Pos Pos
	Msg string
}

func (e *Error) Error() string { return fmt.Sprintf("syntax error at %s: %s", e.Pos, e.Msg) }

// TokenKind classifies a token.
type TokenKind int

const (
	EOF TokenKind = iota
	Ident
	Keyword
	Integer
	Real
	String
	Op // operators and punctuation
)

func (k TokenKind) String() string {
	return [...]string{"end of input", "identifier", "keyword", "integer", "number", "string", "symbol"}[k]
}

// Token is one lexical element. For keywords Text is upper-cased.
type Token struct {
	Kind TokenKind
	Text string
	Pos  Pos
}

var keywords = map[string]bool{}

func init() {
	for _, k := range strings.Fields(`CREATE TABLE DROP INSERT INTO VALUES SELECT FROM WHERE AND OR NOT
		IS NULL LIKE ORDER BY ASC DESC LIMIT OFFSET UPDATE SET DELETE BEGIN COMMIT ROLLBACK
		INTEGER REAL TEXT PRIMARY KEY IF EXISTS AS TRANSACTION`) {
		keywords[k] = true
	}
}

type lexer struct {
	src       string
	i         int
	line, col int
}

// Tokenize splits src into tokens. The final token is always EOF.
func Tokenize(src string) ([]Token, error) {
	lx := &lexer{src: src, line: 1, col: 1}
	var toks []Token
	for {
		t, err := lx.next()
		if err != nil {
			return toks, err
		}
		toks = append(toks, t)
		if t.Kind == EOF {
			return toks, nil
		}
	}
}

func (lx *lexer) peekByte(off int) byte {
	if lx.i+off < len(lx.src) {
		return lx.src[lx.i+off]
	}
	return 0
}

func (lx *lexer) advance() byte {
	c := lx.src[lx.i]
	lx.i++
	if c == '\n' {
		lx.line++
		lx.col = 1
	} else {
		lx.col++
	}
	return c
}

func isLetter(c byte) bool { return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }
func isDigit(c byte) bool  { return c >= '0' && c <= '9' }

func (lx *lexer) skipSpace() error {
	for lx.i < len(lx.src) {
		c := lx.src[lx.i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			lx.advance()
		case c == '-' && lx.peekByte(1) == '-': // line comment
			for lx.i < len(lx.src) && lx.src[lx.i] != '\n' {
				lx.advance()
			}
		case c == '/' && lx.peekByte(1) == '*':
			pos := Pos{lx.line, lx.col}
			lx.advance()
			lx.advance()
			for {
				if lx.i >= len(lx.src) {
					return &Error{pos, "unterminated comment"}
				}
				if lx.src[lx.i] == '*' && lx.peekByte(1) == '/' {
					lx.advance()
					lx.advance()
					break
				}
				lx.advance()
			}
		default:
			return nil
		}
	}
	return nil
}

func (lx *lexer) next() (Token, error) {
	if err := lx.skipSpace(); err != nil {
		return Token{}, err
	}
	pos := Pos{lx.line, lx.col}
	if lx.i >= len(lx.src) {
		return Token{Kind: EOF, Pos: pos}, nil
	}
	c := lx.src[lx.i]
	switch {
	case isLetter(c):
		start := lx.i
		for lx.i < len(lx.src) && (isLetter(lx.src[lx.i]) || isDigit(lx.src[lx.i])) {
			lx.advance()
		}
		text := lx.src[start:lx.i]
		if up := strings.ToUpper(text); keywords[up] {
			return Token{Keyword, up, pos}, nil
		}
		return Token{Ident, text, pos}, nil
	case isDigit(c) || (c == '.' && isDigit(lx.peekByte(1))):
		return lx.number(pos)
	case c == '\'':
		return lx.str(pos)
	case c == '"':
		return lx.quotedIdent(pos)
	}
	// operators
	two := ""
	if lx.i+1 < len(lx.src) {
		two = lx.src[lx.i : lx.i+2]
	}
	switch two {
	case "<=", ">=", "!=", "<>", "==":
		lx.advance()
		lx.advance()
		if two == "<>" {
			two = "!="
		}
		if two == "==" {
			two = "="
		}
		return Token{Op, two, pos}, nil
	}
	switch c {
	case '(', ')', ',', ';', '*', '=', '<', '>', '+', '-', '/', '%', '.':
		lx.advance()
		return Token{Op, string(c), pos}, nil
	}
	if c == '!' {
		return Token{}, &Error{pos, "unexpected '!' (did you mean '!='?)"}
	}
	return Token{}, &Error{pos, fmt.Sprintf("unexpected character %q", rune(c))}
}

func (lx *lexer) number(pos Pos) (Token, error) {
	start := lx.i
	real := false
	for lx.i < len(lx.src) && isDigit(lx.src[lx.i]) {
		lx.advance()
	}
	if lx.i < len(lx.src) && lx.src[lx.i] == '.' {
		real = true
		lx.advance()
		for lx.i < len(lx.src) && isDigit(lx.src[lx.i]) {
			lx.advance()
		}
	}
	if lx.i < len(lx.src) && (lx.src[lx.i] == 'e' || lx.src[lx.i] == 'E') {
		save := *lx
		lx.advance()
		if lx.i < len(lx.src) && (lx.src[lx.i] == '+' || lx.src[lx.i] == '-') {
			lx.advance()
		}
		if lx.i < len(lx.src) && isDigit(lx.src[lx.i]) {
			real = true
			for lx.i < len(lx.src) && isDigit(lx.src[lx.i]) {
				lx.advance()
			}
		} else {
			*lx = save // not an exponent; leave the 'e' for the next token
		}
	}
	if lx.i < len(lx.src) && isLetter(lx.src[lx.i]) {
		return Token{}, &Error{Pos{lx.line, lx.col}, fmt.Sprintf("malformed number %q", lx.src[start:lx.i+1])}
	}
	kind := Integer
	if real {
		kind = Real
	}
	return Token{kind, lx.src[start:lx.i], pos}, nil
}

// str lexes a single-quoted string; ” is an escaped quote.
func (lx *lexer) str(pos Pos) (Token, error) {
	lx.advance() // opening quote
	var sb strings.Builder
	for {
		if lx.i >= len(lx.src) {
			return Token{}, &Error{pos, "unterminated string literal"}
		}
		c := lx.advance()
		if c == '\'' {
			if lx.peekByte(0) == '\'' {
				lx.advance()
				sb.WriteByte('\'')
				continue
			}
			return Token{String, sb.String(), pos}, nil
		}
		sb.WriteByte(c)
	}
}

// quotedIdent lexes "name"; "" is an escaped double quote.
func (lx *lexer) quotedIdent(pos Pos) (Token, error) {
	lx.advance()
	var sb strings.Builder
	for {
		if lx.i >= len(lx.src) {
			return Token{}, &Error{pos, "unterminated quoted identifier"}
		}
		c := lx.advance()
		if c == '"' {
			if lx.peekByte(0) == '"' {
				lx.advance()
				sb.WriteByte('"')
				continue
			}
			if sb.Len() == 0 {
				return Token{}, &Error{pos, "empty quoted identifier"}
			}
			return Token{Ident, sb.String(), pos}, nil
		}
		sb.WriteByte(c)
	}
}
