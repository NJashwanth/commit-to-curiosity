package sql

import (
	"fmt"
	"strings"
)

// Stmt is any SQL statement.
type Stmt interface{ stmtNode() }

// Expr is any expression.
type Expr interface {
	exprNode()
	String() string
}

type ColumnDef struct {
	Name       string
	Type       string // INTEGER, REAL or TEXT
	PrimaryKey bool
	Pos        Pos
}

type CreateTable struct {
	Name        string
	Columns     []ColumnDef
	IfNotExists bool
}

type DropTable struct {
	Name     string
	IfExists bool
}

type Insert struct {
	Table   string
	Columns []string // empty means all columns in table order
	Rows    [][]Expr
	Pos     Pos
}

// SelectItem is one entry in a select list: * or an expression with an alias.
type SelectItem struct {
	Star  bool
	Expr  Expr
	Alias string
}

type OrderItem struct {
	Expr Expr
	Desc bool
}

type Select struct {
	Items   []SelectItem
	Table   string
	Where   Expr
	OrderBy []OrderItem
	Limit   *int64
	Offset  *int64
	Pos     Pos
}

type Assignment struct {
	Column string
	Value  Expr
	Pos    Pos
}

type Update struct {
	Table string
	Set   []Assignment
	Where Expr
	Pos   Pos
}

type Delete struct {
	Table string
	Where Expr
	Pos   Pos
}

type Begin struct{}
type Commit struct{}
type Rollback struct{}

func (*CreateTable) stmtNode() {}
func (*DropTable) stmtNode()   {}
func (*Insert) stmtNode()      {}
func (*Select) stmtNode()      {}
func (*Update) stmtNode()      {}
func (*Delete) stmtNode()      {}
func (*Begin) stmtNode()       {}
func (*Commit) stmtNode()      {}
func (*Rollback) stmtNode()    {}

// LitKind is the type of a literal.
type LitKind int

const (
	LitNull LitKind = iota
	LitInt
	LitReal
	LitText
)

// Literal is a constant.
type Literal struct {
	Kind LitKind
	Int  int64
	Real float64
	Text string
}

// ColumnRef names a column.
type ColumnRef struct {
	Name string
	Pos  Pos
}

// Unary is "-x" or "NOT x".
type Unary struct {
	Op string // "-" or "NOT"
	X  Expr
}

// Binary covers arithmetic, comparison, AND and OR.
type Binary struct {
	Op   string // + - * / % = != < <= > >= AND OR
	L, R Expr
}

// IsNull is "x IS [NOT] NULL".
type IsNull struct {
	X   Expr
	Not bool
}

// Like is "x [NOT] LIKE pattern".
type Like struct {
	X, Pattern Expr
	Not        bool
}

// Call is a function call; only aggregates exist.
type Call struct {
	Name string // upper-case
	Args []Expr
	Star bool // COUNT(*)
	Pos  Pos
}

func (*Literal) exprNode()   {}
func (*ColumnRef) exprNode() {}
func (*Unary) exprNode()     {}
func (*Binary) exprNode()    {}
func (*IsNull) exprNode()    {}
func (*Like) exprNode()      {}
func (*Call) exprNode()      {}

func (l *Literal) String() string {
	switch l.Kind {
	case LitInt:
		return fmt.Sprint(l.Int)
	case LitReal:
		return fmt.Sprint(l.Real)
	case LitText:
		return "'" + strings.ReplaceAll(l.Text, "'", "''") + "'"
	}
	return "NULL"
}
func (c *ColumnRef) String() string { return c.Name }
func (u *Unary) String() string {
	if u.Op == "NOT" {
		return "(NOT " + u.X.String() + ")"
	}
	return "(" + u.Op + u.X.String() + ")"
}
func (b *Binary) String() string { return "(" + b.L.String() + " " + b.Op + " " + b.R.String() + ")" }
func (n *IsNull) String() string {
	if n.Not {
		return "(" + n.X.String() + " IS NOT NULL)"
	}
	return "(" + n.X.String() + " IS NULL)"
}
func (l *Like) String() string {
	op := " LIKE "
	if l.Not {
		op = " NOT LIKE "
	}
	return "(" + l.X.String() + op + l.Pattern.String() + ")"
}
func (c *Call) String() string {
	if c.Star {
		return c.Name + "(*)"
	}
	parts := make([]string, len(c.Args))
	for i, a := range c.Args {
		parts[i] = a.String()
	}
	return c.Name + "(" + strings.Join(parts, ", ") + ")"
}
