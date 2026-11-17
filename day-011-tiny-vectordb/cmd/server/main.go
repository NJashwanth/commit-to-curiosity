// Command server runs tiny-vectordb's HTTP API.
//
//	go run ./cmd/server --data ./data --port 8080
//
// Collections are loaded from --data on startup. Dirty collections are
// snapshotted every --snapshot-interval (which also cleans up tombstones)
// and once more on shutdown (Ctrl-C or SIGTERM).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/api"
	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stderr, nil); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// run starts the server and blocks until ctx is cancelled or the listener
// fails. If ready is non-nil it receives the listening address.
func run(ctx context.Context, args []string, logOut io.Writer, ready chan<- string) error {
	fs := flag.NewFlagSet("server", flag.ContinueOnError)
	fs.SetOutput(logOut)
	dataDir := fs.String("data", "./data", "directory for collection snapshots")
	host := fs.String("host", "127.0.0.1", "address to bind")
	port := fs.Int("port", 8080, "port to listen on (0 picks a free one)")
	interval := fs.Duration("snapshot-interval", 30*time.Second, "how often to clean up tombstones and snapshot dirty collections")
	quiet := fs.Bool("quiet", false, "don't log each request")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *interval <= 0 {
		return errors.New("--snapshot-interval must be positive")
	}
	logger := log.New(logOut, "", log.LstdFlags)

	db, err := store.Open(*dataDir)
	if err != nil {
		return err
	}
	docs := 0
	for _, c := range db.List() {
		docs += c.Len()
	}
	logger.Printf("loaded %d collections (%d documents) from %s", len(db.List()), docs, *dataDir)

	ln, err := net.Listen("tcp", net.JoinHostPort(*host, strconv.Itoa(*port)))
	if err != nil {
		return err
	}
	handler := api.New(db)
	if !*quiet {
		handler = api.WithLogging(handler, logger.Printf)
	}
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute, // big upsert batches
		IdleTimeout:       2 * time.Minute,
	}

	maintCtx, stopMaint := context.WithCancel(ctx)
	defer stopMaint()
	go db.Maintain(maintCtx, *interval, logger.Printf)

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	logger.Printf("listening on http://%s", ln.Addr())
	if ready != nil {
		ready <- ln.Addr().String()
	}

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}
	logger.Printf("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		logger.Printf("shutdown: %v", err)
	}
	stopMaint()
	n, err := db.SaveDirty()
	logger.Printf("saved %d dirty collections", n)
	return err
}
