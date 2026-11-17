package vecmath

import "math/rand/v2"

// Clusters generates seeded synthetic data: points scattered around random
// centers with Gaussian noise. Real embeddings are clumpy rather than
// uniform, so this is closer to what a vector database sees than uniform
// noise. The same seed always gives the same vectors.
type Clusters struct {
	rng     *rand.Rand
	centers [][]float32
	spread  float64
}

// NewClusters makes a generator with k centers drawn uniformly from
// [-1, 1]^dim. Each sample is a random center plus N(0, spread²) noise per
// dimension.
func NewClusters(seed uint64, dim, k int, spread float64) *Clusters {
	rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	centers := make([][]float32, k)
	for i := range centers {
		c := make([]float32, dim)
		for j := range c {
			c[j] = float32(rng.Float64()*2 - 1)
		}
		centers[i] = c
	}
	return &Clusters{rng: rng, centers: centers, spread: spread}
}

// Sample returns one new point.
func (c *Clusters) Sample() []float32 {
	center := c.centers[c.rng.IntN(len(c.centers))]
	v := make([]float32, len(center))
	for j := range v {
		v[j] = center[j] + float32(c.rng.NormFloat64()*c.spread)
	}
	return v
}

// SampleN returns n new points.
func (c *Clusters) SampleN(n int) [][]float32 {
	out := make([][]float32, n)
	for i := range out {
		out[i] = c.Sample()
	}
	return out
}
