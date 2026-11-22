CREATE TABLE m (id INTEGER PRIMARY KEY, label TEXT, price REAL, qty INTEGER);
INSERT INTO m VALUES (1, 'héllo 世界 🙂', 9.99, 3);
INSERT INTO m VALUES (2, 'multi
line', 100, 0);
INSERT INTO m VALUES (3, '', -0.5, -7);
INSERT INTO m VALUES (4, 'x', 4.0, 5.0);
SELECT * FROM m;
SELECT price * qty FROM m ORDER BY id;
SELECT id FROM m WHERE price > 9.5;
INSERT INTO m VALUES ('five', 'x', 1.0, 1);
INSERT INTO m VALUES (5, 99, 1.0, 1);
INSERT INTO m VALUES (6, 'x', 'cheap', 1);
INSERT INTO m VALUES (7, 'x', 1.0, 2.5);
INSERT INTO m VALUES (8, 'x', 1.0);
INSERT INTO m (id, nope) VALUES (9, 1);
INSERT INTO m (id, id) VALUES (9, 1);
SELECT COUNT(*) FROM m;
