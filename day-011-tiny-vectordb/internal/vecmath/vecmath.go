// Package vecmath has the vector math tiny-vectordb is built on: dot
// product, Euclidean (L2) distance, cosine similarity and normalization,
// plus a Metric type that turns each of them into a "smaller is closer"
// distance for the indexes.
package vecmath

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

var (
	// ErrDimensionMismatch is returned when two vectors have different lengths.
	ErrDimensionMismatch = errors.New("dimension mismatch")
	// ErrZeroVector is returned when a vector with no direction is used
	// where a direction is needed (cosine similarity, normalization).
	ErrZeroVector = errors.New("zero vector has no direction")
	// ErrNotFinite is returned for vectors containing NaN or ±Inf.
	ErrNotFinite = errors.New("vector contains NaN or Inf")
)

// CheckDims returns an error wrapping ErrDimensionMismatch if a and b differ in length.
func CheckDims(a, b []float32) error {
	if len(a) != len(b) {
		return fmt.Errorf("%w: %d vs %d", ErrDimensionMismatch, len(a), len(b))
	}
	return nil
}

// CheckFinite returns ErrNotFinite if any component is NaN or ±Inf.
func CheckFinite(v []float32) error {
	for i, x := range v {
		f := float64(x)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return fmt.Errorf("%w at index %d", ErrNotFinite, i)
		}
	}
	return nil
}

// Dot returns the dot product a·b.
func Dot(a, b []float32) (float32, error) {
	if err := CheckDims(a, b); err != nil {
		return 0, err
	}
	return dot(a, b), nil
}

// L2Squared returns the squared Euclidean distance ‖a-b‖².
func L2Squared(a, b []float32) (float32, error) {
	if err := CheckDims(a, b); err != nil {
		return 0, err
	}
	return l2sq(a, b), nil
}

// L2 returns the Euclidean distance ‖a-b‖.
func L2(a, b []float32) (float32, error) {
	d, err := L2Squared(a, b)
	if err != nil {
		return 0, err
	}
	return float32(math.Sqrt(float64(d))), nil
}

// Norm returns the Euclidean length ‖v‖.
func Norm(v []float32) float32 {
	return float32(math.Sqrt(float64(dot(v, v))))
}

// Cosine returns the cosine similarity a·b / (‖a‖‖b‖), clamped to [-1, 1].
// It returns ErrZeroVector if either vector is all zeros.
func Cosine(a, b []float32) (float32, error) {
	if err := CheckDims(a, b); err != nil {
		return 0, err
	}
	na, nb := Norm(a), Norm(b)
	if na == 0 || nb == 0 {
		return 0, ErrZeroVector
	}
	return clamp(dot(a, b)/(na*nb), -1, 1), nil
}

// Normalize returns a unit-length copy of v.
func Normalize(v []float32) ([]float32, error) {
	out := make([]float32, len(v))
	copy(out, v)
	if err := NormalizeInPlace(out); err != nil {
		return nil, err
	}
	return out, nil
}

// NormalizeInPlace scales v to unit length.
func NormalizeInPlace(v []float32) error {
	n := Norm(v)
	if n == 0 {
		return ErrZeroVector
	}
	inv := 1 / n
	for i := range v {
		v[i] *= inv
	}
	return nil
}

// Metric selects how distance between two vectors is measured.
type Metric uint8

const (
	// MetricCosine ranks by angle. Distance is 1 - cos(a, b), in [0, 2].
	MetricCosine Metric = iota + 1
	// MetricDot ranks by inner product. Distance is -(a·b), so larger dot products are closer.
	MetricDot
	// MetricL2 ranks by Euclidean distance ‖a-b‖.
	MetricL2
)

// String returns the metric's canonical name.
func (m Metric) String() string {
	switch m {
	case MetricCosine:
		return "cosine"
	case MetricDot:
		return "dot"
	case MetricL2:
		return "l2"
	}
	return fmt.Sprintf("Metric(%d)", uint8(m))
}

// Valid reports whether m is one of the known metrics.
func (m Metric) Valid() bool { return m >= MetricCosine && m <= MetricL2 }

// ParseMetric parses a metric name. It accepts "cosine", "dot" (or "ip",
// "inner_product") and "l2" (or "euclidean"), case-insensitively.
func ParseMetric(s string) (Metric, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "cosine", "cos":
		return MetricCosine, nil
	case "dot", "ip", "inner_product":
		return MetricDot, nil
	case "l2", "euclidean":
		return MetricL2, nil
	}
	return 0, fmt.Errorf("unknown metric %q (want cosine, dot or l2)", s)
}

// Distance returns a "smaller is closer" distance between a and b under m.
// Unlike Func, it checks dimensions and does not assume unit-length input.
func (m Metric) Distance(a, b []float32) (float32, error) {
	switch m {
	case MetricCosine:
		c, err := Cosine(a, b)
		if err != nil {
			return 0, err
		}
		return 1 - c, nil
	case MetricDot:
		d, err := Dot(a, b)
		return -d, err
	case MetricL2:
		return L2(a, b)
	}
	return 0, fmt.Errorf("invalid metric %v", m)
}

// Prepare validates v and returns the copy an index should store or search
// with: unit length for cosine, unchanged otherwise.
func (m Metric) Prepare(v []float32) ([]float32, error) {
	if err := CheckFinite(v); err != nil {
		return nil, err
	}
	if m == MetricCosine {
		return Normalize(v)
	}
	out := make([]float32, len(v))
	copy(out, v)
	return out, nil
}

// DistanceFunc is an unchecked distance kernel: both inputs must have the
// same length, and for cosine both must already be unit length.
type DistanceFunc func(a, b []float32) float32

// Func returns the fast kernel the indexes use for m. Vectors must be
// passed through Prepare first.
func (m Metric) Func() DistanceFunc {
	switch m {
	case MetricCosine:
		return func(a, b []float32) float32 { return 1 - dot(a, b) }
	case MetricDot:
		return func(a, b []float32) float32 { return -dot(a, b) }
	case MetricL2:
		return func(a, b []float32) float32 { return float32(math.Sqrt(float64(l2sq(a, b)))) }
	}
	return nil
}

// dot is the unchecked dot product, unrolled by 4 with independent
// accumulators so the loop isn't one long dependency chain.
func dot(a, b []float32) float32 {
	n := len(a)
	b = b[:n]
	var s0, s1, s2, s3 float32
	i := 0
	for ; i+4 <= n; i += 4 {
		aa := a[i : i+4 : i+4]
		bb := b[i : i+4 : i+4]
		s0 += aa[0] * bb[0]
		s1 += aa[1] * bb[1]
		s2 += aa[2] * bb[2]
		s3 += aa[3] * bb[3]
	}
	for ; i < n; i++ {
		s0 += a[i] * b[i]
	}
	return s0 + s1 + s2 + s3
}

// l2sq is the unchecked squared Euclidean distance.
func l2sq(a, b []float32) float32 {
	n := len(a)
	b = b[:n]
	var s0, s1, s2, s3 float32
	i := 0
	for ; i+4 <= n; i += 4 {
		aa := a[i : i+4 : i+4]
		bb := b[i : i+4 : i+4]
		d0 := aa[0] - bb[0]
		d1 := aa[1] - bb[1]
		d2 := aa[2] - bb[2]
		d3 := aa[3] - bb[3]
		s0 += d0 * d0
		s1 += d1 * d1
		s2 += d2 * d2
		s3 += d3 * d3
	}
	for ; i < n; i++ {
		d := a[i] - b[i]
		s0 += d * d
	}
	return s0 + s1 + s2 + s3
}

func clamp(x, lo, hi float32) float32 {
	return max(lo, min(hi, x))
}
