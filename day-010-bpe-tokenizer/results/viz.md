# Viz

`bpe viz --no-color` output. In a terminal each token gets its own background colour instead of brackets.

## 512 tokens, split

```
[To][ be][,][ ][or][ not][ to][ be][,][ that][ is][ the][ ][qu][est][ion][:]

405 308 44 32 271 325 291 308 44 327 328 268 32 452 385 408 58

42 bytes -> 17 tokens (2.47 bytes/token)
```

```
[H][ell][o][ ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ w][or][ld]

72 415 111 32 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 263 271 316

35 bytes -> 30 tokens (1.17 bytes/token)
\xNN = one byte of a character that is split across tokens
```

## 512 tokens, no-split

```
[To ][b][e, ][or][ ][not ][to ][b][e, ][that ][is ][the ][qu][es][t][ion][:]

418 98 302 268 32 327 283 98 302 361 279 295 461 280 116 412 58

42 bytes -> 17 tokens (2.47 bytes/token)
```

```
[H][ell][o ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ w][or][l][d]

72 389 269 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 288 268 108 100

35 bytes -> 30 tokens (1.17 bytes/token)
\xNN = one byte of a character that is split across tokens
```

## 1024 tokens, split

```
[To][ be][,][ or][ not][ to][ be][,][ that][ is][ the][ qu][est][ion][:]

405 308 44 532 325 291 308 44 327 328 268 562 385 408 58

42 bytes -> 15 tokens (2.80 bytes/token)
```

```
[H][ell][o][ ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ world]

72 415 111 32 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 878

35 bytes -> 28 tokens (1.25 bytes/token)
\xNN = one byte of a character that is split across tokens
```

## 1024 tokens, no-split

```
[To ][b][e, ][or ][not ][to ][b][e, ][that ][is ][the ][qu][est][ion][:]

418 98 302 601 327 283 98 302 361 279 295 461 528 412 58

42 bytes -> 15 tokens (2.80 bytes/token)
```

```
[H][ell][o ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ w][or][l][d]

72 389 269 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 288 268 108 100

35 bytes -> 30 tokens (1.17 bytes/token)
\xNN = one byte of a character that is split across tokens
```

## 4096 tokens, split

```
[To][ be][,][ or][ not][ to][ be][,][ that][ is][ the][ question][:]

405 308 44 532 325 291 308 44 327 328 268 3490 58

42 bytes -> 13 tokens (3.23 bytes/token)
```

```
[H][ello][ ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ world]

72 3936 32 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 878

35 bytes -> 27 tokens (1.30 bytes/token)
\xNN = one byte of a character that is split across tokens
```

## 4096 tokens, no-split

```
[To ][be, ][or ][not to ][b][e, that ][is the ][quest][ion][:]

418 4055 601 2915 98 2642 1251 3867 412 58

42 bytes -> 10 tokens (4.20 bytes/token)
```

```
[H][ell][o ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ wor][l][d]

72 389 269 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 1547 108 100

35 bytes -> 29 tokens (1.21 bytes/token)
\xNN = one byte of a character that is split across tokens
```
