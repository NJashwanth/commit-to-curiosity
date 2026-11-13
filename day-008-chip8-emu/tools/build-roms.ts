// Assemble every roms/*.asm into public/roms/*.ch8.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assemble } from "./asm";

const root = join(import.meta.dirname, "..");
for (const file of readdirSync(join(root, "roms")).filter((f) => f.endsWith(".asm"))) {
  const rom = assemble(readFileSync(join(root, "roms", file), "utf8"));
  const out = join(root, "public", "roms", `${basename(file, ".asm")}.ch8`);
  writeFileSync(out, rom);
  console.log(`${file} -> public/roms/${basename(out)} (${rom.length} bytes)`);
}
