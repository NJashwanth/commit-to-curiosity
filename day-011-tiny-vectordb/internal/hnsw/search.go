package hnsw

import "errors"

// ErrInvalidK is returned when k < 1.
var ErrInvalidK = errors.New("k must be at least 1")

// Result is one search hit. Smaller distances are closer.
type Result struct {
	ID       uint32
	Distance float32
}

// Search returns approximately the k nearest nodes to q, closest first
// (Algorithm 5 in the paper). ef is the size of the candidate list on
// layer 0: larger ef means better recall and slower queries. ef <= 0 uses
// the index's EfSearch, and ef is always raised to at least k.
func (h *Index) Search(q []float32, k, ef int) ([]Result, error) {
	if k < 1 {
		return nil, ErrInvalidK
	}
	qv, err := h.prepare(q)
	if err != nil {
		return nil, err
	}
	if !h.hasEnt {
		return nil, nil
	}
	if ef <= 0 {
		ef = h.cfg.EfSearch
	}
	ef = max(ef, k)

	s := h.getScratch()
	defer h.putScratch(s)

	// Descend: greedy on every layer above 0, each layer's result becoming
	// the next layer's entry point.
	ep := candidate{h.entry, h.dist(qv, h.nodes[h.entry].vec)}
	for layer := h.top; layer > 0; layer-- {
		ep = h.greedyClosest(qv, ep, layer)
	}
	// Then a best-first search with ef candidates on the full bottom layer.
	w := h.searchLayer(qv, []candidate{ep}, ef, 0, s)

	out := make([]Result, 0, min(k, len(w)))
	for _, c := range w[:min(k, len(w))] {
		out = append(out, Result{ID: c.id, Distance: c.dist})
	}
	return out, nil
}
