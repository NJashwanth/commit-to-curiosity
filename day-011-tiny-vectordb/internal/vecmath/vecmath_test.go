package vecmath

import (
	"errors"
	"math"
	"math/rand/v2"
	"testing"
)

const eps = 1e-5

func near(a, b float32) bool { return math.Abs(float64(a-b)) <= eps*max(1, math.Abs(float64(b))) }

func TestHandComputedValues(t *testing.T) {
	// 5 components so the unrolled loop and its tail both run.
	a := []float32{1, 2, 3, 4, 5}
	b := []float32{5, 4, 3, 2, 1}

	cases := []struct {
		name string
		fn   func(a, b []float32) (float32, error)
		want float32
	}{
		{"dot", Dot, 35},                         // 5+8+9+8+5
		{"l2squared", L2Squared, 40},             // 16+4+0+4+16
		{"l2", L2, float32(math.Sqrt(40))},       // 6.3245553
		{"cosine", Cosine, float32(35.0 / 55.0)}, // both norms are sqrt(55)
	}
	for _, c := range cases {
		got, err := c.fn(a, b)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !near(got, c.want) {
			t.Errorf("%s = %v, want %v", c.name, got, c.want)
		}
	}

	// A second pair, 3-d, checked by hand: a·b = 4-10+18 = 12, ‖a-b‖² = 9+49+9 = 67.
	x := []float32{1, 2, 3}
	y := []float32{4, -5, 6}
	if d, _ := Dot(x, y); d != 12 {
		t.Errorf("Dot = %v, want 12", d)
	}
	if d, _ := L2Squared(x, y); d != 67 {
		t.Errorf("L2Squared = %v, want 67", d)
	}
	if c, _ := Cosine(x, y); !near(c, float32(12/math.Sqrt(14*77))) {
		t.Errorf("Cosine = %v, want %v", c, 12/math.Sqrt(14*77))
	}
	if n := Norm([]float32{3, 4}); n != 5 {
		t.Errorf("Norm(3,4) = %v, want 5", n)
	}
}

func TestCosineEdgeCases(t *testing.T) {
	v := []float32{1, 2, 3}
	if c, _ := Cosine(v, v); !near(c, 1) {
		t.Errorf("cos(v, v) = %v, want 1", c)
	}
	neg := []float32{-1, -2, -3}
	if c, _ := Cosine(v, neg); !near(c, -1) {
		t.Errorf("cos(v, -v) = %v, want -1", c)
	}
	if c, _ := Cosine([]float32{1, 0}, []float32{0, 1}); c != 0 {
		t.Errorf("cos of orthogonal = %v, want 0", c)
	}
	// Scaling doesn't change cosine.
	if c, _ := Cosine(v, []float32{10, 20, 30}); !near(c, 1) {
		t.Errorf("cos(v, 10v) = %v, want 1", c)
	}
}

func TestZeroVectors(t *testing.T) {
	zero := []float32{0, 0, 0}
	v := []float32{1, 2, 3}

	if _, err := Cosine(zero, v); !errors.Is(err, ErrZeroVector) {
		t.Errorf("Cosine(zero, v) err = %v, want ErrZeroVector", err)
	}
	if _, err := Cosine(v, zero); !errors.Is(err, ErrZeroVector) {
		t.Errorf("Cosine(v, zero) err = %v, want ErrZeroVector", err)
	}
	if _, err := Normalize(zero); !errors.Is(err, ErrZeroVector) {
		t.Errorf("Normalize(zero) err = %v, want ErrZeroVector", err)
	}
	if _, err := MetricCosine.Prepare(zero); !errors.Is(err, ErrZeroVector) {
		t.Errorf("cosine Prepare(zero) err = %v, want ErrZeroVector", err)
	}
	// Dot and L2 are well defined for zero vectors.
	if d, err := Dot(zero, v); err != nil || d != 0 {
		t.Errorf("Dot(zero, v) = %v, %v; want 0, nil", d, err)
	}
	if d, err := L2(zero, []float32{3, 4, 0}); err != nil || d != 5 {
		t.Errorf("L2(zero, (3,4,0)) = %v, %v; want 5, nil", d, err)
	}
	if n := Norm(zero); n != 0 {
		t.Errorf("Norm(zero) = %v", n)
	}
	if p, err := MetricL2.Prepare(zero); err != nil || len(p) != 3 {
		t.Errorf("l2 Prepare(zero) = %v, %v", p, err)
	}
}

func TestDimensionMismatch(t *testing.T) {
	a := []float32{1, 2, 3}
	b := []float32{1, 2}
	fns := map[string]func(a, b []float32) (float32, error){
		"Dot": Dot, "L2": L2, "L2Squared": L2Squared, "Cosine": Cosine,
		"cosine.Distance": MetricCosine.Distance,
		"dot.Distance":    MetricDot.Distance,
		"l2.Distance":     MetricL2.Distance,
	}
	for name, fn := range fns {
		_, err := fn(a, b)
		if !errors.Is(err, ErrDimensionMismatch) {
			t.Errorf("%s: err = %v, want ErrDimensionMismatch", name, err)
		}
	}
	if err := CheckDims(a, b); err == nil || err.Error() != "dimension mismatch: 3 vs 2" {
		t.Errorf("CheckDims message = %v", err)
	}
}

func TestNormalize(t *testing.T) {
	v := []float32{3, 4}
	u, err := Normalize(v)
	if err != nil {
		t.Fatal(err)
	}
	if !near(u[0], 0.6) || !near(u[1], 0.8) {
		t.Errorf("Normalize(3,4) = %v, want (0.6, 0.8)", u)
	}
	if v[0] != 3 || v[1] != 4 {
		t.Error("Normalize modified its input")
	}
	if !near(Norm(u), 1) {
		t.Errorf("norm after Normalize = %v", Norm(u))
	}
	w := []float32{0, -2, 0}
	if err := NormalizeInPlace(w); err != nil || w[1] != -1 {
		t.Errorf("NormalizeInPlace = %v, %v", w, err)
	}
}

func TestNotFinite(t *testing.T) {
	nan := float32(math.NaN())
	inf := float32(math.Inf(1))
	for _, v := range [][]float32{{1, nan}, {inf, 1}, {float32(math.Inf(-1))}} {
		for _, m := range []Metric{MetricCosine, MetricDot, MetricL2} {
			if _, err := m.Prepare(v); !errors.Is(err, ErrNotFinite) {
				t.Errorf("%v.Prepare(%v) err = %v, want ErrNotFinite", m, v, err)
			}
		}
	}
	if err := CheckFinite([]float32{1, 2}); err != nil {
		t.Errorf("CheckFinite on finite = %v", err)
	}
}

func TestMetricDistanceAndFunc(t *testing.T) {
	a := []float32{1, 2, 3, 4, 5}
	b := []float32{5, 4, 3, 2, 1}
	want := map[Metric]float32{
		MetricCosine: 1 - 35.0/55.0,
		MetricDot:    -35,
		MetricL2:     float32(math.Sqrt(40)),
	}
	for m, w := range want {
		got, err := m.Distance(a, b)
		if err != nil || !near(got, w) {
			t.Errorf("%v.Distance = %v, %v; want %v", m, got, err, w)
		}
		// The fast kernel must agree once vectors are prepared.
		pa, _ := m.Prepare(a)
		pb, _ := m.Prepare(b)
		if f := m.Func()(pa, pb); !near(f, w) {
			t.Errorf("%v.Func = %v, want %v", m, f, w)
		}
	}
	if _, err := Metric(0).Distance(a, b); err == nil {
		t.Error("invalid metric Distance should fail")
	}
	if Metric(9).Func() != nil {
		t.Error("invalid metric Func should be nil")
	}
	if _, err := MetricCosine.Distance([]float32{0, 0}, []float32{1, 1}); !errors.Is(err, ErrZeroVector) {
		t.Errorf("cosine distance with zero vector: %v", err)
	}
}

func TestParseMetric(t *testing.T) {
	ok := map[string]Metric{
		"cosine": MetricCosine, "COS": MetricCosine, " cosine ": MetricCosine,
		"dot": MetricDot, "ip": MetricDot, "inner_product": MetricDot,
		"l2": MetricL2, "Euclidean": MetricL2,
	}
	for s, want := range ok {
		got, err := ParseMetric(s)
		if err != nil || got != want {
			t.Errorf("ParseMetric(%q) = %v, %v; want %v", s, got, err, want)
		}
		if !got.Valid() {
			t.Errorf("%v not valid", got)
		}
	}
	for _, s := range []string{"", "manhattan", "l1"} {
		if _, err := ParseMetric(s); err == nil {
			t.Errorf("ParseMetric(%q) should fail", s)
		}
	}
	for m, s := range map[Metric]string{MetricCosine: "cosine", MetricDot: "dot", MetricL2: "l2", 7: "Metric(7)"} {
		if m.String() != s {
			t.Errorf("String() = %q, want %q", m.String(), s)
		}
	}
	if Metric(0).Valid() || Metric(4).Valid() {
		t.Error("out of range metrics should be invalid")
	}
}

// The unrolled kernels must match a plain loop for every length, including
// the 0-3 element tails.
func TestKernelsMatchNaive(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for n := 0; n <= 37; n++ {
		a := make([]float32, n)
		b := make([]float32, n)
		var wantDot, wantL2 float64
		for i := range a {
			a[i] = float32(rng.NormFloat64())
			b[i] = float32(rng.NormFloat64())
			wantDot += float64(a[i]) * float64(b[i])
			d := float64(a[i]) - float64(b[i])
			wantL2 += d * d
		}
		if got := dot(a, b); math.Abs(float64(got)-wantDot) > 1e-4 {
			t.Errorf("n=%d dot = %v, want %v", n, got, wantDot)
		}
		if got := l2sq(a, b); math.Abs(float64(got)-wantL2) > 1e-4 {
			t.Errorf("n=%d l2sq = %v, want %v", n, got, wantL2)
		}
	}
}

func BenchmarkDot128(b *testing.B) {
	rng := rand.New(rand.NewPCG(1, 2))
	x := make([]float32, 128)
	y := make([]float32, 128)
	for i := range x {
		x[i], y[i] = rng.Float32(), rng.Float32()
	}
	var s float32
	for b.Loop() {
		s += dot(x, y)
	}
	_ = s
}
