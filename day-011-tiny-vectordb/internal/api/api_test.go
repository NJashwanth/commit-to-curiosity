package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/store"
)

type client struct {
	t   *testing.T
	srv *httptest.Server
}

func newClient(t *testing.T) *client {
	t.Helper()
	srv := httptest.NewServer(New(store.NewDB()))
	t.Cleanup(srv.Close)
	return &client{t: t, srv: srv}
}

// do sends a request (body may be a string of raw JSON or a value to
// encode) and returns the status and decoded JSON object.
func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		buf, _ := json.Marshal(b)
		r = bytes.NewReader(buf)
	}
	req, _ := http.NewRequest(method, c.srv.URL+path, r)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		c.t.Errorf("%s %s: Content-Type %q", method, path, ct)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		c.t.Fatalf("%s %s: body is not a JSON object: %v", method, path, err)
	}
	return resp.StatusCode, out
}

func (c *client) expect(method, path string, body any, status int) map[string]any {
	c.t.Helper()
	got, out := c.do(method, path, body)
	if got != status {
		c.t.Fatalf("%s %s = %d, want %d (body %v)", method, path, got, status, out)
	}
	if status >= 400 {
		if msg, _ := out["error"].(string); msg == "" {
			c.t.Fatalf("%s %s: error response without an \"error\" string: %v", method, path, out)
		}
	}
	return out
}

func vec(xs ...float64) []float64 { return xs }

func TestCollectionLifecycle(t *testing.T) {
	c := newClient(t)
	c.expect("GET", "/health", nil, 200)

	info := c.expect("POST", "/collections", map[string]any{"name": "docs", "dim": 3, "metric": "cosine", "m": 8}, 201)
	if info["name"] != "docs" || info["dim"] != 3.0 || info["m"] != 8.0 || info["ef_search"] != 64.0 || info["count"] != 0.0 {
		t.Errorf("create response = %v", info)
	}
	if _, ok := info["graph"].(map[string]any); !ok {
		t.Errorf("create response has no graph stats: %v", info)
	}
	c.expect("POST", "/collections", map[string]any{"name": "docs", "dim": 3}, 409)
	c.expect("POST", "/collections", map[string]any{"name": "other", "dim": 2, "metric": "l2"}, 201)

	list := c.expect("GET", "/collections", nil, 200)
	cols, _ := list["collections"].([]any)
	if len(cols) != 2 || cols[0].(map[string]any)["name"] != "docs" {
		t.Errorf("list = %v", list)
	}
	c.expect("GET", "/collections/docs", nil, 200)
	c.expect("GET", "/collections/nope", nil, 404)

	if out := c.expect("DELETE", "/collections/other", nil, 200); out["deleted"] != "other" {
		t.Errorf("drop response = %v", out)
	}
	c.expect("DELETE", "/collections/other", nil, 404)
}

func TestUpsertGetDeleteQuery(t *testing.T) {
	c := newClient(t)
	c.expect("POST", "/collections", map[string]any{"name": "docs", "dim": 3}, 201)
	items := []map[string]any{
		{"id": "go-1", "vector": vec(1, 0, 0), "metadata": map[string]any{"lang": "go", "stars": 5}},
		{"id": "go-2", "vector": vec(0.9, 0.1, 0), "metadata": map[string]any{"lang": "go", "stars": 3}},
		{"id": "rs-1", "vector": vec(1, 0.05, 0), "metadata": map[string]any{"lang": "rust"}},
		{"id": "py-1", "vector": vec(0, 1, 0), "metadata": map[string]any{"lang": "python"}},
		{"id": "path/with/slashes", "vector": vec(0, 0, 1)},
	}
	out := c.expect("POST", "/collections/docs/upsert", map[string]any{"items": items}, 200)
	if out["upserted"] != 5.0 || out["count"] != 5.0 {
		t.Errorf("upsert response = %v", out)
	}

	it := c.expect("GET", "/collections/docs/items/go-1", nil, 200)
	if it["id"] != "go-1" || it["metadata"].(map[string]any)["stars"] != 5.0 || len(it["vector"].([]any)) != 3 {
		t.Errorf("get = %v", it)
	}
	c.expect("GET", "/collections/docs/items/path/with/slashes", nil, 200)
	c.expect("GET", "/collections/docs/items/missing", nil, 404)
	c.expect("GET", "/collections/nope/items/go-1", nil, 404)

	// Unfiltered: the closest is go-1 (identical direction).
	res := c.expect("POST", "/collections/docs/query", map[string]any{"vector": vec(1, 0, 0), "k": 3}, 200)
	hits := res["results"].([]any)
	if len(hits) != 3 || hits[0].(map[string]any)["id"] != "go-1" {
		t.Fatalf("query = %v", res)
	}
	first := hits[0].(map[string]any)
	if _, ok := first["distance"].(float64); !ok || first["vector"] != nil {
		t.Errorf("hit shape = %v (want distance, no vector by default)", first)
	}
	if _, ok := res["took_ms"].(float64); !ok {
		t.Errorf("no took_ms in %v", res)
	}

	// Filtered: only go docs, and still k of them when enough match.
	res = c.expect("POST", "/collections/docs/query",
		map[string]any{"vector": vec(1, 0, 0), "k": 2, "ef": 32, "filter": map[string]any{"lang": "go"}, "include_vectors": true}, 200)
	hits = res["results"].([]any)
	if len(hits) != 2 {
		t.Fatalf("filtered query = %v", res)
	}
	for _, h := range hits {
		m := h.(map[string]any)
		if m["metadata"].(map[string]any)["lang"] != "go" || len(m["vector"].([]any)) != 3 {
			t.Errorf("filtered hit = %v", m)
		}
	}
	// k defaults to 10 (capped by the collection size).
	res = c.expect("POST", "/collections/docs/query", map[string]any{"vector": vec(0, 1, 0)}, 200)
	if len(res["results"].([]any)) != 5 {
		t.Errorf("default-k query returned %d", len(res["results"].([]any)))
	}

	if out := c.expect("DELETE", "/collections/docs/items/go-1", nil, 200); out["deleted"] != "go-1" {
		t.Errorf("delete = %v", out)
	}
	c.expect("DELETE", "/collections/docs/items/go-1", nil, 404)
	c.expect("DELETE", "/collections/nope/items/go-1", nil, 404)
	res = c.expect("POST", "/collections/docs/query", map[string]any{"vector": vec(1, 0, 0), "k": 1}, 200)
	if res["results"].([]any)[0].(map[string]any)["id"] == "go-1" {
		t.Error("deleted id returned by query")
	}
	res = c.expect("POST", "/collections/docs/query", map[string]any{"vector": vec(1, 0, 0), "filter": map[string]any{"lang": "cobol"}}, 200)
	if hits, ok := res["results"].([]any); !ok || len(hits) != 0 {
		t.Errorf("no-match query should return an empty array, got %v", res["results"])
	}
}

func TestValidationErrors(t *testing.T) {
	c := newClient(t)
	c.expect("POST", "/collections", map[string]any{"name": "docs", "dim": 3}, 201)
	cases := []struct {
		method, path string
		body         any
		status       int
		msg          string
	}{
		{"POST", "/collections", `{"name": "x", "dim": 3`, 400, "invalid JSON"},
		{"POST", "/collections", ``, 400, "empty"},
		{"POST", "/collections", `{"name": "x", "dim": 3} {"again": 1}`, 400, "after the JSON body"},
		{"POST", "/collections", `{"name": "x", "dim": 3, "colour": "red"}`, 400, "unknown field"},
		{"POST", "/collections", `{"name": "x", "dim": "three"}`, 400, "invalid JSON"},
		{"POST", "/collections", map[string]any{"name": "bad name!", "dim": 3}, 400, "collection name"},
		{"POST", "/collections", map[string]any{"name": "x", "dim": 0}, 400, "dim"},
		{"POST", "/collections", map[string]any{"name": "x", "dim": 3, "metric": "jaccard"}, 400, "unknown metric"},
		{"POST", "/collections/docs/upsert", map[string]any{"items": []any{}}, 400, "non-empty"},
		{"POST", "/collections/docs/upsert", map[string]any{"items": []any{map[string]any{"id": "a", "vector": vec(1, 2)}}}, 400, "dimension mismatch"},
		{"POST", "/collections/docs/upsert", map[string]any{"items": []any{map[string]any{"id": "", "vector": vec(1, 2, 3)}}}, 400, "id must be"},
		{"POST", "/collections/docs/upsert", map[string]any{"items": []any{map[string]any{"id": "z", "vector": vec(0, 0, 0)}}}, 400, "zero vector"},
		{"POST", "/collections/nope/upsert", map[string]any{"items": []any{}}, 404, "not found"},
		{"POST", "/collections/docs/query", map[string]any{"vector": vec(1, 2)}, 400, "dimension mismatch"},
		{"POST", "/collections/docs/query", map[string]any{"vector": vec(1, 2, 3), "k": -1}, 400, "k must be"},
		{"POST", "/collections/docs/query", map[string]any{"vector": vec(1, 2, 3), "k": 5000}, 400, "k must be"},
		{"POST", "/collections/docs/query", map[string]any{"vector": vec(1, 2, 3), "ef": 99999}, 400, "ef must be"},
		{"POST", "/collections/docs/query", map[string]any{"vector": vec(1, 2, 3), "filter": map[string]any{"a": map[string]any{"$near": 1}}}, 400, "unknown operator"},
		{"POST", "/collections/nope/query", map[string]any{"vector": vec(1, 2, 3)}, 404, "not found"},
		{"GET", "/no/such/route", nil, 404, "not found"},
		{"PUT", "/collections", nil, 405, "method not allowed"},
		{"PATCH", "/collections/docs", nil, 405, "method not allowed"},
	}
	for _, tc := range cases {
		status, out := c.do(tc.method, tc.path, tc.body)
		msg, _ := out["error"].(string)
		if status != tc.status || !strings.Contains(msg, tc.msg) {
			t.Errorf("%s %s %v: got %d %q, want %d containing %q", tc.method, tc.path, tc.body, status, msg, tc.status, tc.msg)
		}
	}
	// A failed batch writes nothing.
	if info := c.expect("GET", "/collections/docs", nil, 200); info["count"] != 0.0 {
		t.Errorf("count after rejected upserts = %v", info["count"])
	}
}

func TestMethodNotAllowedSetsAllow(t *testing.T) {
	c := newClient(t)
	req, _ := http.NewRequest("PUT", c.srv.URL+"/collections", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if allow := resp.Header.Get("Allow"); !strings.Contains(allow, "GET") || !strings.Contains(allow, "POST") {
		t.Errorf("Allow = %q", allow)
	}
}

func TestBodyTooLarge(t *testing.T) {
	h := New(store.NewDB()).(*server)
	h.maxBody = 4 << 10
	srv := httptest.NewServer(h)
	defer srv.Close()
	c := &client{t: t, srv: srv}
	c.expect("POST", "/collections", map[string]any{"name": "docs", "dim": 3}, 201)
	big := `{"items": [` + strings.Repeat(`{"id":"x","vector":[1,2,3]},`, 200) + `]}`
	status, out := c.do("POST", "/collections/docs/upsert", big)
	if status != http.StatusRequestEntityTooLarge || !strings.Contains(out["error"].(string), "larger than") {
		t.Errorf("oversized body: %d %v", status, out["error"])
	}
}

func TestStatsAndSnapshot(t *testing.T) {
	c := newClient(t)
	c.expect("POST", "/collections", map[string]any{"name": "a", "dim": 2}, 201)
	c.expect("POST", "/collections", map[string]any{"name": "b", "dim": 2}, 201)
	items := []map[string]any{}
	for i := range 7 {
		items = append(items, map[string]any{"id": fmt.Sprint(i), "vector": vec(1, float64(i))})
	}
	c.expect("POST", "/collections/a/upsert", map[string]any{"items": items}, 200)
	c.expect("DELETE", "/collections/a/items/3", nil, 200)

	st := c.expect("GET", "/stats", nil, 200)
	if st["total_documents"] != 6.0 || len(st["collections"].([]any)) != 2 {
		t.Errorf("stats = %v", st)
	}
	a := st["collections"].([]any)[0].(map[string]any)
	if a["name"] != "a" || a["count"] != 6.0 || a["tombstones"] != 1.0 {
		t.Errorf("stats for a = %v", a)
	}
	for _, key := range []string{"uptime_seconds", "heap_alloc_bytes", "goroutines"} {
		if _, ok := st[key].(float64); !ok {
			t.Errorf("stats missing %s: %v", key, st)
		}
	}
	// Memory-only DB: snapshot is accepted but not persistent.
	if out := c.expect("POST", "/collections/a/snapshot", nil, 200); out["persistent"] != false {
		t.Errorf("snapshot = %v", out)
	}
	c.expect("POST", "/collections/zzz/snapshot", nil, 404)
}

func TestSnapshotErrorIs500(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(db))
	defer srv.Close()
	c := &client{t: t, srv: srv}
	c.expect("POST", "/collections", map[string]any{"name": "a", "dim": 2}, 201)
	if out := c.expect("POST", "/collections/a/snapshot", nil, 200); out["persistent"] != true {
		t.Errorf("snapshot = %v", out)
	}
	// Make the data dir unwritable for the temp file: replace it with a file.
	_ = os.RemoveAll(dir)
	_ = os.WriteFile(dir, []byte("not a dir"), 0o644)
	c.expect("POST", "/collections/a/snapshot", nil, 500)
}

func TestWithLogging(t *testing.T) {
	var lines []string
	h := WithLogging(New(store.NewDB()), func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/collections/missing", nil))
	if rec.Code != 404 || len(lines) != 1 || !strings.HasPrefix(lines[0], "GET /collections/missing 404") {
		t.Errorf("code %d, log %v", rec.Code, lines)
	}
}
