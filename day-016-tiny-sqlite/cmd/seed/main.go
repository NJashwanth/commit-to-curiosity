// Command seed prints SQL that creates and fills a demo "events" table with
// seeded pseudo-random rows, for example:
//
//	go run ./cmd/seed -rows 10000 | go run ./cmd/tinysql demo.db
package main

import (
	"flag"
	"fmt"
	"io"
	"math/rand"
	"os"
)

func main() {
	rows := flag.Int("rows", 10000, "number of rows")
	seed := flag.Int64("seed", 20260116, "random seed")
	batch := flag.Int("batch", 500, "rows per INSERT statement")
	flag.Parse()
	generate(os.Stdout, *rows, *seed, *batch)
}

var kinds = []string{"view", "click", "purchase", "refund"}

// generate writes the whole load inside one transaction.
func generate(w io.Writer, rows int, seed int64, batch int) {
	rng := rand.New(rand.NewSource(seed))
	fmt.Fprintln(w, "CREATE TABLE events (id INTEGER PRIMARY KEY, user TEXT, kind TEXT, amount REAL, ts INTEGER);")
	fmt.Fprintln(w, "BEGIN;")
	for start := 1; start <= rows; start += batch {
		end := min(start+batch-1, rows)
		fmt.Fprint(w, "INSERT INTO events VALUES ")
		for id := start; id <= end; id++ {
			if id > start {
				fmt.Fprint(w, ", ")
			}
			amount := "NULL"
			if rng.Intn(20) != 0 {
				amount = fmt.Sprintf("%.2f", rng.Float64()*500)
			}
			fmt.Fprintf(w, "(%d, 'user%03d', '%s', %s, %d)",
				id, rng.Intn(200), kinds[rng.Intn(len(kinds))], amount, 1700000000+rng.Intn(31536000))
		}
		fmt.Fprintln(w, ";")
	}
	fmt.Fprintln(w, "COMMIT;")
}
