import { Cpu, PROGRAM_START } from "../src/cpu";

/** Encode 16-bit opcodes as a big-endian ROM. */
export function rom(...opcodes: number[]): Uint8Array {
  const bytes = new Uint8Array(opcodes.length * 2);
  opcodes.forEach((op, k) => {
    bytes[k * 2] = op >> 8;
    bytes[k * 2 + 1] = op & 0xff;
  });
  return bytes;
}

/** A CPU with the given opcodes loaded at 0x200. */
export function cpuWith(...opcodes: number[]): Cpu {
  const cpu = new Cpu();
  cpu.load(rom(...opcodes));
  return cpu;
}

/** Execute `count` instructions. */
export function run(cpu: Cpu, count: number): Cpu {
  for (let k = 0; k < count; k++) cpu.step();
  return cpu;
}

export { PROGRAM_START };
