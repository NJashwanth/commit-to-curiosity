package vecmath

import (
	"slices"
	"testing"
)

func TestClustersSeeded(t *testing.T) {
	a := NewClusters(42, 16, 5, 0.1).SampleN(50)
	b := NewClusters(42, 16, 5, 0.1).SampleN(50)
	c := NewClusters(43, 16, 5, 0.1).SampleN(50)
	for i := range a {
		if len(a[i]) != 16 {
			t.Fatalf("dim = %d, want 16", len(a[i]))
		}
		if !slices.Equal(a[i], b[i]) {
			t.Fatal("same seed gave different vectors")
		}
	}
	if slices.Equal(a[0], c[0]) {
		t.Error("different seeds gave the same first vector")
	}
}

// Points should sit close to one of the centers: with spread 0.05 in 16-d
// the expected distance to the center is about 0.05*sqrt(16) = 0.2.
func TestClustersAreClustered(t *testing.T) {
	g := NewClusters(7, 16, 4, 0.05)
	for _, p := range g.SampleN(200) {
		best := float32(1e9)
		for _, c := range g.centers {
			d, _ := L2(p, c)
			best = min(best, d)
		}
		if best > 0.5 {
			t.Fatalf("point is %.3f from the nearest center, want < 0.5", best)
		}
	}
}
