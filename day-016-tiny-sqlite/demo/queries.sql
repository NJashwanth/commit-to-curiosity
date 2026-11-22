.timer on
.tables
.schema events
SELECT COUNT(*), SUM(amount), AVG(amount), MIN(ts), MAX(ts) FROM events;
SELECT id, user, kind, amount FROM events WHERE id >= 4995 AND id < 5000;
SELECT id, user, amount FROM events WHERE kind = 'purchase' AND amount > 499 ORDER BY amount DESC LIMIT 5;
SELECT COUNT(*), AVG(amount) FROM events WHERE user LIKE 'user00%' AND amount IS NOT NULL;
SELECT * FROM events WHERE id = 7777;
.timer off
.btree events
SELECT COUNT(*), SUM(amount) FROM events;
BEGIN;
DELETE FROM events WHERE id > 5000;
SELECT COUNT(*), SUM(amount) FROM events;
.stats
ROLLBACK;
SELECT COUNT(*), SUM(amount) FROM events;
.exit
