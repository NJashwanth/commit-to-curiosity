# Bundled ROMs

The emulator only ships ROMs that were written for this project or that are in the public domain. Each one lives in [`public/roms/`](public/roms/) and appears in the **Built-in ROMs** dropdown. The quirk preset and speed listed for each ROM are applied when you pick it.

A test (`tests/roms.test.ts`) checks that every bundled file is listed here with a matching SHA-256 checksum, so this table can't drift from what actually ships.

## Written for this project

| File | Title | Author | Preset · speed | Source | SHA-256 |
|------|-------|--------|----------------|--------|---------|
| `jn-demo.ch8` | J N demo | Jashwanth Neela | Octo · 30 | [`roms/jn-demo.asm`](roms/jn-demo.asm) | `6d5dab7e67dbb267e5ebd842eaf4d0f9862669dc4225ea039b76afc8cbb81844` |
| `keypad.ch8` | Keypad test | Jashwanth Neela | VIP · 15 | [`roms/keypad.asm`](roms/keypad.asm) | `17c2c53b0d587a568a493e6058feca6be121bc9af6af20917e43a9a163a41b32` |

**License:** original work, written for this repository and covered by the same terms as the rest of it.

These are assembled with the small assembler in [`tools/asm.ts`](tools/asm.ts). After editing a `.asm` file, run `npm run roms` to rebuild the `.ch8`. A test fails if the committed binary and its source disagree.

- **J N demo** draws the initials "J N" and a divider, then bounces a ball underneath that beeps on every wall. It exercises CLS, DRW with XOR erasing, CALL/RET, the delay timer for frame pacing and the sound timer.
- **Keypad test** waits for a key (FX0A), draws its hex digit from the built-in font (FX29) inside a box and beeps. Useful for checking the keyboard mapping and the touch keys.

## From the CHIP-8 Community Archive (CC0)

Source: [JohnEarnest/chip8Archive](https://github.com/JohnEarnest/chip8Archive), commit `761e3ffc63f43e6a849e80714122feff2afca208`, files from `roms/`.

**License:** [Creative Commons Zero (CC0 1.0)](https://creativecommons.org/publicdomain/zero/1.0/). The archive's README states: "everything in this repository is placed under the Creative Commons 0 'No Rights Reserved' license." Authors are credited below anyway.

| File | Title | Author | Released | Preset · speed | Controls | SHA-256 |
|------|-------|--------|----------|----------------|----------|---------|
| `br8kout.ch8` | Br8kout | SharpenedSpoon | 2014-09-01 (Octojam 1) | Octo · 7 | A / D | `a1589caa2cd48904a5f77bae12c6887b7ba196d130daecfc2f4d230d20cb1f6b` |
| `superpong.ch8` | Super Pong | offstatic | 2021-10-15 (Octojam 8) | Octo · 30 | W/S, A/D, E restarts | `98e64a4728f15e969148a503d4176fe803df72307d86f353f2bb472cc3287899` |
| `flightrunner.ch8` | Flight Runner | TodPunk | 2014-11-01 (Octojam 1) | Octo · 15 | W A S D | `982b4799ec822369ea26f0884669fd23caeec805d10e5e9caff434e0851b2e5e` |
| `snek.ch8` | Snek | John Earnest | 2021-10-01 (Octojam 8) | Octo · 1000 | W A S D | `09f67a5ef6f3cd9a65edc1e73786bf31a524e279bc1607e1953c6eb80c33b6ee` |

The speeds are the `tickrate` values from the archive's `programs.json`, and the quirk flags it lists (`shiftQuirks`, `loadStoreQuirks`, `clipQuirks`, `vBlankQuirks`, `jumpQuirks`, `logicQuirks`, all false or unset) match this emulator's **Octo** preset. Controls come from each game's readme or source. Octo maps keys the same way this emulator does, so "WASD" means the keyboard keys W, A, S, D (keypad 5, 7, 8, 9).

## What is not bundled

Classic ROMs such as the 1970s and 1990s games found in most CHIP-8 collections have unclear licensing, so they are not included. You can still load any `.ch8` file you have with **Open ROM…** or by dropping it on the screen. Nothing is uploaded: files are read in the browser.
