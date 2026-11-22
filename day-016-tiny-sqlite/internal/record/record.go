// Package record defines SQL values and their on-disk row encoding.
//
// A row is encoded as a uvarint column count followed by one cell per column:
//
//	0x00                      NULL
//	0x01 zigzag-varint        INTEGER
//	0x02 8 bytes (LE IEEE754) REAL
//	0x03 uvarint len, bytes   TEXT (UTF-8)
package record

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Kind is a value's type (and a column's declared type).
type Kind uint8

const (
	Null Kind = iota
	Integer
	Real
	Text
)

func (k Kind) String() string {
	switch k {
	case Null:
		return "NULL"
	case Integer:
		return "INTEGER"
	case Real:
		return "REAL"
	case Text:
		return "TEXT"
	}
	return fmt.Sprintf("Kind(%d)", uint8(k))
}

// ParseKind converts a type name such as "INTEGER" to a Kind.
func ParseKind(s string) (Kind, bool) {
	switch strings.ToUpper(s) {
	case "INTEGER":
		return Integer, true
	case "REAL":
		return Real, true
	case "TEXT":
		return Text, true
	}
	return Null, false
}

// Value is a single SQL value.
type Value struct {
	Kind Kind
	Int  int64
	Real float64
	Text string
}

func NullValue() Value        { return Value{} }
func NewInt(i int64) Value    { return Value{Kind: Integer, Int: i} }
func NewReal(f float64) Value { return Value{Kind: Real, Real: f} }
func NewText(s string) Value  { return Value{Kind: Text, Text: s} }
func NewBool(b bool) Value {
	if b {
		return NewInt(1)
	}
	return NewInt(0)
}

func (v Value) IsNull() bool { return v.Kind == Null }

// AsFloat returns the numeric value as float64 (false for NULL and TEXT).
func (v Value) AsFloat() (float64, bool) {
	switch v.Kind {
	case Integer:
		return float64(v.Int), true
	case Real:
		return v.Real, true
	}
	return 0, false
}

// String renders the value the way the REPL prints it.
func (v Value) String() string {
	switch v.Kind {
	case Integer:
		return strconv.FormatInt(v.Int, 10)
	case Real:
		return FormatReal(v.Real)
	case Text:
		return v.Text
	}
	return "NULL"
}

// FormatReal prints the shortest representation that round-trips and always
// shows that the value is a real (98.5, 100.0, 1e+20).
func FormatReal(f float64) string {
	switch {
	case math.IsInf(f, 1):
		return "Inf"
	case math.IsInf(f, -1):
		return "-Inf"
	case math.IsNaN(f):
		return "NaN"
	}
	// Shortest round-trip digits; plain notation for everyday magnitudes,
	// exponent form only for very large or very small numbers.
	var s string
	if a := math.Abs(f); a == 0 || (a >= 1e-4 && a < 1e15) {
		s = strconv.FormatFloat(f, 'f', -1, 64)
	} else {
		s = strconv.FormatFloat(f, 'g', -1, 64)
	}
	if !strings.ContainsAny(s, ".e") {
		s += ".0"
	}
	return s
}

func class(k Kind) int {
	switch k {
	case Null:
		return 0
	case Integer, Real:
		return 1
	}
	return 2
}

// Compare orders values: NULL < numbers < text. Integers and reals compare
// numerically with each other. It returns -1, 0 or 1.
func Compare(a, b Value) int {
	ca, cb := class(a.Kind), class(b.Kind)
	if ca != cb {
		if ca < cb {
			return -1
		}
		return 1
	}
	switch ca {
	case 0:
		return 0
	case 2:
		return strings.Compare(a.Text, b.Text)
	}
	if a.Kind == Integer && b.Kind == Integer {
		switch {
		case a.Int < b.Int:
			return -1
		case a.Int > b.Int:
			return 1
		}
		return 0
	}
	fa, _ := a.AsFloat()
	fb, _ := b.AsFloat()
	switch {
	case fa < fb:
		return -1
	case fa > fb:
		return 1
	}
	return 0
}

// ErrCorrupt is returned when bytes are not a valid record.
var ErrCorrupt = errors.New("corrupt record")

// Encode serializes a row.
func Encode(vals []Value) []byte {
	buf := make([]byte, 0, 8+len(vals)*9)
	buf = binary.AppendUvarint(buf, uint64(len(vals)))
	for _, v := range vals {
		switch v.Kind {
		case Null:
			buf = append(buf, 0)
		case Integer:
			buf = append(buf, 1)
			buf = binary.AppendVarint(buf, v.Int)
		case Real:
			buf = append(buf, 2)
			buf = binary.LittleEndian.AppendUint64(buf, math.Float64bits(v.Real))
		case Text:
			buf = append(buf, 3)
			buf = binary.AppendUvarint(buf, uint64(len(v.Text)))
			buf = append(buf, v.Text...)
		}
	}
	return buf
}

// Decode parses a row produced by Encode.
func Decode(b []byte) ([]Value, error) {
	n, w := binary.Uvarint(b)
	if w <= 0 || n > uint64(len(b)) {
		return nil, fmt.Errorf("%w: bad column count", ErrCorrupt)
	}
	b = b[w:]
	vals := make([]Value, 0, n)
	for i := uint64(0); i < n; i++ {
		if len(b) == 0 {
			return nil, fmt.Errorf("%w: truncated at column %d", ErrCorrupt, i)
		}
		tag := b[0]
		b = b[1:]
		switch tag {
		case 0:
			vals = append(vals, Value{})
		case 1:
			x, w := binary.Varint(b)
			if w <= 0 {
				return nil, fmt.Errorf("%w: bad integer in column %d", ErrCorrupt, i)
			}
			b = b[w:]
			vals = append(vals, NewInt(x))
		case 2:
			if len(b) < 8 {
				return nil, fmt.Errorf("%w: truncated real in column %d", ErrCorrupt, i)
			}
			vals = append(vals, NewReal(math.Float64frombits(binary.LittleEndian.Uint64(b))))
			b = b[8:]
		case 3:
			l, w := binary.Uvarint(b)
			if w <= 0 || l > uint64(len(b)-w) {
				return nil, fmt.Errorf("%w: bad text length in column %d", ErrCorrupt, i)
			}
			vals = append(vals, NewText(string(b[w:w+int(l)])))
			b = b[w+int(l):]
		default:
			return nil, fmt.Errorf("%w: unknown type tag %d in column %d", ErrCorrupt, tag, i)
		}
	}
	if len(b) != 0 {
		return nil, fmt.Errorf("%w: %d trailing bytes", ErrCorrupt, len(b))
	}
	return vals, nil
}
