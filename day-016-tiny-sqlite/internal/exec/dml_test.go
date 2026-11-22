package exec

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/btree"
)

func checkTable(t *testing.T, db *DB, name string) btree.Stats {
	t.Helper()
	tbl, ok := db.cat.Get(name)
	if !ok {
		t.Fatalf("no table %s", name)
	}
	st, err := btree.Open(db.p, tbl.Root, db.treeCfg).Check()
	if err != nil {
		t.Fatalf("B+tree of %s is invalid: %v", name, err)
	}
	return st
}

// A random workload of inserts, updates and deletes is mirrored in a Go map;
// after every batch the tree must be valid and match the model exactly.
func TestRandomWorkloadKeepsTreeValid(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 4, MaxInternalKeys: 4}})
	mustRun(t, db, "CREATE TABLE kv (id INTEGER PRIMARY KEY, v TEXT, n INTEGER);")
	model := map[int]string{}
	nums := map[int]int{}
	rng := rand.New(rand.NewSource(8675309))

	for batch := 0; batch < 60; batch++ {
		for op := 0; op < 25; op++ {
			id := rng.Intn(400)
			switch rng.Intn(4) {
			case 0, 1: // insert (may collide)
				v := fmt.Sprintf("v%d", rng.Intn(1000))
				var out strings.Builder
				err := db.Run(fmt.Sprintf("INSERT INTO kv VALUES (%d, '%s', %d);", id, v, id), &out)
				if _, exists := model[id]; exists != (err != nil) {
					t.Fatalf("insert %d: exists=%v err=%v", id, exists, err)
				}
				if err == nil {
					model[id], nums[id] = v, id
				}
			case 2: // update (value grows or shrinks)
				v := strings.Repeat("u", rng.Intn(300))
				mustRun(t, db, fmt.Sprintf("UPDATE kv SET v = '%s', n = n + 1 WHERE id = %d;", v, id))
				if _, ok := model[id]; ok {
					model[id] = v
					nums[id]++
				}
			case 3: // delete a small range
				hi := id + rng.Intn(5)
				mustRun(t, db, fmt.Sprintf("DELETE FROM kv WHERE id >= %d AND id <= %d;", id, hi))
				for k := id; k <= hi; k++ {
					delete(model, k)
					delete(nums, k)
				}
			}
		}
		st := checkTable(t, db, "kv")
		if st.Keys != len(model) {
			t.Fatalf("batch %d: tree has %d keys, model has %d", batch, st.Keys, len(model))
		}
	}

	var want []string
	var ids []int
	for id := range model {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		want = append(want, fmt.Sprintf("%d|%s|%d", id, model[id], nums[id]))
	}
	st, _ := db.Exec(mustParse(t, "SELECT id, v, n FROM kv ORDER BY id;"))
	got := strings.Split(strings.TrimRight(FormatRaw(st), "\n"), "\n")
	if len(ids) == 0 {
		got = nil
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("table contents differ from model (%d vs %d rows)", len(got), len(want))
	}
	if stats := checkTable(t, db, "kv"); stats.Height < 3 {
		t.Errorf("expected a multi-level tree, got %+v", stats)
	}
}

func TestUpdatePrimaryKeyMovesRows(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 3, MaxInternalKeys: 3}})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
	for i := 1; i <= 40; i++ {
		mustRun(t, db, fmt.Sprintf("INSERT INTO t VALUES (%d, 'r%d');", i, i))
	}
	mustRun(t, db, "UPDATE t SET id = id + 1000 WHERE id <= 20;")
	checkTable(t, db, "t")
	out := mustRun(t, db, "SELECT COUNT(*), MIN(id), MAX(id) FROM t; SELECT v FROM t WHERE id = 1005;")
	if !strings.Contains(out, "40       | 21      | 1020") || !strings.Contains(out, "r5") {
		t.Errorf("out = %s", out)
	}
	if msg := runErr(t, db, "UPDATE t SET id = 30 WHERE id = 1001;"); !strings.Contains(msg, "duplicate primary key 30") {
		t.Errorf("msg = %s", msg)
	}
}

func TestDropTableFreesPagesForReuse(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 4, MaxInternalKeys: 4}})
	mustRun(t, db, "CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT);")
	for i := 1; i <= 100; i++ {
		mustRun(t, db, fmt.Sprintf("INSERT INTO big VALUES (%d, 'x');", i))
	}
	pagesBefore := db.p.PageCount()
	mustRun(t, db, "DROP TABLE big;")
	free, _ := db.p.FreeCount()
	if free < 25 {
		t.Errorf("only %d pages freed", free)
	}
	mustRun(t, db, "CREATE TABLE again (id INTEGER PRIMARY KEY);")
	for i := 1; i <= 100; i++ {
		mustRun(t, db, fmt.Sprintf("INSERT INTO again VALUES (%d);", i))
	}
	if db.p.PageCount() > pagesBefore {
		t.Errorf("file grew from %d to %d pages instead of reusing freed pages", pagesBefore, db.p.PageCount())
	}
	checkTable(t, db, "again")
}

func TestDeleteAllThenInsertAutoKeys(t *testing.T) {
	db, _ := openTemp(t, Options{Tree: btree.Config{MaxLeafCells: 3, MaxInternalKeys: 3}})
	mustRun(t, db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
	for i := 0; i < 30; i++ {
		mustRun(t, db, "INSERT INTO t (v) VALUES ('a');")
	}
	mustRun(t, db, "DELETE FROM t;")
	checkTable(t, db, "t")
	mustRun(t, db, "INSERT INTO t (v) VALUES ('b');")
	if out := mustRun(t, db, "SELECT id FROM t;"); !strings.Contains(out, "1\n(1 row)") {
		t.Errorf("auto key after delete-all: %s", out)
	}
}
