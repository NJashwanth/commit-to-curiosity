import { describe, expect, it } from "vitest";
import {
  MAX_SWING,
  Scheduler,
  stepDuration,
  stepTime,
  swingOffset,
  type SchedulerOptions,
  type StepEvent,
  type TimerApi,
} from "../src/scheduler";

class FakeTimer implements TimerApi {
  pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  cleared: number[] = [];
  private next = 1;
  set(fn: () => void, ms: number) {
    const id = this.next++;
    this.pending.push({ fn, ms, id });
    return id;
  }
  clear(h: unknown) {
    this.cleared.push(h as number);
    this.pending = this.pending.filter((p) => p.id !== h);
  }
  fire() {
    const p = this.pending.shift();
    p?.fn();
    return p;
  }
}

function make(over: Partial<SchedulerOptions> & { tempo?: number; swing?: number; length?: number } = {}) {
  const clock = { currentTime: 0 };
  const events: StepEvent[] = [];
  let wraps = 0;
  const state = { tempo: over.tempo ?? 120, swing: over.swing ?? 0, length: over.length ?? 16 };
  const timer = new FakeTimer();
  const s = new Scheduler({
    clock,
    getTempo: () => state.tempo,
    getSwing: () => state.swing,
    getLength: () => state.length,
    onStep: (e) => events.push(e),
    onWrap: () => wraps++,
    timer,
    ...over,
  });
  return { s, clock, events, state, timer, wraps: () => wraps };
}

/** Advance the audio clock in `dt` steps, ticking after each, like a 25 ms timer would. */
function run(t: ReturnType<typeof make>, seconds: number, dt = 0.025) {
  if (!t.s.isRunning) t.s.start();
  const end = t.clock.currentTime + seconds;
  while (t.clock.currentTime < end - 1e-12) {
    t.clock.currentTime += dt;
    t.s.tick();
  }
}

describe("step maths", () => {
  it("a step is a sixteenth note", () => {
    expect(stepDuration(60)).toBeCloseTo(0.25);
    expect(stepDuration(120)).toBeCloseTo(0.125);
    expect(stepDuration(200)).toBeCloseTo(0.075);
  });
  it("clamps tempo to 60..200", () => {
    expect(stepDuration(10)).toBeCloseTo(0.25);
    expect(stepDuration(999)).toBeCloseTo(0.075);
  });
  it("swing moves only odd steps, by a share of a step", () => {
    expect(swingOffset(0, 120, 50)).toBe(0);
    expect(swingOffset(2, 120, 50)).toBe(0);
    expect(swingOffset(1, 120, 50)).toBeCloseTo(0.0625);
    expect(swingOffset(3, 120, 0)).toBe(0);
    expect(swingOffset(1, 120, 75)).toBeCloseTo(0.09375);
    expect(swingOffset(1, 120, 500)).toBeCloseTo(0.09375); // clamped to MAX_SWING
    expect(swingOffset(1, 120, -5)).toBe(0);
  });
  it("stepTime places steps on the grid plus swing", () => {
    expect(stepTime(1, 0, 120, 50)).toBe(1);
    expect(stepTime(1, 1, 120, 0)).toBeCloseTo(1.125);
    expect(stepTime(1, 1, 120, 50)).toBeCloseTo(1.1875);
    expect(stepTime(1, 2, 120, 50)).toBeCloseTo(1.25);
  });
  it("never lets a swung step cross its neighbour, even at maximum swing", () => {
    for (const tempo of [60, 100, 200]) {
      let prev = -Infinity;
      for (let i = 0; i < 64; i++) {
        const t = stepTime(0, i, tempo, MAX_SWING);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
    }
  });
});

describe("step times", () => {
  it.each([60, 90, 120, 174, 200])("lands steps exactly on the grid at %i BPM", (tempo) => {
    const t = make({ tempo });
    run(t, 4);
    const start = t.events[0].time;
    expect(start).toBeCloseTo(0.06);
    t.events.forEach((e, i) => {
      expect(e.index).toBe(i);
      expect(e.time).toBeCloseTo(start + i * stepDuration(tempo), 9);
      expect(e.duration).toBeCloseTo(stepDuration(tempo));
    });
    expect(t.events.length).toBeGreaterThan(4 / stepDuration(tempo) - 3);
  });

  it.each([8, 16, 32])("counts steps 0..%i-1 and loops, calling onWrap once per loop", (length) => {
    const t = make({ length });
    run(t, 10);
    t.events.forEach((e, i) => expect(e.step).toBe(i % length));
    const loops = Math.floor((t.events.length - 1) / length);
    // onWrap fires when the next step after a full pattern is about to be scheduled.
    expect(t.wraps()).toBeGreaterThanOrEqual(loops);
    expect(t.wraps()).toBeLessThanOrEqual(loops + 1);
  });

  it("wraps at once when the pattern gets shorter than the playhead", () => {
    const t = make({ length: 32 });
    run(t, 2.0);
    const before = t.events.length;
    expect(t.events.at(-1)!.step).toBeGreaterThan(8);
    t.state.length = 8;
    run(t, 0.2);
    expect(t.events[before].step).toBe(0);
  });

  it("applies tempo changes to the steps after the change", () => {
    const t = make({ tempo: 120 });
    run(t, 1);
    t.state.tempo = 60;
    run(t, 2);
    const gaps = t.events.slice(1).map((e, i) => e.time - t.events[i].time);
    expect(gaps[0]).toBeCloseTo(0.125);
    expect(gaps.at(-1)).toBeCloseTo(0.25);
  });
});

describe("swing", () => {
  it("delays only off-beat steps", () => {
    const straight = make({ swing: 0 });
    const swung = make({ swing: 50 });
    run(straight, 3);
    run(swung, 3);
    const n = Math.min(straight.events.length, swung.events.length);
    for (let i = 0; i < n; i++) {
      const diff = swung.events[i].time - straight.events[i].time;
      if (i % 2 === 0) expect(diff).toBeCloseTo(0, 9);
      else expect(diff).toBeCloseTo(0.5 * stepDuration(120), 9);
    }
  });
  it("keeps steps in order at maximum swing", () => {
    const t = make({ swing: 75, tempo: 90 });
    run(t, 6);
    for (let i = 1; i < t.events.length; i++) expect(t.events[i].time).toBeGreaterThan(t.events[i - 1].time);
  });
  it("swings by pattern position, so 8 and 32 step patterns swing the same way", () => {
    for (const length of [8, 32]) {
      const t = make({ swing: 60, length });
      run(t, 6);
      t.events.forEach((e) => {
        const grid = t.events[0].time + e.index * stepDuration(120);
        expect(e.time - grid).toBeCloseTo(e.step % 2 === 1 ? 0.6 * stepDuration(120) : 0, 9);
      });
    }
  });
});

describe("lookahead window", () => {
  it.each([
    [60, 0],
    [120, 0],
    [120, 55],
    [200, 75],
  ])("only schedules inside [now, now + lookahead) at %i BPM, swing %i", (tempo, swing) => {
    const clock = { currentTime: 0 };
    const seen: Array<{ time: number; now: number }> = [];
    const s = new Scheduler({
      clock,
      getTempo: () => tempo,
      getSwing: () => swing,
      getLength: () => 16,
      onStep: (e) => seen.push({ time: e.time, now: clock.currentTime }),
      timer: new FakeTimer(),
    });
    s.start();
    for (let i = 0; i < 800; i++) {
      clock.currentTime += 0.025;
      s.tick();
    }
    expect(seen.length).toBeGreaterThan(50);
    for (const { time, now } of seen) {
      expect(time).toBeLessThan(now + s.lookahead);
      expect(time).toBeGreaterThanOrEqual(now - 1e-9 - 0.0001);
    }
  });

  it("schedules nothing more when called again with the same clock time", () => {
    const t = make();
    t.s.start();
    const n = t.events.length;
    expect(t.s.tick()).toBe(0);
    expect(t.events.length).toBe(n);
  });

  it("schedules each step exactly once across many ticks", () => {
    const t = make();
    run(t, 5);
    const times = t.events.map((e) => e.time);
    expect(new Set(times).size).toBe(times.length);
  });

  it("skips ahead instead of bursting when the timer was starved", () => {
    const t = make();
    run(t, 1);
    const before = t.events.length;
    t.clock.currentTime += 30; // a backgrounded tab slept for 30 s
    t.s.tick();
    expect(t.s.resyncs).toBe(1);
    const fresh = t.events.slice(before);
    expect(fresh.length).toBeLessThan(4);
    for (const e of fresh) expect(e.time).toBeGreaterThanOrEqual(t.clock.currentTime);
  });
});

describe("start and stop", () => {
  it("arms a timer, re-arms it on each wake-up, and stops cleanly", () => {
    const t = make();
    expect(t.s.isRunning).toBe(false);
    t.s.start();
    expect(t.s.isRunning).toBe(true);
    expect(t.timer.pending).toHaveLength(1);
    expect(t.timer.pending[0].ms).toBe(25);
    t.clock.currentTime = 0.5;
    t.timer.fire();
    expect(t.timer.pending).toHaveLength(1);
    expect(t.events.some((e) => e.time > 0.4)).toBe(true);
    t.s.stop();
    expect(t.s.isRunning).toBe(false);
    expect(t.timer.pending).toHaveLength(0);
  });
  it("ignores a second start() and a late timer callback after stop()", () => {
    const t = make();
    t.s.start();
    const count = t.events.length;
    t.s.start();
    expect(t.events.length).toBe(count);
    const cb = t.timer.pending[0].fn;
    t.s.stop();
    t.clock.currentTime = 5;
    cb();
    expect(t.events.length).toBe(count);
    expect(t.timer.pending).toHaveLength(0);
  });
  it("restarts from step 0", () => {
    const t = make();
    run(t, 1);
    t.s.stop();
    t.events.length = 0;
    t.s.start();
    expect(t.events[0].step).toBe(0);
    expect(t.events[0].index).toBe(0);
    expect(t.s.position).toBe(t.events.length % 16);
  });
  it("stop() before any timer is armed is harmless", () => {
    make().s.stop();
  });
  it("uses the real timers by default", async () => {
    const clock = { currentTime: 0 };
    let ticks = 0;
    const s = new Scheduler({ clock, getTempo: () => 120, getSwing: () => 0, getLength: () => 16, onStep: () => ticks++, interval: 5 });
    s.start();
    const first = ticks;
    clock.currentTime = 0.5;
    await new Promise((r) => setTimeout(r, 40));
    s.stop();
    expect(ticks).toBeGreaterThan(first);
  });
});
