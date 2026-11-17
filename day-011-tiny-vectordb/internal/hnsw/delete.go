package hnsw

// Delete marks a node as a tombstone and reports whether it was live.
// The node stays in the graph, so paths through it still work, but it is
// never returned from a search. Cleanup removes tombstones for good.
func (h *Index) Delete(id uint32) bool {
	if !h.isLive(id) {
		return false
	}
	h.nodes[id].deleted = true
	h.live--
	h.tombs++
	return true
}

// Cleanup removes every tombstone from the graph and returns how many it
// removed.
//
// Simply cutting deleted nodes out would leave holes: a live node whose
// neighbors were mostly deleted could lose its only links into part of
// the graph. So each live node that links to a deleted node has that
// layer's links re-selected (with the same heuristic as insertion) from
// its live links plus the live links of its deleted neighbors, which
// bridges the paths that ran through them. Nodes left with no live
// candidates at all are relinked with a fresh search, and finally any
// live node that nothing links to any more is reconnected the same way.
func (h *Index) Cleanup() int {
	if h.tombs == 0 {
		return 0
	}
	removed := h.tombs

	if h.live == 0 {
		for i := range h.nodes {
			h.nodes[i] = nil
		}
		h.hasEnt, h.top, h.tombs = false, 0, 0
		return removed
	}

	// Pick a live entry point first: the relinking searches below start
	// from it, and the old entry may be a tombstone.
	h.chooseEntry()

	for id, n := range h.nodes {
		if n == nil || n.deleted {
			continue
		}
		for layer := 0; layer <= n.level; layer++ {
			h.repairLinks(uint32(id), layer)
		}
	}

	for i, n := range h.nodes {
		if n != nil && n.deleted {
			h.nodes[i] = nil
		}
	}
	h.tombs = 0
	h.reconnectOrphans()
	return removed
}

// chooseEntry makes the entry point the live node on the highest layer,
// keeping the current entry when it qualifies.
func (h *Index) chooseEntry() {
	best, bestLevel := uint32(0), -1
	for id, n := range h.nodes {
		if n != nil && !n.deleted && n.level > bestLevel {
			best, bestLevel = uint32(id), n.level
		}
	}
	if h.isLive(h.entry) && h.nodes[h.entry].level == bestLevel {
		best = h.entry
	}
	h.entry, h.top = best, bestLevel
}

// repairLinks replaces any links from id to deleted nodes on one layer.
func (h *Index) repairLinks(id uint32, layer int) {
	n := h.nodes[id]
	links := n.links[layer]
	dirty := false
	for _, x := range links {
		if !h.isLive(x) {
			dirty = true
			break
		}
	}
	if !dirty {
		return
	}

	seen := map[uint32]bool{id: true}
	var pool []candidate
	add := func(x uint32) {
		if !seen[x] && h.isLive(x) {
			seen[x] = true
			pool = append(pool, candidate{x, h.dist(n.vec, h.nodes[x].vec)})
		}
	}
	for _, x := range links {
		if h.isLive(x) {
			add(x)
			continue
		}
		for _, y := range h.nodes[x].links[layer] {
			add(y)
		}
	}
	if len(pool) == 0 {
		pool = h.searchNeighbors(id, layer)
	}
	sortCandidates(pool)
	kept := h.selectNeighbors(pool, h.maxLinks(layer))
	links = links[:0]
	for _, k := range kept {
		links = append(links, k.id)
	}
	n.links[layer] = links
}

// searchNeighbors finds link candidates for an existing node by searching
// the graph from the entry point, like Insert does, excluding the node
// itself.
func (h *Index) searchNeighbors(id uint32, layer int) []candidate {
	if h.wscratch == nil {
		h.wscratch = &searchScratch{}
	}
	vec := h.nodes[id].vec
	ep := candidate{h.entry, h.dist(vec, h.nodes[h.entry].vec)}
	for l := h.top; l > layer; l-- {
		ep = h.greedyClosest(vec, ep, l)
	}
	accept := func(x uint32) bool { return x != id && h.isLive(x) }
	return h.searchLayer(vec, []candidate{ep}, h.cfg.EfConstruction, layer, accept, h.wscratch)
}

// reconnectOrphans gives every live node that has no incoming link on a
// layer (other than the entry point) a fresh set of neighbors that link
// back to it, so it can be found again.
func (h *Index) reconnectOrphans() {
	for layer := 0; layer <= h.top; layer++ {
		indeg := make([]int32, len(h.nodes))
		for _, n := range h.nodes {
			if n != nil && n.level >= layer {
				for _, x := range n.links[layer] {
					indeg[x]++
				}
			}
		}
		for id, n := range h.nodes {
			if n == nil || n.level < layer || uint32(id) == h.entry || indeg[id] > 0 {
				continue
			}
			cands := h.searchNeighbors(uint32(id), layer)
			for _, c := range h.selectNeighbors(cands, h.cfg.M) {
				h.addLink(c.id, candidate{uint32(id), c.dist}, layer)
			}
		}
	}
}

// Stats summarizes the graph's shape.
type Stats struct {
	Live       int     `json:"live"`
	Tombstones int     `json:"tombstones"`
	MaxLevel   int     `json:"max_level"`
	LayerSizes []int   `json:"layer_sizes"` // nodes on each layer, bottom first
	AvgDegree0 float64 `json:"avg_degree_l0"`
}

// Stats returns node counts per layer and the mean layer-0 degree.
func (h *Index) Stats() Stats {
	st := Stats{Live: h.live, Tombstones: h.tombs, MaxLevel: h.MaxLevel()}
	if h.hasEnt {
		st.LayerSizes = make([]int, h.top+1)
	}
	links0 := 0
	for _, n := range h.nodes {
		if n == nil || n.deleted {
			continue
		}
		for l := 0; l <= min(n.level, h.top); l++ {
			st.LayerSizes[l]++
		}
		links0 += len(n.links[0])
	}
	if h.live > 0 {
		st.AvgDegree0 = float64(links0) / float64(h.live)
	}
	return st
}
