// Command bench measures HNSW build time, query latency, throughput and
// recall against the exact flat index on seeded synthetic clustered data.
//
//	go run ./cmd/bench --n 50000 --dim 128 --k 10
//
// It writes a markdown report to --out (results/bench.md by default).
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/flat"
	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/hnsw"
	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/vecmath"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

type config struct {
	N, Dim, K, Queries, Clusters int
	Spread                       float64
	Metric                       vecmath.Metric
	M, EfConstruction            int
	Efs                          []int
	Seed                         uint64
	Threads                      int
	Out                          string
}

func parseFlags(args []string, stderr io.Writer) (config, error) {
	fs := flag.NewFlagSet("bench", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var c config
	fs.IntVar(&c.N, "n", 50000, "number of vectors to index")
	fs.IntVar(&c.Dim, "dim", 128, "vector dimension")
	fs.IntVar(&c.K, "k", 10, "neighbors per query (recall@k)")
	fs.IntVar(&c.Queries, "queries", 1000, "number of queries")
	fs.IntVar(&c.Clusters, "clusters", 100, "number of Gaussian clusters in the synthetic data")
	fs.Float64Var(&c.Spread, "spread", 0.5, "per-dimension standard deviation around each cluster center")
	metric := fs.String("metric", "cosine", "cosine, dot or l2")
	fs.IntVar(&c.M, "m", hnsw.DefaultM, "HNSW M")
	fs.IntVar(&c.EfConstruction, "ef-construction", hnsw.DefaultEfConstruction, "HNSW efConstruction")
	efs := fs.String("ef", "16,32,64,128,256", "comma-separated efSearch values to sweep")
	seed := fs.Uint64("seed", 42, "seed for data generation and level assignment")
	fs.IntVar(&c.Threads, "threads", runtime.GOMAXPROCS(0), "goroutines for the parallel QPS column")
	fs.StringVar(&c.Out, "out", "results/bench.md", "markdown report path ('' to skip)")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	c.Seed = *seed
	m, err := vecmath.ParseMetric(*metric)
	if err != nil {
		return c, err
	}
	c.Metric = m
	if c.Efs, err = parseInts(*efs); err != nil {
		return c, fmt.Errorf("--ef: %w", err)
	}
	switch {
	case c.N < 1, c.Dim < 1, c.K < 1, c.Queries < 1, c.Clusters < 1, c.Threads < 1:
		return c, errors.New("--n, --dim, --k, --queries, --clusters and --threads must all be positive")
	case c.K > c.N:
		return c, fmt.Errorf("--k (%d) can't exceed --n (%d)", c.K, c.N)
	}
	return c, nil
}

func parseInts(s string) ([]int, error) {
	var out []int
	for _, part := range strings.Split(s, ",") {
		v, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || v < 1 {
			return nil, fmt.Errorf("%q is not a positive integer", part)
		}
		out = append(out, v)
	}
	return out, nil
}

// timing summarizes one batch of queries.
type timing struct {
	Recall      float64
	QPS         float64 // single goroutine
	P50, P99    time.Duration
	ParallelQPS float64
}

type efRow struct {
	Ef int
	timing
}

type report struct {
	Cfg          config
	Date         string
	GoVersion    string
	Platform     string
	CPUs         int
	BuildTime    time.Duration
	Graph        hnsw.Stats
	SnapshotSize int
	Flat         timing
	Rows         []efRow
}

func run(args []string, stdout io.Writer) error {
	cfg, err := parseFlags(args, stdout)
	if err != nil {
		return err
	}
	rep, err := bench(cfg, stdout)
	if err != nil {
		return err
	}
	md := rep.markdown()
	fmt.Fprintln(stdout)
	fmt.Fprint(stdout, rep.table())
	if cfg.Out != "" {
		if err := os.MkdirAll(filepath.Dir(cfg.Out), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(cfg.Out, []byte(md), 0o644); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "\nwrote %s\n", cfg.Out)
	}
	return nil
}

func bench(cfg config, log io.Writer) (*report, error) {
	rep := &report{
		Cfg:       cfg,
		Date:      time.Now().Format("2006-01-02"),
		GoVersion: runtime.Version(),
		Platform:  runtime.GOOS + "/" + runtime.GOARCH,
		CPUs:      runtime.NumCPU(),
	}

	fmt.Fprintf(log, "generating %d + %d vectors (%d-d, %d clusters, seed %d)\n", cfg.N, cfg.Queries, cfg.Dim, cfg.Clusters, cfg.Seed)
	gen := vecmath.NewClusters(cfg.Seed, cfg.Dim, cfg.Clusters, cfg.Spread)
	data := gen.SampleN(cfg.N)
	queries := gen.SampleN(cfg.Queries)

	fmt.Fprintf(log, "building HNSW (M=%d, efConstruction=%d)\n", cfg.M, cfg.EfConstruction)
	idx, err := hnsw.New(hnsw.Config{Dim: cfg.Dim, Metric: cfg.Metric, M: cfg.M, EfConstruction: cfg.EfConstruction, Seed: cfg.Seed})
	if err != nil {
		return nil, err
	}
	start := time.Now()
	step := max(cfg.N/10, 1)
	for i, v := range data {
		if _, err := idx.Insert(v); err != nil {
			return nil, err
		}
		if (i+1)%step == 0 {
			fmt.Fprintf(log, "  %d/%d inserted (%.1fs)\n", i+1, cfg.N, time.Since(start).Seconds())
		}
	}
	rep.BuildTime = time.Since(start)
	rep.Graph = idx.Stats()
	snap, err := idx.MarshalBinary()
	if err != nil {
		return nil, err
	}
	rep.SnapshotSize = len(snap)

	fmt.Fprintln(log, "flat index: exact ground truth and baseline")
	fl, err := flat.New(cfg.Metric, cfg.Dim)
	if err != nil {
		return nil, err
	}
	for i, v := range data {
		if err := fl.Add(uint32(i), v); err != nil {
			return nil, err
		}
	}
	truth := make([][]uint32, len(queries))
	flatSearch := func(i int) ([]uint32, error) {
		res, err := fl.Search(queries[i], cfg.K)
		ids := make([]uint32, len(res))
		for j, r := range res {
			ids[j] = r.ID
		}
		return ids, err
	}
	rep.Flat, err = measure(len(queries), cfg.Threads, flatSearch, func(i int, ids []uint32) { truth[i] = ids }, nil)
	if err != nil {
		return nil, err
	}
	rep.Flat.Recall = 1

	// Warm up caches and the CPU before timing, so the first ef in the
	// sweep isn't penalized for going first.
	for i := range min(len(queries), 500) {
		if _, err := idx.Search(queries[i], cfg.K, cfg.Efs[len(cfg.Efs)-1]); err != nil {
			return nil, err
		}
	}

	for _, ef := range cfg.Efs {
		search := func(i int) ([]uint32, error) {
			res, err := idx.Search(queries[i], cfg.K, ef)
			ids := make([]uint32, len(res))
			for j, r := range res {
				ids[j] = r.ID
			}
			return ids, err
		}
		t, err := measure(len(queries), cfg.Threads, search, nil, truth)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(log, "  ef=%-4d recall@%d=%.4f  qps=%.0f\n", ef, cfg.K, t.Recall, t.QPS)
		rep.Rows = append(rep.Rows, efRow{Ef: ef, timing: t})
	}
	return rep, nil
}

// measure runs every query once on one goroutine, timing each, then again
// spread over `threads` goroutines for throughput. keep (optional) gets
// the single-thread results; truth (optional) is used to compute recall.
func measure(n, threads int, search func(int) ([]uint32, error), keep func(int, []uint32), truth [][]uint32) (timing, error) {
	var t timing
	lat := make([]time.Duration, n)
	hits, total := 0, 0
	start := time.Now()
	for i := range n {
		q := time.Now()
		ids, err := search(i)
		lat[i] = time.Since(q)
		if err != nil {
			return t, err
		}
		if keep != nil {
			keep(i, ids)
		}
		if truth != nil {
			total += len(truth[i])
			hits += overlap(ids, truth[i])
		}
	}
	t.QPS = float64(n) / time.Since(start).Seconds()
	if total > 0 {
		t.Recall = float64(hits) / float64(total)
	}
	slices.Sort(lat)
	t.P50 = lat[(n-1)*50/100]
	t.P99 = lat[(n-1)*99/100]

	var wg sync.WaitGroup
	var firstErr error
	var mu sync.Mutex
	start = time.Now()
	for w := range threads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := w; i < n; i += threads {
				if _, err := search(i); err != nil {
					mu.Lock()
					firstErr = cmp(firstErr, err)
					mu.Unlock()
					return
				}
			}
		}()
	}
	wg.Wait()
	t.ParallelQPS = float64(n) / time.Since(start).Seconds()
	return t, firstErr
}

func cmp(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

func overlap(got, want []uint32) int {
	set := make(map[uint32]bool, len(want))
	for _, id := range want {
		set[id] = true
	}
	n := 0
	for _, id := range got {
		if set[id] {
			n++
		}
	}
	return n
}

func ms(d time.Duration) string { return fmt.Sprintf("%.3f", float64(d.Microseconds())/1000) }

// table renders the results table on its own.
func (r *report) table() string {
	var b strings.Builder
	fmt.Fprintf(&b, "| index | ef | recall@%d | QPS (1 thread) | p50 ms | p99 ms | QPS (%d threads) | speedup vs flat |\n", r.Cfg.K, r.Cfg.Threads)
	b.WriteString("|-------|---:|----------:|---------------:|-------:|-------:|-----------------:|----------------:|\n")
	fmt.Fprintf(&b, "| flat | - | %.4f | %.0f | %s | %s | %.0f | 1.0x |\n",
		r.Flat.Recall, r.Flat.QPS, ms(r.Flat.P50), ms(r.Flat.P99), r.Flat.ParallelQPS)
	for _, row := range r.Rows {
		fmt.Fprintf(&b, "| hnsw | %d | %.4f | %.0f | %s | %s | %.0f | %.1fx |\n",
			row.Ef, row.Recall, row.QPS, ms(row.P50), ms(row.P99), row.ParallelQPS, row.QPS/r.Flat.QPS)
	}
	return b.String()
}

func (r *report) markdown() string {
	c := r.Cfg
	var b strings.Builder
	b.WriteString("# tiny-vectordb benchmark\n\n")
	efs := make([]string, len(c.Efs))
	for i, e := range c.Efs {
		efs[i] = strconv.Itoa(e)
	}
	fmt.Fprintf(&b, "Generated %s by:\n\n```\ngo run ./cmd/bench --n %d --dim %d --k %d --queries %d --clusters %d --spread %g --metric %s --m %d --ef-construction %d --ef %s --seed %d --threads %d\n```\n\n",
		r.Date, c.N, c.Dim, c.K, c.Queries, c.Clusters, c.Spread, c.Metric, c.M, c.EfConstruction, strings.Join(efs, ","), c.Seed, c.Threads)

	b.WriteString("## Setup\n\n| | |\n|---|---|\n")
	fmt.Fprintf(&b, "| vectors | %d × %d-d, %s |\n", c.N, c.Dim, c.Metric)
	fmt.Fprintf(&b, "| data | %d Gaussian clusters, σ = %g per dimension, centers uniform in [-1, 1] |\n", c.Clusters, c.Spread)
	fmt.Fprintf(&b, "| queries | %d, drawn from the same distribution (not in the index) |\n", c.Queries)
	fmt.Fprintf(&b, "| HNSW | M = %d (layer 0: %d), efConstruction = %d, neighbor heuristic on |\n", c.M, 2*c.M, c.EfConstruction)
	fmt.Fprintf(&b, "| machine | %s, %d CPUs, %s |\n\n", r.Platform, r.CPUs, r.GoVersion)

	b.WriteString("## Build\n\n")
	fmt.Fprintf(&b, "- HNSW build: **%.2f s** (%.0f inserts/s, single writer)\n", r.BuildTime.Seconds(), float64(c.N)/r.BuildTime.Seconds())
	sizes := make([]string, len(r.Graph.LayerSizes))
	for i, s := range r.Graph.LayerSizes {
		sizes[i] = strconv.Itoa(s)
	}
	fmt.Fprintf(&b, "- Layers: %d (nodes per layer, bottom up: %s)\n", len(r.Graph.LayerSizes), strings.Join(sizes, ", "))
	fmt.Fprintf(&b, "- Mean layer-0 degree: %.1f of a possible %d\n", r.Graph.AvgDegree0, 2*c.M)
	raw := c.N * c.Dim * 4
	fmt.Fprintf(&b, "- Graph snapshot: %.1f MB (raw vectors alone are %.1f MB)\n\n", float64(r.SnapshotSize)/1e6, float64(raw)/1e6)

	b.WriteString("## Queries\n\n")
	b.WriteString("Recall@k is the fraction of the true k nearest neighbors (from the flat index) that HNSW returned. Latency and single-thread QPS come from one pass over the queries on one goroutine; the threaded column runs the same queries spread across goroutines. Speedup is single-thread HNSW QPS over single-thread flat QPS.\n\n")
	b.WriteString(r.table())
	return b.String()
}
