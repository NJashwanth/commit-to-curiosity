package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBenchSmallRun(t *testing.T) {
	out := filepath.Join(t.TempDir(), "results", "bench.md")
	var stdout bytes.Buffer
	args := []string{"--n", "1500", "--dim", "16", "--k", "5", "--queries", "60", "--clusters", "10",
		"--m", "8", "--ef-construction", "40", "--ef", "8,64", "--threads", "2", "--out", out}
	if err := run(args, &stdout); err != nil {
		t.Fatal(err)
	}
	md, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	report := string(md)
	for _, want := range []string{
		"# tiny-vectordb benchmark",
		"--n 1500 --dim 16 --k 5",
		"| vectors | 1500 × 16-d, cosine |",
		"| flat | - | 1.0000 |",
		"| hnsw | 8 |",
		"| hnsw | 64 |",
		"recall@5",
		"QPS (2 threads)",
		"HNSW build:",
	} {
		if !strings.Contains(report, want) {
			t.Errorf("report missing %q:\n%s", want, report)
		}
	}
	if !strings.Contains(stdout.String(), "wrote "+out) || !strings.Contains(stdout.String(), "| hnsw | 64 |") {
		t.Errorf("stdout:\n%s", stdout.String())
	}
}

func TestBenchRecallAndOrdering(t *testing.T) {
	cfg, err := parseFlags([]string{"--n", "2000", "--dim", "16", "--queries", "80", "--clusters", "8",
		"--m", "8", "--ef-construction", "64", "--ef", "10,200", "--threads", "3", "--out", ""}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	rep, err := bench(cfg, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Rows) != 2 {
		t.Fatalf("%d rows", len(rep.Rows))
	}
	lo, hi := rep.Rows[0], rep.Rows[1]
	if hi.Recall < 0.95 || hi.Recall < lo.Recall {
		t.Errorf("recall ef=10 %.3f, ef=200 %.3f", lo.Recall, hi.Recall)
	}
	for _, row := range append(rep.Rows, efRow{timing: rep.Flat}) {
		if row.QPS <= 0 || row.ParallelQPS <= 0 || row.P50 <= 0 || row.P99 < row.P50 {
			t.Errorf("bad timing %+v", row.timing)
		}
	}
	if rep.Graph.Live != 2000 || rep.SnapshotSize <= 2000*16*4 || rep.BuildTime <= 0 {
		t.Errorf("graph %+v snapshot %d build %v", rep.Graph, rep.SnapshotSize, rep.BuildTime)
	}
}

func TestFlagErrors(t *testing.T) {
	bad := [][]string{
		{"--nope"},
		{"--metric", "manhattan"},
		{"--ef", "16,abc"},
		{"--ef", "0"},
		{"--n", "0"},
		{"--k", "20", "--n", "10"},
		{"--threads", "0"},
	}
	for _, args := range bad {
		if err := run(args, &bytes.Buffer{}); err == nil {
			t.Errorf("run(%v) should fail", args)
		}
	}
	// An unwritable output path fails after the benchmark runs.
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o644)
	err := run([]string{"--n", "50", "--dim", "4", "--queries", "5", "--ef", "8", "--out", filepath.Join(file, "x.md")}, &bytes.Buffer{})
	if err == nil {
		t.Error("writing under a regular file should fail")
	}
}

func TestMeasureHelpers(t *testing.T) {
	if got := overlap([]uint32{1, 2, 3}, []uint32{3, 4, 1}); got != 2 {
		t.Errorf("overlap = %d", got)
	}
	boom := errors.New("boom")
	if cmp(nil, boom) != boom || cmp(boom, errors.New("x")) != boom {
		t.Error("cmp should keep the first error")
	}
	fail := func(int) ([]uint32, error) { return nil, boom }
	if _, err := measure(3, 2, fail, nil, nil); !errors.Is(err, boom) {
		t.Errorf("measure error = %v", err)
	}
	if ms(1500*time.Microsecond) != "1.500" {
		t.Errorf("ms = %s", ms(1500*time.Microsecond))
	}
}
