import { PRESETS } from "./quirks";
import type { RomProfile } from "./ui";

export interface BuiltInRom {
  id: string;
  title: string;
  file: string;
  author: string;
  /** Where it came from and its license. See ROMS.md. */
  origin: "own" | "chip8-archive";
  controls: string;
  profile: RomProfile;
}

/**
 * ROMs that ship with the emulator. Only ROMs written for this project or
 * released under CC0 by the CHIP-8 Community Archive. Quirks and speeds for
 * the archive games come from the archive's programs.json.
 */
export const BUILT_IN_ROMS: readonly BuiltInRom[] = [
  {
    id: "jn-demo",
    title: "J N demo",
    file: "jn-demo.ch8",
    author: "Jashwanth Neela",
    origin: "own",
    controls: "No input: watch the ball bounce and beep",
    // No display wait, and enough cycles to erase and redraw the ball in one
    // frame, so it never flickers. It also runs under the VIP preset.
    profile: { quirks: PRESETS.octo, cyclesPerFrame: 30 },
  },
  {
    id: "keypad",
    title: "Keypad test",
    file: "keypad.ch8",
    author: "Jashwanth Neela",
    origin: "own",
    controls: "Press any key to see its hex digit",
    profile: { quirks: PRESETS.vip, cyclesPerFrame: 15 },
  },
  {
    id: "br8kout",
    title: "Br8kout",
    file: "br8kout.ch8",
    author: "SharpenedSpoon",
    origin: "chip8-archive",
    controls: "A and D move the paddle",
    profile: { quirks: PRESETS.octo, cyclesPerFrame: 7 },
  },
  {
    id: "superpong",
    title: "Super Pong",
    file: "superpong.ch8",
    author: "offstatic",
    origin: "chip8-archive",
    controls: "E starts, then W/S and A/D move the paddles",
    profile: { quirks: PRESETS.octo, cyclesPerFrame: 30 },
  },
  {
    id: "flightrunner",
    title: "Flight Runner",
    file: "flightrunner.ch8",
    author: "TodPunk",
    origin: "chip8-archive",
    controls: "W A S D to fly",
    profile: { quirks: PRESETS.octo, cyclesPerFrame: 15 },
  },
  {
    id: "snek",
    title: "Snek",
    file: "snek.ch8",
    author: "John Earnest",
    origin: "chip8-archive",
    controls: "W A S D to steer",
    profile: { quirks: PRESETS.octo, cyclesPerFrame: 1000 },
  },
];

export const DEFAULT_ROM_ID = "jn-demo";

export function findRom(id: string | null | undefined): BuiltInRom | undefined {
  return BUILT_IN_ROMS.find((rom) => rom.id === id);
}

/** URL of a bundled ROM, relative to the site's base path. */
export function romUrl(rom: BuiltInRom, base: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}roms/${rom.file}`;
}
