package hnsw

// candidate is a node id with its distance to the current query.
type candidate struct {
	id   uint32
	dist float32
}

// minHeap pops the closest candidate first. It is the "C" set in the paper:
// nodes still to expand.
type minHeap []candidate

func (h *minHeap) push(c candidate) {
	*h = append(*h, c)
	s := *h
	i := len(s) - 1
	for i > 0 {
		p := (i - 1) / 2
		if s[p].dist <= s[i].dist {
			break
		}
		s[p], s[i] = s[i], s[p]
		i = p
	}
}

func (h *minHeap) pop() candidate {
	s := *h
	top := s[0]
	last := len(s) - 1
	s[0] = s[last]
	s = s[:last]
	i := 0
	for {
		l := 2*i + 1
		if l >= len(s) {
			break
		}
		m := l
		if r := l + 1; r < len(s) && s[r].dist < s[l].dist {
			m = r
		}
		if s[i].dist <= s[m].dist {
			break
		}
		s[i], s[m] = s[m], s[i]
		i = m
	}
	*h = s
	return top
}

// maxHeap keeps the furthest candidate on top. It is the "W" set in the
// paper: the best ef found so far, where the top is the one to evict.
type maxHeap []candidate

func (h *maxHeap) top() candidate { return (*h)[0] }

func (h *maxHeap) push(c candidate) {
	*h = append(*h, c)
	s := *h
	i := len(s) - 1
	for i > 0 {
		p := (i - 1) / 2
		if s[p].dist >= s[i].dist {
			break
		}
		s[p], s[i] = s[i], s[p]
		i = p
	}
}

func (h *maxHeap) pop() candidate {
	s := *h
	top := s[0]
	last := len(s) - 1
	s[0] = s[last]
	s = s[:last]
	i := 0
	for {
		l := 2*i + 1
		if l >= len(s) {
			break
		}
		m := l
		if r := l + 1; r < len(s) && s[r].dist > s[l].dist {
			m = r
		}
		if s[i].dist >= s[m].dist {
			break
		}
		s[i], s[m] = s[m], s[i]
		i = m
	}
	*h = s
	return top
}

// sorted empties the heap into a new slice ordered closest first.
func (h *maxHeap) sorted() []candidate {
	out := make([]candidate, len(*h))
	for i := len(out) - 1; i >= 0; i-- {
		out[i] = h.pop()
	}
	return out
}
