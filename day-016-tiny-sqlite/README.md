# Day 016: tiny-sqlite

**Date:** 2026-11-22

## What it does

`tinysql` is a small relational database in Go, standard library only. It has a REPL, a hand-written SQL parser, an on-disk B+tree per table, and real transactions with a rollback journal.

```
go run ./cmd/tinysql mydb.db
tinysql> CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL);
tinysql> INSERT INTO users VALUES (1, 'Jash', 27, 98.5);
tinysql> SELECT name, age FROM users WHERE age > 25 ORDER BY name LIMIT 10;
tinysql> SELECT COUNT(*), AVG(score) FROM users;
tinysql> .tables   .schema users   .btree users   .stats   .exit
```

The data lives in one file (plus a `-journal` file while a commit is in flight). Close the REPL, reopen it, and the rows are still there. Kill the process in the middle of a commit and the next open rolls the file back to the last committed state.

## Why I built it

I use SQLite all the time and had never looked at what a "table" actually is on disk. The question: what is the smallest thing that still deserves to be called a database, with pages, a tree, and crash safety, and can I build all of it in one day?

## Tech used

- Go 1.24, standard library only (no cgo, no dependencies)
- A hand-written lexer and recursive-descent parser
- A pager with 4096-byte pages and an LRU page cache
- B+trees (int64 keys, leaf sibling pointers) stored in those pages
- A rollback journal with CRC32C checksums for crash recovery
- `go test -race -cover` with golden files, seeded randomised tests, crash injection, and an oracle test against the `sqlite3` binary

## How to run

```bash
cd day-016-tiny-sqlite
go run ./cmd/tinysql mydb.db           # interactive REPL
go run ./cmd/tinysql -echo mydb.db < script.sql   # run a script, echoing each line

go test -race -cover ./...             # all tests (about 92% coverage)
demo/run.sh                            # 10,000-row demo shown below
go run ./cmd/seed -rows 10000 | go run ./cmd/tinysql demo.db   # load demo data yourself
```

Statements end with `;` and may span several lines. Meta commands start with a dot:

| Command | What it does |
|---|---|
| `.tables` | list tables |
| `.schema [table]` | print `CREATE TABLE` statements |
| `.btree <table>` | print the B+tree: page numbers, separator keys, rows per leaf, sibling links |
| `.stats` | file size in pages, cache hits and misses, disk reads and writes, open transaction |
| `.timer on\|off` | print the run time after each statement |
| `.help`, `.exit` | help, quit |

## How a database stores your rows

### The file

Everything is a 4096-byte page. Page 0 is the file header, page 1 is the schema catalog, and every other page is a B+tree node or a free-list entry.

```
 page 0           page 1           page 2           page 3 ...
+--------------+ +--------------+ +--------------+ +--------------+
| header       | | catalog      | | users        | | users        |
|  "TINYSQLT"  | |  tables:     | | B+tree root  | | B+tree node  |
|  version = 1 | |   users      | |  (internal   | |  (leaf)      |
|  page size   | |    root = 2  | |   or leaf)   | |              |
|  page count  | |    id  INT PK| |              | |              |
|  free list   | |    name TEXT | |              | |              |
|  head        | |    ...       | |              | |              |
+--------------+ +--------------+ +--------------+ +--------------+
```

Header (page 0): bytes 0-7 magic `TINYSQLT`, 8-11 version, 12-15 page size, 16-19 page count, 20-23 head of the free list. Opening a file with the wrong magic, version or page size is refused with a clear error. Freed pages (from `DROP TABLE`) form a linked list and are reused before the file grows.

### One row

A row is a list of cells. This is `(1, 'Jash', 27, 98.5)` in 20 bytes:

```
04            column count
01 02         INTEGER 1       (tag 01, zigzag varint)
03 04 4a 61 73 68   TEXT 'Jash'   (tag 03, length 4, UTF-8 bytes)
01 36         INTEGER 27      (zigzag(27) = 54 = 0x36)
02 00 00 00 00 00 a0 58 40   REAL 98.5  (tag 02, 8 bytes IEEE 754)
```

NULL is just the tag `00`.

### A B+tree node

Each table is one B+tree keyed by its `INTEGER PRIMARY KEY`. Rows live only in the leaves. Internal nodes only route.

```
leaf page                                     internal page
+------+--------+-----------+---------+      +------+--------+---------------+---------+
| type | n keys | next leaf | (unused)|      | type | n keys | rightmost kid | (unused)|
+------+--------+-----------+---------+      +------+--------+---------------+---------+
| key(8) len(2) row bytes | key len row bytes | ...  | key(8) child(4) | key child | ...
```

A node with keys `k0 < k1 < ... ` sends a lookup for `x` to child `i`, the first with `x < k_i`, or to the rightmost child. Leaves point to their right sibling, so a range scan seeks once to the first key and then just follows the links.

### The tree after a few splits

Insert 10, 20, ..., 130 with a toy node size of 3 rows per leaf and 3 keys per internal node (the real defaults are about 90 rows and 340 keys). The tree structure as `.btree` prints it (minus its one-line summary):

```
[internal #2] separators [100]
  [internal #9] separators [40 70]
    [leaf #4] keys 10..30 (3 rows) -> #3
    [leaf #3] keys 40..60 (3 rows) -> #5
    [leaf #5] keys 70..90 (3 rows) -> #6
  [internal #8] separators [130]
    [leaf #6] keys 100..120 (3 rows) -> #7
    [leaf #7] keys 130..130 (1 rows) -> end
```

As a picture (`>` is the sibling link):

```
                              [ 100 ]                    <- root, page 2 (never moves)
                       /                  \
              [ 40 | 70 ]                [ 130 ]
             /     |      \             /        \
     [10 20 30]>[40 50 60]>[70 80 90]>[100 110 120]>[130]
       leaf #4    leaf #3    leaf #5     leaf #6      leaf #7
```

What happened on the way:

1. Rows 10, 20, 30 fill the root leaf. Inserting 40 overflows it, so it splits into `[10 20 30]` and `[40]` and the root becomes an internal node `[40]`.
2. Each further overflow splits the rightmost leaf the same way and adds a separator (70, then 100) to the root.
3. Inserting 130 overflows the last leaf and pushes the root to four separators, one too many. The root splits: its middle key 100 moves up into a new root, and `[40 70]` and `[130]` become its two children.
4. The root page id stays 2 the whole time. When the root splits, its contents are copied to a fresh page and page 2 is rewritten as the new internal node, so the catalog never has to be updated.

Two details worth knowing:

- Appending to the rightmost leaf (what auto-increment style inserts do) leaves the old leaf completely full. A normal split is 50/50 by bytes. Loading 4000 keys in order uses far fewer leaves than loading them shuffled (there is a test for it).
- Deletes do not rebalance. A leaf can become small or empty and scans skip it. All pages are returned by `DROP TABLE`. This keeps the tree code short at the cost of space after heavy deletes.

### Transactions and the rollback journal

```
BEGIN        modified pages stay in the page cache; the database file is NOT touched.
             The first time a page is modified, its original bytes are appended to
             demo.db-journal  (page id, 4096 bytes, CRC32C).

COMMIT       1. fsync the journal
             2. write every dirty page into demo.db
             3. fsync demo.db
             4. delete the journal            <- the commit point

ROLLBACK     drop the dirty pages from the cache. Nothing on disk changed.
```

If the process dies anywhere before step 4, the journal is still there at the next `Open`. Recovery copies the original pages back (stopping at the first entry whose checksum fails), truncates the file to its original size, and deletes the journal. If it dies after step 4, the commit already happened.

`txn.Manager` can simulate a crash at every step, including a torn write that leaves a page half old and half new. The tests check recovery after a crash during the journal write, after the journal sync, in the middle of the database write (0, 1, 4, 9 pages in, plus a torn page), after the database write, and after the commit point. A 60-round randomised test mixes all of them and asserts the file is always exactly the old or the new state. The same crash points are driven through SQL (`BEGIN; DELETE ...; UPDATE ...; CREATE TABLE ...; COMMIT;`) in the exec tests.

Outside `BEGIN`, every statement is its own transaction (autocommit). Inside one, a statement that fails (say the third row of a multi-row `INSERT` hits a duplicate key) is undone by an in-memory savepoint and the transaction stays open.

## Supported SQL

```sql
CREATE TABLE [IF NOT EXISTS] name (col type [PRIMARY KEY], ...);   -- types: INTEGER, REAL, TEXT
DROP TABLE [IF EXISTS] name;

INSERT INTO name [(col, ...)] VALUES (expr, ...) [, (expr, ...)]...;

SELECT * | expr [[AS] alias], ...
  [FROM name]
  [WHERE expr]
  [ORDER BY expr [ASC|DESC], ...]
  [LIMIT n [OFFSET m]];

UPDATE name SET col = expr [, col = expr]... [WHERE expr];
DELETE FROM name [WHERE expr];

BEGIN [TRANSACTION];   COMMIT;   ROLLBACK;
```

Expressions, from loosest to tightest binding:

| Level | Operators |
|---|---|
| 1 | `OR` |
| 2 | `AND` |
| 3 | `NOT` |
| 4 | `=` `!=` `<>` `<` `<=` `>` `>=` `IS [NOT] NULL` `[NOT] LIKE` |
| 5 | `+` `-` |
| 6 | `*` `/` `%` |
| 7 | unary `-` |

- Aggregates: `COUNT(*)`, `COUNT(x)`, `SUM`, `AVG`, `MIN`, `MAX`. They work over the whole table (or the `WHERE` result) and can be combined in expressions such as `SUM(age) / COUNT(age)`. There is no `GROUP BY`.
- Literals: integers, reals (`1.5`, `1e3`), strings in single quotes with `''` as an escaped quote, `NULL`. Comments: `-- line` and `/* block */`. Keywords are case-insensitive. Quote an identifier that collides with a keyword, for example `"key"`.
- `NULL` follows SQL three-valued logic: `NULL = NULL` is `NULL`, `NULL AND 0` is `0`, `NULL OR 1` is `1`, and `WHERE` keeps only rows that evaluate to true. In `ORDER BY`, `NULL` sorts first. Numbers sort before text.
- `LIKE`: `%` matches any run, `_` matches one character, ASCII letters match case-insensitively.
- Division by zero gives `NULL`. Integer `/` truncates (`7 / 2` is `3`).
- `ORDER BY` accepts expressions, select-list aliases and 1-based positions.
- Type checking on `INSERT` and `UPDATE`: an INTEGER column takes integers (or a real with an exact integer value), a REAL column takes any number, a TEXT column takes text. Anything else is `type mismatch: column "age" is INTEGER, got TEXT 'abc'`.
- The primary key is required, must be INTEGER, and is unique (`duplicate primary key 3 in table t`). Omit it or insert `NULL` and the next free key (max + 1) is used. `WHERE` terms like `id = 5`, `id > 10 AND id <= 20` turn into B+tree seeks.
- Errors carry positions: `syntax error at line 2, column 10: expected an expression, found ';'` and `line 1, column 8: no such column: nope`.

Limits: a row can encode to at most 1000 bytes (no overflow pages); the catalog must fit in page 1 (roughly 50 small tables); no joins, `GROUP BY`, secondary indexes or `ALTER TABLE`; one process at a time (no file locking).

## Tests

`go test -race -cover ./...` gives 91.8% statement coverage across packages.

| Package | What is tested |
|---|---|
| `internal/sql` | tokens, string escaping, every statement type, operator precedence, 30 syntax errors with exact line and column |
| `internal/record` | round trips for every type, NULL, unicode, extremes, 500 random rows, every truncation of a record |
| `internal/pager` | writes and reads, persistence across reopen, bad magic, version and page size, cache eviction, free list, journal hooks, torn writes, statement savepoints |
| `internal/catalog` | persistence, validation, corrupt page, full page |
| `internal/btree` | 10,000 seeded random inserts (sorted, every key found, invariants), nodes shrunk to 2 to 6 keys for deep trees, random range scans against a reference, delete and update keep the tree valid, deliberate corruption is caught |
| `internal/exec` | golden transcripts in `testdata/*.sql` / `.golden` (also re-run with tiny nodes), a random insert/update/delete workload checked against a Go map, SQL-level crash recovery, **an oracle test that runs 34 queries on both tinysql and the `sqlite3` binary** |
| `internal/txn` | rollback, commit, and crash injection at every commit step |

The oracle test is skipped when `sqlite3` is not on the `PATH`.

## Demo: 10,000 rows, five queries, `.btree`, and a rolled-back delete

Produced by `demo/run.sh` (the same output is saved in `demo/transcript.txt`). The first line is the load: `seed` prints seeded SQL and `tinysql` runs it in one transaction.

```
$ seed -rows 10000 | tinysql demo.db
loaded 10,000 rows in one transaction: 127 ms (including process start)

$ tinysql demo.db
tinysql> .timer on
tinysql> .tables
events
tinysql> .schema events
CREATE TABLE events (id INTEGER PRIMARY KEY, user TEXT, kind TEXT, amount REAL, ts INTEGER);
tinysql> SELECT COUNT(*), SUM(amount), AVG(amount), MIN(ts), MAX(ts) FROM events;
COUNT(*) | SUM(amount)        | AVG(amount)        | MIN(ts)    | MAX(ts)
---------+--------------------+--------------------+------------+-----------
10000    | 2359229.8300000005 | 247.81825945378156 | 1700008742 | 1731532639
(1 row)
Run time: 3.615 ms
tinysql> SELECT id, user, kind, amount FROM events WHERE id >= 4995 AND id < 5000;
id   | user    | kind     | amount
-----+---------+----------+-------
4995 | user018 | click    | 441.81
4996 | user097 | view     | 174.25
4997 | user092 | click    | 339.73
4998 | user087 | click    | 484.61
4999 | user101 | purchase | 481.88
(5 rows)
Run time: 2.912 ms
tinysql> SELECT id, user, amount FROM events WHERE kind = 'purchase' AND amount > 499 ORDER BY amount DESC LIMIT 5;
id   | user    | amount
-----+---------+-------
3478 | user104 | 499.99
1343 | user132 | 499.53
9988 | user068 | 499.43
3915 | user018 | 499.22
9882 | user052 | 499.12
(5 rows)
Run time: 2.770 ms
tinysql> SELECT COUNT(*), AVG(amount) FROM events WHERE user LIKE 'user00%' AND amount IS NOT NULL;
COUNT(*) | AVG(amount)
---------+-------------------
473      | 255.46289640591962
(1 row)
Run time: 3.821 ms
tinysql> SELECT * FROM events WHERE id = 7777;
id   | user    | kind   | amount | ts
-----+---------+--------+--------+-----------
7777 | user050 | refund | 377.17 | 1701246846
(1 row)
Run time: 0.055 ms
tinysql> .timer off
tinysql> .btree events
table events: root page #2, height 2, 113 leaves, 1 internal nodes, 10000 rows
[internal #2] separators [91 180 270 ... 9896 9983] (112 keys)
  [leaf #4] keys 1..90 (90 rows) -> #3
  [leaf #3] keys 91..179 (89 rows) -> #5
  [leaf #5] keys 180..269 (90 rows) -> #6
  [leaf #6] keys 270..358 (89 rows) -> #7
  [leaf #7] keys 359..447 (89 rows) -> #8
  [leaf #8] keys 448..536 (89 rows) -> #9
  ... 105 more children ...
  [leaf #114] keys 9896..9982 (87 rows) -> #115
  [leaf #115] keys 9983..10000 (18 rows) -> end
tinysql> SELECT COUNT(*), SUM(amount) FROM events;
COUNT(*) | SUM(amount)
---------+-------------------
10000    | 2359229.8300000005
(1 row)
tinysql> BEGIN;
Transaction started.
tinysql> DELETE FROM events WHERE id > 5000;
5000 rows deleted.
tinysql> SELECT COUNT(*), SUM(amount) FROM events;
COUNT(*) | SUM(amount)
---------+-------------------
5000     | 1174196.8000000003
(1 row)
tinysql> .stats
file:          demo.db
page size:     4096 bytes
pages:         116 (0 free)
cache:         115 pages cached, 58 dirty
cache hits:    20763, misses: 115
disk I/O:      115 page reads, 0 page writes
tables:        1
transaction:   active (58 dirty pages)
tinysql> ROLLBACK;
Rolled back.
tinysql> SELECT COUNT(*), SUM(amount) FROM events;
COUNT(*) | SUM(amount)
---------+-------------------
10000    | 2359229.8300000005
(1 row)
tinysql> .exit
```

Notes on the numbers:

- Timings are single runs on a small shared container and vary. A primary-key lookup (`id = 7777`) took 0.03 to 0.4 ms across repeated runs. The primary-key range query took between 0.03 and 3 ms depending on noise, while the queries that scan all 10,000 rows (`kind = ...`, `LIKE`, the aggregates) took about 3 to 4 ms each. The lookups touch two pages (the root and one leaf); the scans touch all 113 leaves.
- `.btree` shows one internal root over 113 leaves of about 90 rows each. The leaves are not in page order (leaf #4 comes first) because the root was split into new pages while keeping page 2 as the root.
- The `.stats` call is inside the open transaction: 58 dirty pages (the leaves the `DELETE` touched), 0 page writes so far. After `ROLLBACK` the count and sum are back to `10000` and `2359229.8300000005`.
- Comparison with SQLite: the `sqlite3` command-line binary is not installed in the environment I built this in. As a stand-in I loaded the same SQL into the SQLite library that ships with Python (version 3.53.1) and compared the five demo queries. All five returned identical rows, with floating point values equal to 9 significant digits. The Go oracle test in `internal/exec` does the same comparison for 34 queries against the real `sqlite3` binary whenever one is available.

## What I learned

- Making the cache "no-steal" (dirty pages never reach the database file before commit) is what makes ROLLBACK trivial and recovery simple. The journal is only needed for crashes, not for ordinary rollbacks.
- Keeping the root page id fixed when the root splits is a small trick that removes a whole class of bookkeeping, since the catalog never needs updating.
- The sequential-insert split optimisation matters: the shuffled load of 4000 keys needs noticeably more leaves than the ordered one.
- Crash safety is mostly about ordering. The journal must be durable before the first database page changes, and "delete the journal" has to be the single step that decides the outcome. Writing a test that tears a page in half made that concrete.
- Statement-level atomicity (a failed multi-row `INSERT` leaving nothing behind) needed its own savepoint, separate from the transaction.
- SQL's three-valued logic has more corner cases than I expected: `NULL AND 0` is `0` but `NULL AND 1` is `NULL`. The oracle test is the cheapest way I found to check those against the real thing.
- A cache bug found by the tests: loading a page evicted other clean pages, including the page it had just loaded, before the caller could mark it dirty. It showed up as a nil pointer in `Flush` once more than a few pages were dirty.

## Ideas to extend

- `GROUP BY`, `JOIN`, and secondary indexes (another B+tree keyed by the column value).
- Merge and rebalance on delete so deleted space is reused.
- Overflow pages for rows larger than a quarter of a page.
- A write-ahead log with checkpoints instead of the rollback journal, so readers and a writer can overlap.
- File locking so two processes cannot open the same database.
- A `.dump` command and `.import` for CSV.

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
