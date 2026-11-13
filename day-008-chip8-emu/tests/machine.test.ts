import { describe, expect, it } from "vitest";
import { Cpu } from "../src/cpu";
import {
  DEFAULT_CYCLES_PER_FRAME,
  FrameClock,
  MAX_CATCH_UP_FRAMES,
  MAX_CYCLES_PER_FRAME,
  Machine,
} from "../src/machine";
import { rom } from "./helpers";

/** LD V0, 120; LD DT, V0; LD ST, V0; loop: ADD V1, 1; JP loop */
const TIMER_PROGRAM = rom(0x6078, 0xf015, 0xf018, 0x7101, 0x1206);

function machineWith(program: Uint8Array, cyclesPerFrame: number, quirks = {}): Machine {
  const cpu = new Cpu({ quirks: { displayWait: false, ...quirks } });
  cpu.load(program);
  return new Machine(cpu, cyclesPerFrame);
}

/** Run TIMER_PROGRAM's three setup instructions without ticking the timers. */
function runSetup(m: Machine): void {
  for (let k = 0; k < 3; k++) m.cpu.step();
  expect(m.cpu.delayTimer).toBe(120);
}

describe("FrameClock", () => {
  it("turns one second into exactly 60 frames", () => {
    const clock = new FrameClock(Infinity);
    expect(clock.advance(1000)).toBe(60);
  });

  it("carries remainders across uneven callbacks", () => {
    const clock = new FrameClock(Infinity);
    let frames = 0;
    // A 144Hz display: 144 callbacks of ~6.94ms.
    for (let k = 0; k < 144; k++) frames += clock.advance(1000 / 144);
    expect(frames).toBe(60);
  });

  it("ignores zero, negative and non-finite deltas", () => {
    const clock = new FrameClock();
    expect(clock.advance(0)).toBe(0);
    expect(clock.advance(-50)).toBe(0);
    expect(clock.advance(Number.NaN)).toBe(0);
  });

  it("caps catch-up after a long pause and drops the backlog", () => {
    const clock = new FrameClock();
    expect(clock.advance(10_000)).toBe(MAX_CATCH_UP_FRAMES);
    expect(clock.advance(10)).toBe(0);
  });

  it("reset drops any partial frame", () => {
    const clock = new FrameClock();
    clock.advance(16);
    clock.reset();
    expect(clock.advance(1)).toBe(0);
  });
});

describe("Machine timing", () => {
  it.each([1, 7, 15, 100, 1000])(
    "timers drop by 60 per second at %i cycles per frame",
    (cpf) => {
      const m = machineWith(TIMER_PROGRAM, cpf);
      runSetup(m);
      const start = m.cpu.delayTimer;
      for (let k = 0; k < 60; k++) m.advance(1000 / 60);
      expect(start - m.cpu.delayTimer).toBe(60);
      expect(m.cpu.soundTimer).toBe(m.cpu.delayTimer);
    },
  );

  it("timers keep 60Hz with an irregular frame rate", () => {
    const m = machineWith(TIMER_PROGRAM, 10);
    runSetup(m);
    const start = m.cpu.delayTimer;
    const deltas = [7, 33, 16, 50, 1, 9, 24, 60, 17, 33]; // 250ms total
    for (let k = 0; k < 4; k++) for (const d of deltas) m.advance(d);
    expect(start - m.cpu.delayTimer).toBe(60);
  });

  it("CPU speed follows cycles per frame while timers do not", () => {
    const a = machineWith(TIMER_PROGRAM, 10);
    const b = machineWith(TIMER_PROGRAM, 100);
    // Three frames keeps the 8-bit loop counter in V1 from wrapping.
    for (let k = 0; k < 3; k++) {
      a.advance(1000 / 60);
      b.advance(1000 / 60);
    }
    expect(a.cpu.delayTimer).toBe(b.cpu.delayTimer);
    expect(a.cpu.v[1]).toBe(14); // 27 instructions after setup, ADD first
    expect(b.cpu.v[1]).toBe(149); // 297 instructions after setup
    expect(a.frameCount).toBe(3);
  });

  it("runs exactly cyclesPerFrame instructions per frame", () => {
    const m = machineWith(rom(0x7101, 0x1200), 10);
    expect(m.runFrame()).toBe(10);
    expect(m.cpu.v[1]).toBe(5);
    m.cyclesPerFrame = 4;
    m.runFrame();
    expect(m.cpu.v[1]).toBe(7);
  });

  it("advance returns the number of frames run", () => {
    const m = machineWith(rom(0x1200), 1);
    expect(m.advance(1000 / 60 * 3)).toBe(3);
    expect(m.frameCount).toBe(3);
  });
});

describe("Machine stalls", () => {
  it("a CPU waiting for a key sits out the frame but timers still tick", () => {
    const m = machineWith(rom(0x6005, 0xf015, 0xf00a), 50);
    expect(m.runFrame()).toBe(3);
    expect(m.cpu.blocked).toBe(true);
    m.runFrame();
    expect(m.cpu.delayTimer).toBe(3);
  });

  it("display wait limits drawing to one sprite per frame", () => {
    // loop: DRW V0, V1, 1; ADD V2, 1; JP loop
    const m = machineWith(rom(0xd011, 0x7201, 0x1200), 100, { displayWait: true });
    m.runFrame();
    expect(m.cpu.v[2]).toBe(1);
    m.runFrame();
    expect(m.cpu.v[2]).toBe(2);
  });
});

describe("Machine stepping (debugger)", () => {
  it("steps one instruction at a time", () => {
    const m = machineWith(rom(0x6001, 0x6102), 10);
    m.stepInstruction();
    expect(m.cpu.pc).toBe(0x202);
    expect(m.cycleInFrame).toBe(1);
  });

  it("ticks timers after cyclesPerFrame steps", () => {
    const m = machineWith(TIMER_PROGRAM, 3);
    m.stepInstruction();
    m.stepInstruction();
    expect(m.cpu.delayTimer).toBe(120);
    m.stepInstruction(); // third step ends the frame
    expect(m.cpu.delayTimer).toBe(119);
    expect(m.cycleInFrame).toBe(0);
    expect(m.frameCount).toBe(1);
  });

  it("a partly stepped frame finishes with runFrame", () => {
    const m = machineWith(rom(0x7101, 0x1200), 10);
    m.stepInstruction();
    m.stepInstruction();
    expect(m.runFrame()).toBe(8);
  });

  it("stepping into a display wait ends the frame so the next step can draw", () => {
    const m = machineWith(rom(0xd011, 0xd011, 0x6301), 100, { displayWait: true });
    m.stepInstruction(); // draws
    m.stepInstruction(); // blocks, frame ends, vblank releases it
    expect(m.cpu.pc).toBe(0x202);
    m.stepInstruction(); // second draw
    expect(m.cpu.pc).toBe(0x204);
  });

  it("reset clears frame state", () => {
    const m = machineWith(rom(0x1200), 10);
    m.stepInstruction();
    m.runFrame();
    m.reset();
    expect(m.cycleInFrame).toBe(0);
    expect(m.frameCount).toBe(0);
  });
});

describe("cyclesPerFrame", () => {
  it("defaults sensibly", () => {
    expect(new Machine(new Cpu()).cyclesPerFrame).toBe(DEFAULT_CYCLES_PER_FRAME);
  });

  it("is clamped and rounded", () => {
    const m = new Machine(new Cpu());
    m.cyclesPerFrame = 0;
    expect(m.cyclesPerFrame).toBe(1);
    m.cyclesPerFrame = 1e9;
    expect(m.cyclesPerFrame).toBe(MAX_CYCLES_PER_FRAME);
    m.cyclesPerFrame = 12.6;
    expect(m.cyclesPerFrame).toBe(13);
    m.cyclesPerFrame = Number.NaN;
    expect(m.cyclesPerFrame).toBe(1);
  });
});
