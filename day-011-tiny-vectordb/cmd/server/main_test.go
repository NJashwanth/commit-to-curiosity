package main

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/store"
)

// syncBuffer is a log sink that's safe to read while the server writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// Start on a free port, create and fill a collection over HTTP, shut down,
// and check the shutdown snapshot reloads.
func TestRunServesAndSnapshotsOnShutdown(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	logs := &syncBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"--data", dir, "--port", "0", "--snapshot-interval", "1h"}, logs, ready)
	}()

	var addr string
	select {
	case addr = <-ready:
	case err := <-done:
		t.Fatalf("server exited early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start")
	}
	base := "http://" + addr
	post := func(path, body string, want int) {
		t.Helper()
		resp, err := http.Post(base+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("POST %s = %d, want %d", path, resp.StatusCode, want)
		}
	}
	post("/collections", `{"name":"docs","dim":2}`, 201)
	post("/collections/docs/upsert", `{"items":[{"id":"a","vector":[1,0],"metadata":{"lang":"go"}},{"id":"b","vector":[0,1]}]}`, 200)

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run returned %v", err)
	}
	out := logs.String()
	for _, want := range []string{"loaded 0 collections", "listening on", "POST /collections 201", "saved 1 dirty collections"} {
		if !strings.Contains(out, want) {
			t.Errorf("log missing %q:\n%s", want, out)
		}
	}

	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := db.Get("docs")
	if err != nil || c.Len() != 2 {
		t.Fatalf("after restart: %v, %v", c, err)
	}
	it, _ := c.Get("a")
	if it.Metadata["lang"] != "go" {
		t.Errorf("metadata after restart = %v", it.Metadata)
	}
}

func TestRunErrors(t *testing.T) {
	ctx := context.Background()
	var logs bytes.Buffer
	if err := run(ctx, []string{"--bogus"}, &logs, nil); err == nil {
		t.Error("unknown flag should fail")
	}
	if err := run(ctx, []string{"--snapshot-interval", "0s"}, &logs, nil); err == nil {
		t.Error("zero interval should fail")
	}
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o644)
	if err := run(ctx, []string{"--data", file}, &logs, nil); err == nil {
		t.Error("data path that is a file should fail")
	}
	if err := run(ctx, []string{"--data", t.TempDir(), "--port", "-1"}, &logs, nil); err == nil {
		t.Error("invalid port should fail")
	}
}
