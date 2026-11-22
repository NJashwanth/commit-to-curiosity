package sql

import (
	"fmt"
	"strconv"
)

type parser struct {
	toks []Token
	i    int
}

// Parse parses zero or more semicolon-separated statements.
func Parse(src string) ([]Stmt, error) {
	toks, err := Tokenize(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	var out []Stmt
	for {
		for p.isOp(";") {
			p.i++
		}
		if p.cur().Kind == EOF {
			return out, nil
		}
		st, err := p.statement()
		if err != nil {
			return nil, err
		}
		out = append(out, st)
		if !p.isOp(";") && p.cur().Kind != EOF {
			return nil, p.errExpected("';' or end of input")
		}
	}
}

// ParseOne parses exactly one statement.
func ParseOne(src string) (Stmt, error) {
	stmts, err := Parse(src)
	if err != nil {
		return nil, err
	}
	if len(stmts) != 1 {
		return nil, &Error{Pos{1, 1}, fmt.Sprintf("expected exactly one statement, found %d", len(stmts))}
	}
	return stmts[0], nil
}

func (p *parser) cur() Token { return p.toks[p.i] }

func (p *parser) next() Token {
	t := p.toks[p.i]
	if t.Kind != EOF {
		p.i++
	}
	return t
}

func (p *parser) isKw(kw string) bool {
	t := p.cur()
	return t.Kind == Keyword && t.Text == kw
}
func (p *parser) isOp(op string) bool {
	t := p.cur()
	return t.Kind == Op && t.Text == op
}

func (p *parser) acceptKw(kw string) bool {
	if p.isKw(kw) {
		p.i++
		return true
	}
	return false
}
func (p *parser) acceptOp(op string) bool {
	if p.isOp(op) {
		p.i++
		return true
	}
	return false
}

func describe(t Token) string {
	switch t.Kind {
	case EOF:
		return "end of input"
	case String:
		return "string '" + t.Text + "'"
	case Keyword:
		return "keyword " + t.Text
	case Ident:
		return "identifier " + t.Text
	}
	return "'" + t.Text + "'"
}

func (p *parser) errExpected(what string) error {
	t := p.cur()
	return &Error{t.Pos, fmt.Sprintf("expected %s, found %s", what, describe(t))}
}

func (p *parser) expectKw(kw string) error {
	if !p.acceptKw(kw) {
		return p.errExpected(kw)
	}
	return nil
}
func (p *parser) expectOp(op string) error {
	if !p.acceptOp(op) {
		return p.errExpected("'" + op + "'")
	}
	return nil
}
func (p *parser) ident(what string) (string, error) {
	t := p.cur()
	if t.Kind != Ident {
		return "", p.errExpected(what)
	}
	p.i++
	return t.Text, nil
}

func (p *parser) statement() (Stmt, error) {
	t := p.cur()
	if t.Kind != Keyword {
		return nil, p.errExpected("a statement (CREATE, DROP, INSERT, SELECT, UPDATE, DELETE, BEGIN, COMMIT or ROLLBACK)")
	}
	switch t.Text {
	case "CREATE":
		return p.createTable()
	case "DROP":
		return p.dropTable()
	case "INSERT":
		return p.insert()
	case "SELECT":
		return p.selectStmt()
	case "UPDATE":
		return p.update()
	case "DELETE":
		return p.deleteStmt()
	case "BEGIN":
		p.next()
		p.acceptKw("TRANSACTION")
		return &Begin{}, nil
	case "COMMIT":
		p.next()
		p.acceptKw("TRANSACTION")
		return &Commit{}, nil
	case "ROLLBACK":
		p.next()
		p.acceptKw("TRANSACTION")
		return &Rollback{}, nil
	}
	return nil, p.errExpected("a statement (CREATE, DROP, INSERT, SELECT, UPDATE, DELETE, BEGIN, COMMIT or ROLLBACK)")
}

func (p *parser) createTable() (Stmt, error) {
	p.next() // CREATE
	if err := p.expectKw("TABLE"); err != nil {
		return nil, err
	}
	ct := &CreateTable{}
	if p.acceptKw("IF") {
		if err := p.expectKw("NOT"); err != nil {
			return nil, err
		}
		if err := p.expectKw("EXISTS"); err != nil {
			return nil, err
		}
		ct.IfNotExists = true
	}
	name, err := p.ident("table name")
	if err != nil {
		return nil, err
	}
	ct.Name = name
	if err := p.expectOp("("); err != nil {
		return nil, err
	}
	for {
		pos := p.cur().Pos
		col, err := p.ident("column name")
		if err != nil {
			return nil, err
		}
		def := ColumnDef{Name: col, Pos: pos}
		t := p.cur()
		if t.Kind != Keyword || (t.Text != "INTEGER" && t.Text != "REAL" && t.Text != "TEXT") {
			return nil, p.errExpected("a column type (INTEGER, REAL or TEXT)")
		}
		p.next()
		def.Type = t.Text
		if p.acceptKw("PRIMARY") {
			if err := p.expectKw("KEY"); err != nil {
				return nil, err
			}
			def.PrimaryKey = true
		}
		ct.Columns = append(ct.Columns, def)
		if p.acceptOp(",") {
			continue
		}
		break
	}
	if err := p.expectOp(")"); err != nil {
		return nil, err
	}
	return ct, nil
}

func (p *parser) dropTable() (Stmt, error) {
	p.next() // DROP
	if err := p.expectKw("TABLE"); err != nil {
		return nil, err
	}
	d := &DropTable{}
	if p.acceptKw("IF") {
		if err := p.expectKw("EXISTS"); err != nil {
			return nil, err
		}
		d.IfExists = true
	}
	name, err := p.ident("table name")
	if err != nil {
		return nil, err
	}
	d.Name = name
	return d, nil
}

func (p *parser) insert() (Stmt, error) {
	pos := p.next().Pos // INSERT
	if err := p.expectKw("INTO"); err != nil {
		return nil, err
	}
	name, err := p.ident("table name")
	if err != nil {
		return nil, err
	}
	ins := &Insert{Table: name, Pos: pos}
	if p.acceptOp("(") {
		for {
			c, err := p.ident("column name")
			if err != nil {
				return nil, err
			}
			ins.Columns = append(ins.Columns, c)
			if p.acceptOp(",") {
				continue
			}
			break
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
	}
	if err := p.expectKw("VALUES"); err != nil {
		return nil, err
	}
	for {
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		var row []Expr
		for {
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			row = append(row, e)
			if p.acceptOp(",") {
				continue
			}
			break
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		ins.Rows = append(ins.Rows, row)
		if p.acceptOp(",") {
			continue
		}
		break
	}
	return ins, nil
}

func (p *parser) selectStmt() (Stmt, error) {
	pos := p.next().Pos // SELECT
	sel := &Select{Pos: pos}
	for {
		if p.acceptOp("*") {
			sel.Items = append(sel.Items, SelectItem{Star: true})
		} else {
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			item := SelectItem{Expr: e}
			if p.acceptKw("AS") {
				a, err := p.ident("alias")
				if err != nil {
					return nil, err
				}
				item.Alias = a
			} else if p.cur().Kind == Ident {
				item.Alias = p.next().Text
			}
			sel.Items = append(sel.Items, item)
		}
		if p.acceptOp(",") {
			continue
		}
		break
	}
	if p.acceptKw("FROM") {
		name, err := p.ident("table name")
		if err != nil {
			return nil, err
		}
		sel.Table = name
	}
	if p.acceptKw("WHERE") {
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		sel.Where = e
	}
	if p.acceptKw("ORDER") {
		if err := p.expectKw("BY"); err != nil {
			return nil, err
		}
		for {
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			it := OrderItem{Expr: e}
			if p.acceptKw("DESC") {
				it.Desc = true
			} else {
				p.acceptKw("ASC")
			}
			sel.OrderBy = append(sel.OrderBy, it)
			if p.acceptOp(",") {
				continue
			}
			break
		}
	}
	if p.acceptKw("LIMIT") {
		n, err := p.nonNegInt("LIMIT")
		if err != nil {
			return nil, err
		}
		sel.Limit = &n
		if p.acceptKw("OFFSET") {
			m, err := p.nonNegInt("OFFSET")
			if err != nil {
				return nil, err
			}
			sel.Offset = &m
		}
	} else if p.isKw("OFFSET") {
		return nil, &Error{p.cur().Pos, "OFFSET requires LIMIT"}
	}
	return sel, nil
}

func (p *parser) nonNegInt(what string) (int64, error) {
	t := p.cur()
	if t.Kind != Integer {
		return 0, p.errExpected("a non-negative integer after " + what)
	}
	p.next()
	n, err := strconv.ParseInt(t.Text, 10, 64)
	if err != nil {
		return 0, &Error{t.Pos, "integer literal out of range"}
	}
	return n, nil
}

func (p *parser) update() (Stmt, error) {
	pos := p.next().Pos // UPDATE
	name, err := p.ident("table name")
	if err != nil {
		return nil, err
	}
	u := &Update{Table: name, Pos: pos}
	if err := p.expectKw("SET"); err != nil {
		return nil, err
	}
	for {
		cpos := p.cur().Pos
		col, err := p.ident("column name")
		if err != nil {
			return nil, err
		}
		if err := p.expectOp("="); err != nil {
			return nil, err
		}
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		u.Set = append(u.Set, Assignment{Column: col, Value: e, Pos: cpos})
		if p.acceptOp(",") {
			continue
		}
		break
	}
	if p.acceptKw("WHERE") {
		if u.Where, err = p.expr(); err != nil {
			return nil, err
		}
	}
	return u, nil
}

func (p *parser) deleteStmt() (Stmt, error) {
	pos := p.next().Pos // DELETE
	if err := p.expectKw("FROM"); err != nil {
		return nil, err
	}
	name, err := p.ident("table name")
	if err != nil {
		return nil, err
	}
	d := &Delete{Table: name, Pos: pos}
	if p.acceptKw("WHERE") {
		if d.Where, err = p.expr(); err != nil {
			return nil, err
		}
	}
	return d, nil
}

// Expression grammar, lowest to highest precedence:
//
//	or      := and { OR and }
//	and     := not { AND not }
//	not     := NOT not | compare
//	compare := add { (= != < <= > >=) add | IS [NOT] NULL | [NOT] LIKE add }
//	add     := mul { (+ -) mul }
//	mul     := unary { (* / %) unary }
//	unary   := - unary | primary
func (p *parser) expr() (Expr, error) { return p.orExpr() }

func (p *parser) orExpr() (Expr, error) {
	l, err := p.andExpr()
	if err != nil {
		return nil, err
	}
	for p.acceptKw("OR") {
		r, err := p.andExpr()
		if err != nil {
			return nil, err
		}
		l = &Binary{"OR", l, r}
	}
	return l, nil
}

func (p *parser) andExpr() (Expr, error) {
	l, err := p.notExpr()
	if err != nil {
		return nil, err
	}
	for p.acceptKw("AND") {
		r, err := p.notExpr()
		if err != nil {
			return nil, err
		}
		l = &Binary{"AND", l, r}
	}
	return l, nil
}

func (p *parser) notExpr() (Expr, error) {
	if p.acceptKw("NOT") {
		x, err := p.notExpr()
		if err != nil {
			return nil, err
		}
		return &Unary{"NOT", x}, nil
	}
	return p.compare()
}

func (p *parser) compare() (Expr, error) {
	l, err := p.add()
	if err != nil {
		return nil, err
	}
	for {
		t := p.cur()
		switch {
		case t.Kind == Op && (t.Text == "=" || t.Text == "!=" || t.Text == "<" || t.Text == "<=" || t.Text == ">" || t.Text == ">="):
			p.next()
			r, err := p.add()
			if err != nil {
				return nil, err
			}
			l = &Binary{t.Text, l, r}
		case p.isKw("IS"):
			p.next()
			not := p.acceptKw("NOT")
			if err := p.expectKw("NULL"); err != nil {
				return nil, err
			}
			l = &IsNull{l, not}
		case p.isKw("LIKE"), p.isKw("NOT") && p.toks[p.i+1].Kind == Keyword && p.toks[p.i+1].Text == "LIKE":
			not := p.acceptKw("NOT")
			p.next() // LIKE
			r, err := p.add()
			if err != nil {
				return nil, err
			}
			l = &Like{l, r, not}
		default:
			return l, nil
		}
	}
}

func (p *parser) add() (Expr, error) {
	l, err := p.mul()
	if err != nil {
		return nil, err
	}
	for p.isOp("+") || p.isOp("-") {
		op := p.next().Text
		r, err := p.mul()
		if err != nil {
			return nil, err
		}
		l = &Binary{op, l, r}
	}
	return l, nil
}

func (p *parser) mul() (Expr, error) {
	l, err := p.unary()
	if err != nil {
		return nil, err
	}
	for p.isOp("*") || p.isOp("/") || p.isOp("%") {
		op := p.next().Text
		r, err := p.unary()
		if err != nil {
			return nil, err
		}
		l = &Binary{op, l, r}
	}
	return l, nil
}

func (p *parser) unary() (Expr, error) {
	if p.isOp("-") {
		minus := p.next()
		// Fold "-5" into a literal so that -9223372036854775808 parses.
		if t := p.cur(); t.Kind == Integer || t.Kind == Real {
			p.next()
			return numberLiteral("-"+t.Text, t.Kind, minus.Pos)
		}
		x, err := p.unary()
		if err != nil {
			return nil, err
		}
		return &Unary{"-", x}, nil
	}
	return p.primary()
}

func numberLiteral(text string, kind TokenKind, pos Pos) (Expr, error) {
	if kind == Integer {
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return nil, &Error{pos, "integer literal out of range"}
		}
		return &Literal{Kind: LitInt, Int: n}, nil
	}
	f, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return nil, &Error{pos, "invalid number " + text}
	}
	return &Literal{Kind: LitReal, Real: f}, nil
}

var aggregates = map[string]bool{"COUNT": true, "SUM": true, "AVG": true, "MIN": true, "MAX": true}

func (p *parser) primary() (Expr, error) {
	t := p.cur()
	switch t.Kind {
	case Integer, Real:
		p.next()
		return numberLiteral(t.Text, t.Kind, t.Pos)
	case String:
		p.next()
		return &Literal{Kind: LitText, Text: t.Text}, nil
	case Keyword:
		if t.Text == "NULL" {
			p.next()
			return &Literal{Kind: LitNull}, nil
		}
	case Ident:
		p.next()
		if p.isOp("(") {
			return p.call(t)
		}
		return &ColumnRef{Name: t.Text, Pos: t.Pos}, nil
	case Op:
		if t.Text == "(" {
			p.next()
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			return e, nil
		}
	}
	return nil, p.errExpected("an expression")
}

func (p *parser) call(name Token) (Expr, error) {
	up := upper(name.Text)
	if !aggregates[up] {
		return nil, &Error{name.Pos, fmt.Sprintf("unknown function %s (supported: COUNT, SUM, AVG, MIN, MAX)", name.Text)}
	}
	p.next() // (
	c := &Call{Name: up, Pos: name.Pos}
	if p.acceptOp("*") {
		if up != "COUNT" {
			return nil, &Error{name.Pos, up + "(*) is not allowed; only COUNT(*)"}
		}
		c.Star = true
	} else {
		a, err := p.expr()
		if err != nil {
			return nil, err
		}
		c.Args = []Expr{a}
	}
	if err := p.expectOp(")"); err != nil {
		return nil, err
	}
	return c, nil
}

func upper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}
