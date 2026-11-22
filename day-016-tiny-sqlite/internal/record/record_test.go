package record

import (
	"errors"
	"math"
	"math/rand"
	"strings"
	"testing"
)

func roundTrip(t *testing.T, row []Value) {
	t.Helper()
	got, err := Decode(Encode(row))
	if err != nil {
		t.Fatalf("Decode: %v (row %v)", err, row)
	}
	if len(got) != len(row) {
		t.Fatalf("len %d, want %d", len(got), len(row))
	}
	for i := range row {
		if got[i].Kind != row[i].Kind || got[i] != row[i] {
			t.Errorf("col %d: got %+v want %+v", i, got[i], row[i])
		}
	}
}

func TestRoundTripAllTypes(t *testing.T) {
	roundTrip(t, []Value{NewInt(1), NewText("Jash"), NewInt(27), NewReal(98.5)})
	roundTrip(t, []Value{NullValue(), NullValue()})
	roundTrip(t, nil)
	roundTrip(t, []Value{NewText("")})
	roundTrip(t, []Value{NewInt(0), NewInt(-1), NewInt(math.MaxInt64), NewInt(math.MinInt64)})
	roundTrip(t, []Value{NewReal(0), NewReal(-0.5), NewReal(math.MaxFloat64),
		NewReal(math.SmallestNonzeroFloat64), NewReal(math.Inf(1)), NewReal(math.Inf(-1))})
}

func TestRoundTripUnicodeAndBinaryishText(t *testing.T) {
	for _, s := range []string{"héllo", "世界", "🙂🙃", "Ünïcödé ñ", "a\x00b", "tab\tnew\nline", strings.Repeat("é", 500)} {
		roundTrip(t, []Value{NewText(s), NullValue(), NewText(s + "!")})
	}
}

func TestRealNaNRoundTrips(t *testing.T) {
	got, err := Decode(Encode([]Value{NewReal(math.NaN())}))
	if err != nil || !math.IsNaN(got[0].Real) {
		t.Errorf("%v %v", got, err)
	}
}

func TestRoundTripRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 500; i++ {
		n := rng.Intn(12)
		row := make([]Value, n)
		for j := range row {
			switch rng.Intn(4) {
			case 0:
				row[j] = NullValue()
			case 1:
				row[j] = NewInt(rng.Int63() - rng.Int63())
			case 2:
				row[j] = NewReal(rng.NormFloat64() * 1e6)
			default:
				b := make([]byte, rng.Intn(40))
				for k := range b {
					b[k] = byte('a' + rng.Intn(26))
				}
				row[j] = NewText(string(b))
			}
		}
		roundTrip(t, row)
	}
}

func TestSmallIntegersAreCompact(t *testing.T) {
	if n := len(Encode([]Value{NewInt(5)})); n != 3 { // count + tag + 1 varint byte
		t.Errorf("encoded size %d", n)
	}
}

func TestDecodeErrors(t *testing.T) {
	good := Encode([]Value{NewInt(300), NewReal(1.5), NewText("abc")})
	for cut := 0; cut < len(good); cut++ {
		if _, err := Decode(good[:cut]); !errors.Is(err, ErrCorrupt) {
			t.Errorf("truncated to %d bytes: err = %v", cut, err)
		}
	}
	if _, err := Decode(append(append([]byte(nil), good...), 0)); !errors.Is(err, ErrCorrupt) {
		t.Errorf("trailing byte: %v", err)
	}
	if _, err := Decode([]byte{1, 9}); !errors.Is(err, ErrCorrupt) {
		t.Errorf("unknown tag: %v", err)
	}
	if _, err := Decode([]byte{1, 3, 100, 'a'}); !errors.Is(err, ErrCorrupt) {
		t.Errorf("text length past end: %v", err)
	}
	if _, err := Decode([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01}); !errors.Is(err, ErrCorrupt) {
		t.Errorf("huge count: %v", err)
	}
}

func TestCompare(t *testing.T) {
	order := []Value{
		NullValue(), NewInt(-5), NewReal(-1.5), NewInt(0), NewReal(0.5), NewInt(1), NewReal(2.5),
		NewText(""), NewText("a"), NewText("ab"), NewText("b"),
	}
	for i := range order {
		for j := range order {
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := Compare(order[i], order[j]); got != want {
				t.Errorf("Compare(%v, %v) = %d, want %d", order[i], order[j], got, want)
			}
		}
	}
	if Compare(NewInt(2), NewReal(2.0)) != 0 || Compare(NewReal(2.0), NewInt(2)) != 0 {
		t.Error("2 and 2.0 should compare equal")
	}
	if Compare(NullValue(), NullValue()) != 0 {
		t.Error("NULL vs NULL")
	}
	if Compare(NewInt(math.MaxInt64), NewInt(math.MaxInt64-1)) != 1 {
		t.Error("large ints must compare exactly")
	}
}

func TestStringAndFormatReal(t *testing.T) {
	cases := map[string]Value{
		"NULL": NullValue(), "42": NewInt(42), "-7": NewInt(-7), "98.5": NewReal(98.5),
		"100.0": NewReal(100), "-0.25": NewReal(-0.25), "1e+21": NewReal(1e21), "hello": NewText("hello"),
		"Inf": NewReal(math.Inf(1)), "-Inf": NewReal(math.Inf(-1)), "NaN": NewReal(math.NaN()),
		"0.1": NewReal(0.1), "2359229.83": NewReal(2359229.83), "123456789012345.0": NewReal(123456789012345),
		"1e+15": NewReal(1e15), "0.0001": NewReal(0.0001), "1e-05": NewReal(0.00001), "0.0": NewReal(0), "-1234567.5": NewReal(-1234567.5),
	}
	for want, v := range cases {
		if got := v.String(); got != want {
			t.Errorf("String() = %q, want %q", got, want)
		}
	}
}

func TestKindHelpers(t *testing.T) {
	for _, k := range []Kind{Null, Integer, Real, Text} {
		if k == Null {
			continue
		}
		got, ok := ParseKind(strings.ToLower(k.String()))
		if !ok || got != k {
			t.Errorf("ParseKind(%v)", k)
		}
	}
	if _, ok := ParseKind("BLOB"); ok {
		t.Error("BLOB should not parse")
	}
	if Kind(9).String() != "Kind(9)" || Null.String() != "NULL" {
		t.Error("Kind.String")
	}
	if !NullValue().IsNull() || NewInt(0).IsNull() {
		t.Error("IsNull")
	}
	if f, ok := NewInt(3).AsFloat(); !ok || f != 3 {
		t.Error("AsFloat int")
	}
	if f, ok := NewReal(2.5).AsFloat(); !ok || f != 2.5 {
		t.Error("AsFloat real")
	}
	if _, ok := NewText("3").AsFloat(); ok {
		t.Error("AsFloat text")
	}
	if NewBool(true).Int != 1 || NewBool(false).Int != 0 {
		t.Error("NewBool")
	}
}
