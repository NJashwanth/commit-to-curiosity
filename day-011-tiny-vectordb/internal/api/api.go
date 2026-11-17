// Package api serves a store.DB over HTTP with JSON bodies.
//
//	GET    /health
//	GET    /stats
//	POST   /collections                     create  {"name", "dim", "metric", "m", "ef_construction", "ef_search"}
//	GET    /collections                     list
//	GET    /collections/{name}              info
//	DELETE /collections/{name}              drop
//	POST   /collections/{name}/upsert       {"items": [{"id", "vector", "metadata"}]}
//	GET    /collections/{name}/items/{id}   get by id
//	DELETE /collections/{name}/items/{id}   delete by id
//	POST   /collections/{name}/query        {"vector", "k", "ef", "filter", "include_vectors"}
//	POST   /collections/{name}/snapshot     write the snapshot now
//
// Errors are {"error": "..."} with 400 for invalid input, 404 for unknown
// collections or ids, 409 for duplicate collections, 413 for oversized
// bodies and 500 otherwise.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/store"
)

// MaxBodyBytes caps request bodies. A batch of 10,000 768-d vectors as
// JSON is roughly 80 MB, so this allows large batches but not unbounded ones.
const MaxBodyBytes = 128 << 20

// DefaultK is used when a query doesn't say how many results it wants.
const DefaultK = 10

type server struct {
	db      *store.DB
	start   time.Time
	mux     *http.ServeMux
	maxBody int64
}

// New returns an http.Handler serving db.
func New(db *store.DB) http.Handler {
	mux := http.NewServeMux()
	s := &server{db: db, start: time.Now(), mux: mux, maxBody: MaxBodyBytes}
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /stats", s.stats)
	mux.HandleFunc("POST /collections", s.createCollection)
	mux.HandleFunc("GET /collections", s.listCollections)
	mux.HandleFunc("GET /collections/{name}", s.getCollection)
	mux.HandleFunc("DELETE /collections/{name}", s.dropCollection)
	mux.HandleFunc("POST /collections/{name}/upsert", s.upsert)
	mux.HandleFunc("GET /collections/{name}/items/{id...}", s.getItem)
	mux.HandleFunc("DELETE /collections/{name}/items/{id...}", s.deleteItem)
	mux.HandleFunc("POST /collections/{name}/query", s.query)
	mux.HandleFunc("POST /collections/{name}/snapshot", s.snapshot)
	return s
}

// ServeHTTP routes through the mux. Requests no route matches still get
// the mux's status (404, or 405 with an Allow header when the path exists
// under another method), but with a JSON body like every other error.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if _, pattern := s.mux.Handler(r); pattern != "" {
		s.mux.ServeHTTP(w, r)
		return
	}
	rec := &discardWriter{header: http.Header{}, status: http.StatusNotFound}
	s.mux.ServeHTTP(rec, r)
	if allow := rec.header.Get("Allow"); allow != "" {
		w.Header().Set("Allow", allow)
	}
	if loc := rec.header.Get("Location"); loc != "" {
		w.Header().Set("Location", loc)
	}
	writeError(w, rec.status, fmt.Errorf("%s %s: %s", r.Method, r.URL.Path, strings.ToLower(http.StatusText(rec.status))))
}

// discardWriter captures the status and headers the mux would send.
type discardWriter struct {
	header http.Header
	status int
}

func (d *discardWriter) Header() http.Header         { return d.header }
func (d *discardWriter) Write(b []byte) (int, error) { return len(b), nil }
func (d *discardWriter) WriteHeader(code int)        { d.status = code }

// errorBody is the shape of every error response.
type errorBody struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, errorBody{Error: err.Error()})
}

// writeStoreError maps store errors to status codes.
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrInvalid):
		writeError(w, http.StatusBadRequest, err)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

// decode reads exactly one JSON object into v, rejecting unknown fields,
// trailing data and oversized bodies. On failure it writes the response
// and returns false.
func (s *server) decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBody))
	dec.DisallowUnknownFields()
	err := dec.Decode(v)
	if err == nil && dec.Decode(&struct{}{}) != io.EOF {
		err = errors.New("unexpected data after the JSON body")
	}
	if err == nil {
		return true
	}
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Errorf("request body is larger than %d bytes", tooBig.Limit))
	case errors.Is(err, io.EOF):
		writeError(w, http.StatusBadRequest, errors.New("request body is empty; expected a JSON object"))
	default:
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid JSON body: %v", err))
	}
	return false
}

func (s *server) collection(w http.ResponseWriter, r *http.Request) (*store.Collection, bool) {
	c, err := s.db.Get(r.PathValue("name"))
	if err != nil {
		writeStoreError(w, err)
		return nil, false
	}
	return c, true
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// StatsResponse is the body of GET /stats.
type StatsResponse struct {
	UptimeSeconds  float64      `json:"uptime_seconds"`
	Collections    []store.Info `json:"collections"`
	TotalDocuments int          `json:"total_documents"`
	HeapAllocBytes uint64       `json:"heap_alloc_bytes"`
	Goroutines     int          `json:"goroutines"`
	DataDir        string       `json:"data_dir,omitempty"`
}

func (s *server) stats(w http.ResponseWriter, _ *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	resp := StatsResponse{
		UptimeSeconds:  time.Since(s.start).Seconds(),
		Collections:    []store.Info{},
		HeapAllocBytes: ms.HeapAlloc,
		Goroutines:     runtime.NumGoroutine(),
		DataDir:        s.db.Dir(),
	}
	for _, c := range s.db.List() {
		info := c.Info()
		resp.Collections = append(resp.Collections, info)
		resp.TotalDocuments += info.Count
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) createCollection(w http.ResponseWriter, r *http.Request) {
	var cfg store.Config
	if !s.decode(w, r, &cfg) {
		return
	}
	c, err := s.db.Create(cfg)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c.Info())
}

// ListResponse is the body of GET /collections.
type ListResponse struct {
	Collections []store.Info `json:"collections"`
}

func (s *server) listCollections(w http.ResponseWriter, _ *http.Request) {
	resp := ListResponse{Collections: []store.Info{}}
	for _, c := range s.db.List() {
		resp.Collections = append(resp.Collections, c.Info())
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) getCollection(w http.ResponseWriter, r *http.Request) {
	if c, ok := s.collection(w, r); ok {
		writeJSON(w, http.StatusOK, c.Info())
	}
}

func (s *server) dropCollection(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.db.Drop(name); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": name})
}

// UpsertRequest is the body of POST /collections/{name}/upsert.
type UpsertRequest struct {
	Items []store.Item `json:"items"`
}

// UpsertResponse reports how many items were written and the new size.
type UpsertResponse struct {
	Upserted int `json:"upserted"`
	Count    int `json:"count"`
}

func (s *server) upsert(w http.ResponseWriter, r *http.Request) {
	c, ok := s.collection(w, r)
	if !ok {
		return
	}
	var req UpsertRequest
	if !s.decode(w, r, &req) {
		return
	}
	if len(req.Items) == 0 {
		writeError(w, http.StatusBadRequest, errors.New(`"items" must be a non-empty array`))
		return
	}
	n, err := c.Upsert(req.Items)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, UpsertResponse{Upserted: n, Count: c.Len()})
}

func (s *server) getItem(w http.ResponseWriter, r *http.Request) {
	c, ok := s.collection(w, r)
	if !ok {
		return
	}
	it, err := c.Get(r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, it)
}

func (s *server) deleteItem(w http.ResponseWriter, r *http.Request) {
	c, ok := s.collection(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !c.Delete(id) {
		writeError(w, http.StatusNotFound, fmt.Errorf("id %q: %w", id, store.ErrNotFound))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// QueryRequest is the body of POST /collections/{name}/query.
type QueryRequest struct {
	Vector []float32      `json:"vector"`
	K      int            `json:"k"`
	Ef     int            `json:"ef"`
	Filter map[string]any `json:"filter"`
	// IncludeVectors adds each hit's stored vector to the response.
	IncludeVectors bool `json:"include_vectors"`
}

// QueryHit is one result. Distance is "smaller is closer": 1 - cos for
// cosine, -dot for dot, Euclidean for l2.
type QueryHit struct {
	ID       string         `json:"id"`
	Distance float32        `json:"distance"`
	Metadata map[string]any `json:"metadata,omitempty"`
	Vector   []float32      `json:"vector,omitempty"`
}

// QueryResponse is the body returned by a query.
type QueryResponse struct {
	Results []QueryHit `json:"results"`
	TookMs  float64    `json:"took_ms"`
}

func (s *server) query(w http.ResponseWriter, r *http.Request) {
	c, ok := s.collection(w, r)
	if !ok {
		return
	}
	var req QueryRequest
	if !s.decode(w, r, &req) {
		return
	}
	if req.K == 0 {
		req.K = DefaultK
	}
	start := time.Now()
	hits, err := c.Query(store.Query{Vector: req.Vector, K: req.K, Ef: req.Ef, Filter: req.Filter})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	took := time.Since(start)
	resp := QueryResponse{Results: make([]QueryHit, len(hits)), TookMs: float64(took.Microseconds()) / 1000}
	for i, h := range hits {
		resp.Results[i] = QueryHit{ID: h.ID, Distance: h.Distance, Metadata: h.Metadata}
		if req.IncludeVectors {
			if it, err := c.Get(h.ID); err == nil {
				resp.Results[i].Vector = it.Vector
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) snapshot(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.db.Save(name); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": name, "persistent": s.db.Dir() != ""})
}

// WithLogging logs one line per request: method, path, status, duration.
func WithLogging(next http.Handler, logf func(format string, args ...any)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		logf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Microsecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
