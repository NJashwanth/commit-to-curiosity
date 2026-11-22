package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

func TestGenerateIsDeterministicAndParses(t *testing.T) {
	var a, b, c bytes.Buffer
	generate(&a, 1200, 7, 500)
	generate(&b, 1200, 7, 500)
	generate(&c, 1200, 8, 500)
	if a.String() != b.String() {
		t.Error("same seed must give identical SQL")
	}
	if a.String() == c.String() {
		t.Error("different seeds must differ")
	}
	stmts, err := sql.Parse(a.String())
	if err != nil {
		t.Fatal(err)
	}
	// CREATE, BEGIN, 3 INSERT batches (500+500+200), COMMIT
	if len(stmts) != 6 {
		t.Errorf("got %d statements", len(stmts))
	}
	if n := strings.Count(a.String(), "'user"); n != 1200 {
		t.Errorf("%d rows", n)
	}
}
