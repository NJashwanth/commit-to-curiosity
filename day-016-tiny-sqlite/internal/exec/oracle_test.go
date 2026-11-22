package exec

import (
	"bytes"
	"fmt"
	"math"
	"math/rand"
	osexec "os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/sql"
)

// oracleSetup builds the same seeded table in both engines.
func oracleSetup() string {
	rng := rand.New(rand.NewSource(424242))
	names := []string{"Ada", "Grace", "Linus", "Ken", "Dennis", "Barbara", "Edsger", "Margaret", "Tim", "Radia", "ada lovelace", "O'Neil"}
	cities := []string{"Paris", "Oslo", "Lima", "Kyiv", "Pune", "Cairo", "Perth"}
	var sb strings.Builder
	sb.WriteString("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL, city TEXT);\n")
	for id := 1; id <= 600; id++ {
		age, score, city := "NULL", "NULL", "NULL"
		if rng.Intn(10) != 0 {
			age = strconv.Itoa(18 + rng.Intn(63))
		}
		if rng.Intn(10) != 0 {
			score = fmt.Sprintf("%.2f", rng.Float64()*100)
		}
		if rng.Intn(8) != 0 {
			city = "'" + cities[rng.Intn(len(cities))] + "'"
		}
		name := strings.ReplaceAll(names[rng.Intn(len(names))], "'", "''")
		fmt.Fprintf(&sb, "INSERT INTO people VALUES (%d, '%s', %s, %s, %s);\n", id*3, name, age, score, city)
	}
	return sb.String()
}

var oracleQueries = []string{
	"SELECT COUNT(*) FROM people;",
	"SELECT COUNT(age), COUNT(score), COUNT(city) FROM people;",
	"SELECT SUM(age), MIN(age), MAX(age) FROM people;",
	"SELECT AVG(score), MIN(score), MAX(score) FROM people;",
	"SELECT MIN(name), MAX(name), MIN(city), MAX(city) FROM people;",
	"SELECT SUM(age) / COUNT(age), MAX(score) - MIN(score) FROM people WHERE age > 30;",
	"SELECT id, name FROM people WHERE age > 70 ORDER BY id;",
	"SELECT name, age FROM people WHERE age >= 40 AND age <= 45 AND city = 'Oslo' ORDER BY age, id;",
	"SELECT id FROM people WHERE age IS NULL ORDER BY id;",
	"SELECT id FROM people WHERE score IS NOT NULL AND city IS NULL ORDER BY id;",
	"SELECT id FROM people WHERE name LIKE 'a%' ORDER BY id LIMIT 25;",
	"SELECT id FROM people WHERE name LIKE '%AN%' OR name LIKE '_im' ORDER BY id;",
	"SELECT id FROM people WHERE city NOT LIKE '%a' ORDER BY id LIMIT 30;",
	"SELECT id FROM people WHERE NOT (age < 30 OR score > 20) ORDER BY id;",
	"SELECT id, age FROM people WHERE age != 50 AND age < 55 ORDER BY age DESC, id LIMIT 15;",
	"SELECT id, score FROM people ORDER BY score DESC, id LIMIT 10;",
	"SELECT id, score FROM people ORDER BY score, id LIMIT 10;",
	"SELECT id, city FROM people ORDER BY city, id LIMIT 20 OFFSET 40;",
	"SELECT name, city, age FROM people ORDER BY name DESC, city, age, id LIMIT 12;",
	"SELECT id FROM people WHERE id > 300 AND id <= 330 ORDER BY id;",
	"SELECT id FROM people WHERE id = 99;",
	"SELECT id FROM people WHERE id = 100;",
	"SELECT id FROM people WHERE 1500 < id ORDER BY id;",
	"SELECT id FROM people LIMIT 5 OFFSET 7;",
	"SELECT id, age * 2 + 1, age / 7, age % 7 FROM people WHERE age IS NOT NULL ORDER BY id LIMIT 20;",
	"SELECT id, score / 3, score * age FROM people WHERE age IS NOT NULL AND score IS NOT NULL ORDER BY id LIMIT 20;",
	"SELECT id, -age, -score FROM people ORDER BY id LIMIT 10;",
	"SELECT COUNT(*), SUM(age), AVG(age) FROM people WHERE city = 'Lima' AND (age > 50 OR score > 90);",
	"SELECT COUNT(*) FROM people WHERE age > 1000;",
	"SELECT SUM(age), AVG(score), MIN(name) FROM people WHERE age > 1000;",
	"SELECT 1 + 2 * 3, 7 / 2, 7 / 2.0, 7 % 4, 'x', NULL, NULL IS NULL, 1 = NULL;",
	"SELECT id, name FROM people WHERE age = NULL;",
	"SELECT NULL AND 0, NULL OR 1, NULL AND 1, NULL OR 0, NOT NULL;",
	"SELECT id AS pid, name AS who FROM people WHERE id < 20 ORDER BY who, pid;",
}

func floatsClose(a, b string) bool {
	x, err1 := strconv.ParseFloat(a, 64)
	y, err2 := strconv.ParseFloat(b, 64)
	if err1 != nil || err2 != nil {
		return false
	}
	return math.Abs(x-y) <= 1e-9*math.Max(1, math.Max(math.Abs(x), math.Abs(y)))
}

// sameOutput compares two '|' separated listings, allowing tiny float differences.
func sameOutput(a, b string) bool {
	la := strings.Split(strings.TrimRight(a, "\n"), "\n")
	lb := strings.Split(strings.TrimRight(b, "\n"), "\n")
	if len(la) != len(lb) {
		return false
	}
	for i := range la {
		fa, fb := strings.Split(la[i], "|"), strings.Split(lb[i], "|")
		if len(fa) != len(fb) {
			return false
		}
		for j := range fa {
			if fa[j] != fb[j] && !floatsClose(fa[j], fb[j]) {
				return false
			}
		}
	}
	return true
}

func TestOracleSameOutput(t *testing.T) {
	if !sameOutput("1|2.5|x\n3||y\n", "1|2.5000000000001|x\n3||y") {
		t.Error("should match within tolerance")
	}
	if sameOutput("1|2.5\n", "1|2.6\n") || sameOutput("1\n2\n", "1\n") || sameOutput("1|2\n", "1\n") {
		t.Error("should not match")
	}
}

// TestAgainstRealSQLite runs the same queries on tinysql and on the sqlite3
// command-line tool and compares the rows. It is skipped when sqlite3 is not
// installed.
func TestAgainstRealSQLite(t *testing.T) {
	bin, err := osexec.LookPath("sqlite3")
	if err != nil {
		t.Skip("sqlite3 binary not found; skipping oracle comparison")
	}
	setup := oracleSetup()
	db, _ := openTemp(t, Options{})
	if err := db.Run(setup, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, q := range oracleQueries {
		st, err := sql.ParseOne(q)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		res, err := db.Exec(st)
		if err != nil {
			t.Errorf("tinysql failed on %s: %v", q, err)
			continue
		}
		cmd := osexec.Command(bin, "-batch", "-separator", "|", ":memory:")
		cmd.Stdin = strings.NewReader(setup + q + "\n")
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			t.Errorf("sqlite3 failed on %s: %v %s", q, err, errb.String())
			continue
		}
		if got := FormatRaw(res); !sameOutput(got, out.String()) {
			t.Errorf("results differ for %s\n--- tinysql ---\n%s--- sqlite3 ---\n%s", q, firstLines(got, 8), firstLines(out.String(), 8))
		}
	}
}

func firstLines(s string, n int) string {
	lines := strings.SplitAfter(s, "\n")
	if len(lines) > n {
		lines = append(lines[:n], "...\n")
	}
	return strings.Join(lines, "")
}
