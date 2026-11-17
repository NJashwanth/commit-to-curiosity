// Package hnsw implements a Hierarchical Navigable Small World graph
// (Malkov & Yashunin, "Efficient and robust approximate nearest neighbor
// search using Hierarchical Navigable Small World graphs", 2016) for
// approximate nearest neighbour search.
//
// Every node lives on layer 0. A node also appears on layers 1..L, where L
// is drawn from a geometric distribution, so each layer up has about 1/M as
// many nodes as the one below. Searches start at the top, sparse layer and
// greedily walk towards the query, dropping one layer each time they can't
// get closer, then do a wider best-first search on the dense bottom layer.
package hnsw

import (
	"fmt"
	"math"
	"math/rand/v2"
	"sync"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

// Defaults, as recommended by the paper and used by hnswlib.
const (
	DefaultM              = 16
	DefaultEfConstruction = 200
	DefaultEfSearch       = 64

	// levelCap bounds random levels. With M=2 the chance of reaching it is
	// 2^-32, so it never changes behaviour; it just keeps a corrupt RNG
	// from allocating absurd link tables.
	levelCap = 32
)

// Config holds the index parameters.
type Config struct {
	Dim    int
	Metric vecmath.Metric
	// M is the number of links a node keeps per layer above 0. Layer 0
	// allows 2*M, as the paper recommends. Zero means DefaultM.
	M int
	// EfConstruction is the candidate list size used when inserting.
	// Larger builds a better graph, slower. Zero means DefaultEfConstruction.
	EfConstruction int
	// EfSearch is the default candidate list size for queries. Zero means
	// DefaultEfSearch.
	EfSearch int
	// Seed seeds random level assignment, so builds are reproducible.
	Seed uint64
	// SimpleSelection keeps the M closest candidates as neighbors instead
	// of using the paper's diversity heuristic. Only useful to compare.
	SimpleSelection bool
	// KeepPrunedConnections refills a heuristic-pruned neighbor list up to
	// the cap with the closest pruned candidates.
	KeepPrunedConnections bool
}

func (c Config) withDefaults() Config {
	if c.M == 0 {
		c.M = DefaultM
	}
	if c.EfConstruction == 0 {
		c.EfConstruction = DefaultEfConstruction
	}
	if c.EfSearch == 0 {
		c.EfSearch = DefaultEfSearch
	}
	return c
}

func (c Config) validate() error {
	switch {
	case c.Dim < 1:
		return fmt.Errorf("hnsw: dim must be at least 1, got %d", c.Dim)
	case !c.Metric.Valid():
		return fmt.Errorf("hnsw: invalid metric %v", c.Metric)
	case c.M < 2 || c.M > 256:
		return fmt.Errorf("hnsw: M must be in [2, 256], got %d", c.M)
	case c.EfConstruction < 1:
		return fmt.Errorf("hnsw: efConstruction must be at least 1, got %d", c.EfConstruction)
	case c.EfSearch < 1:
		return fmt.Errorf("hnsw: efSearch must be at least 1, got %d", c.EfSearch)
	}
	return nil
}

// node is one vector and its adjacency lists, one per layer it is on.
type node struct {
	vec   []float32
	level int
	links [][]uint32 // links[layer]
}

// Index is an HNSW graph. Node ids are assigned densely from 0 in
// insertion order.
type Index struct {
	cfg    Config
	dist   vecmath.DistanceFunc
	mL     float64 // level multiplier, 1/ln(M)
	maxM   int     // link cap on layers >= 1
	maxM0  int     // link cap on layer 0
	pcg    *rand.PCG
	rng    *rand.Rand
	nodes  []*node
	entry  uint32 // entry point: a node on the top layer
	hasEnt bool
	top    int // highest layer in the graph

	scratch  sync.Pool      // *searchScratch for queries, which may run concurrently
	wscratch *searchScratch // for inserts, which are serialized
}

// New returns an empty index.
func New(cfg Config) (*Index, error) {
	cfg = cfg.withDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	pcg := rand.NewPCG(cfg.Seed, cfg.Seed^0xda3e39cb94b95bdb)
	return &Index{
		cfg:   cfg,
		dist:  cfg.Metric.Func(),
		mL:    1 / math.Log(float64(cfg.M)),
		maxM:  cfg.M,
		maxM0: 2 * cfg.M,
		pcg:   pcg,
		rng:   rand.New(pcg),
	}, nil
}

// Config returns the index configuration with defaults filled in.
func (h *Index) Config() Config { return h.cfg }

// Len returns the number of nodes in the graph.
func (h *Index) Len() int { return len(h.nodes) }

// MaxLevel returns the highest layer in the graph, or -1 if it is empty.
func (h *Index) MaxLevel() int {
	if !h.hasEnt {
		return -1
	}
	return h.top
}

// maxLinks is the adjacency cap for a layer: 2M on layer 0, M above.
func (h *Index) maxLinks(layer int) int {
	if layer == 0 {
		return h.maxM0
	}
	return h.maxM
}

// randomLevel draws a node's top layer: floor(-ln(U) · mL) with U uniform
// in (0, 1]. With mL = 1/ln(M), P(level >= l) = M^-l, so each layer has
// about 1/M of the nodes of the layer below.
func (h *Index) randomLevel() int {
	u := 1 - h.rng.Float64() // (0, 1]
	l := int(math.Floor(-math.Log(u) * h.mL))
	return min(l, levelCap)
}

func (h *Index) prepare(v []float32) ([]float32, error) {
	if len(v) != h.cfg.Dim {
		return nil, fmt.Errorf("hnsw: %w: index is %d-d, vector is %d-d", vecmath.ErrDimensionMismatch, h.cfg.Dim, len(v))
	}
	p, err := h.cfg.Metric.Prepare(v)
	if err != nil {
		return nil, fmt.Errorf("hnsw: %w", err)
	}
	return p, nil
}

// Insert adds v to the graph and returns its node id (Algorithm 1 in the
// paper).
func (h *Index) Insert(v []float32) (uint32, error) {
	vec, err := h.prepare(v)
	if err != nil {
		return 0, err
	}
	id := uint32(len(h.nodes))
	level := h.randomLevel()
	n := &node{vec: vec, level: level, links: make([][]uint32, level+1)}
	h.nodes = append(h.nodes, n)

	if !h.hasEnt {
		h.entry, h.top, h.hasEnt = id, level, true
		return id, nil
	}

	if h.wscratch == nil {
		h.wscratch = &searchScratch{}
	}
	s := h.wscratch

	// Phase 1: on layers above the new node's level, just walk greedily
	// towards it to find a good starting point one layer down.
	ep := candidate{h.entry, h.dist(vec, h.nodes[h.entry].vec)}
	for layer := h.top; layer > level; layer-- {
		ep = h.greedyClosest(vec, ep, layer)
	}

	// Phase 2: on every layer the node is on, find efConstruction
	// candidates, link to the best M of them, and link them back.
	eps := []candidate{ep}
	for layer := min(level, h.top); layer >= 0; layer-- {
		w := h.searchLayer(vec, eps, h.cfg.EfConstruction, layer, s)
		neighbors := h.selectNeighbors(w, h.cfg.M)
		links := make([]uint32, 0, h.maxLinks(layer))
		for _, nb := range neighbors {
			links = append(links, nb.id)
		}
		n.links[layer] = links
		for _, nb := range neighbors {
			h.addLink(nb.id, candidate{id, nb.dist}, layer)
		}
		if len(w) > 0 {
			eps = w
		}
	}

	if level > h.top {
		h.entry, h.top = id, level
	}
	return id, nil
}

// addLink adds a back-link from node `from` to c.id on layer. If that
// overflows the layer's cap, the node's links are re-selected from its
// current links plus the new one.
func (h *Index) addLink(from uint32, c candidate, layer int) {
	f := h.nodes[from]
	links := f.links[layer]
	limit := h.maxLinks(layer)
	if len(links) < limit {
		f.links[layer] = append(links, c.id)
		return
	}
	cands := make([]candidate, 0, len(links)+1)
	for _, id := range links {
		cands = append(cands, candidate{id, h.dist(f.vec, h.nodes[id].vec)})
	}
	cands = append(cands, c)
	sortCandidates(cands)
	kept := h.selectNeighbors(cands, limit)
	links = links[:0]
	for _, k := range kept {
		links = append(links, k.id)
	}
	f.links[layer] = links
}

// selectNeighbors picks up to m neighbors from candidates sorted closest
// to the base node first. With fewer than m candidates there is nothing to
// choose, so all are kept.
func (h *Index) selectNeighbors(cands []candidate, m int) []candidate {
	if len(cands) <= m {
		return cands
	}
	if h.cfg.SimpleSelection {
		return cands[:m]
	}
	return h.selectHeuristic(cands, m)
}

// selectHeuristic is SELECT-NEIGHBORS-HEURISTIC (Algorithm 4).
//
// Walking candidates from closest to furthest, a candidate e is kept only
// if it is closer to the base node than to every neighbor already kept. If
// some kept neighbor r is closer to e, then e is "behind" r: a search can
// reach e through r, so a direct link to e adds little. Skipping it leaves
// room for links in other directions, which is what lets searches cross
// between clusters instead of getting stuck inside one.
//
// Pruned candidates are optionally used to fill the list back up to m
// (keepPrunedConnections in the paper).
func (h *Index) selectHeuristic(cands []candidate, m int) []candidate {
	kept := make([]candidate, 0, m)
	var pruned []candidate
	for _, e := range cands {
		if len(kept) == m {
			break
		}
		ev := h.nodes[e.id].vec
		good := true
		for _, r := range kept {
			if h.dist(ev, h.nodes[r.id].vec) < e.dist {
				good = false
				break
			}
		}
		if good {
			kept = append(kept, e)
		} else if h.cfg.KeepPrunedConnections {
			pruned = append(pruned, e)
		}
	}
	for _, p := range pruned {
		if len(kept) == m {
			break
		}
		kept = append(kept, p)
	}
	return kept
}
