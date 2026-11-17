package hnsw

import "slices"

// visitedSet marks nodes seen during one layer search. Instead of clearing
// the marks between searches it bumps a generation counter, so a reset is
// O(1) rather than O(n).
type visitedSet struct {
	marks []uint32
	gen   uint32
}

func (v *visitedSet) reset(n int) {
	if len(v.marks) < n {
		v.marks = make([]uint32, n+n/4+64)
		v.gen = 0
	}
	v.gen++
	if v.gen == 0 { // wrapped: old marks could collide, so really clear
		clear(v.marks)
		v.gen = 1
	}
}

// visit marks id and reports whether it was already marked.
func (v *visitedSet) visit(id uint32) bool {
	if v.marks[id] == v.gen {
		return true
	}
	v.marks[id] = v.gen
	return false
}

// searchScratch is the per-search working memory, pooled so a query
// doesn't allocate a visited array the size of the graph.
type searchScratch struct {
	visited visitedSet
	cand    minHeap
	res     maxHeap
}

func (h *Index) getScratch() *searchScratch {
	if s, ok := h.scratch.Get().(*searchScratch); ok {
		return s
	}
	return &searchScratch{}
}

func (h *Index) putScratch(s *searchScratch) { h.scratch.Put(s) }

// greedyClosest walks from ep to whichever neighbor is closer to q, until
// no neighbor is. This is SEARCH-LAYER with ef = 1, used on the upper
// layers where we only need a good entry point for the next layer down.
func (h *Index) greedyClosest(q []float32, ep candidate, layer int) candidate {
	cur := ep
	for changed := true; changed; {
		changed = false
		for _, nb := range h.nodes[cur.id].links[layer] {
			if d := h.dist(q, h.nodes[nb].vec); d < cur.dist {
				cur = candidate{nb, d}
				changed = true
			}
		}
	}
	return cur
}

// searchLayer is SEARCH-LAYER (Algorithm 2): a best-first search from eps
// that keeps the ef closest nodes found on one layer. It returns them
// closest first.
//
// C (cand) is a min-heap of nodes to expand; W (res) is a max-heap of the
// best ef so far. We stop when the closest unexpanded node is further than
// the worst result, because expanding it can't improve W.
func (h *Index) searchLayer(q []float32, eps []candidate, ef, layer int, s *searchScratch) []candidate {
	s.visited.reset(len(h.nodes))
	s.cand = s.cand[:0]
	s.res = s.res[:0]

	for _, e := range eps {
		if s.visited.visit(e.id) {
			continue
		}
		s.cand.push(e)
		s.res.push(e)
		if len(s.res) > ef {
			s.res.pop()
		}
	}

	for len(s.cand) > 0 {
		c := s.cand.pop()
		if len(s.res) >= ef && c.dist > s.res.top().dist {
			break
		}
		for _, nb := range h.nodes[c.id].links[layer] {
			if s.visited.visit(nb) {
				continue
			}
			d := h.dist(q, h.nodes[nb].vec)
			if len(s.res) < ef || d < s.res.top().dist {
				s.cand.push(candidate{nb, d})
				s.res.push(candidate{nb, d})
				if len(s.res) > ef {
					s.res.pop()
				}
			}
		}
	}
	return s.res.sorted()
}

// sortCandidates orders closest first, ties by id.
func sortCandidates(c []candidate) {
	slices.SortFunc(c, func(a, b candidate) int {
		switch {
		case a.dist < b.dist:
			return -1
		case a.dist > b.dist:
			return 1
		case a.id < b.id:
			return -1
		case a.id > b.id:
			return 1
		}
		return 0
	})
}
