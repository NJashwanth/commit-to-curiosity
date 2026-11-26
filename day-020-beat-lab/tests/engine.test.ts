import { describe, expect, it, vi } from "vitest";
import { AudioApp, BeatEngine, GATE_RATIO, Player, type PlayheadEvent } from "../src/engine";
import { Sequencer } from "../src/sequencer";
import { SYNTH_TRACK, createDefaultState } from "../src/state";
import { adsrFromKnobs } from "../src/synth";
import { FakeTimer, MockBufferSource, MockContext, MockDelay, MockGain, MockOscillator, asCtx } from "./mock-audio";

const seqWith = (edit?: (q: Sequencer) => void) => {
  const q = new Sequencer(createDefaultState());
  edit?.(q);
  return q;
};

describe("BeatEngine", () => {
  it("plays drum events with the track's own parameters", () => {
    const ctx = new MockContext();
    const q = seqWith((s) => s.setDrumParam(0, "tune", 100));
    const engine = new BeatEngine(asCtx(ctx), q);
    engine.trigger({ track: 0, drum: "kick", gain: 1, accent: false }, 2, 0.125);
    const kick = ctx.all<MockOscillator>("oscillator")[0];
    expect(kick.startedAt).toBe(2);
    expect(kick.frequency.of("exp")[0].value).toBeCloseTo(100); // tune 100 = +1 octave over 50 Hz
  });

  it("plays synth events for 90% of a step with the synth settings", () => {
    const ctx = new MockContext();
    const q = seqWith((s) => {
      s.setSynthParam("wave", 1);
      s.setSynthParam("release", 0);
    });
    const engine = new BeatEngine(asCtx(ctx), q);
    engine.trigger({ track: SYNTH_TRACK, note: 57, gain: 1, accent: false }, 1, 0.2);
    const osc = ctx.all<MockOscillator>("oscillator")[0];
    expect(osc.type).toBe("square");
    const amp = ctx.all<MockGain>("gain").find((g) => g.gain.of("linear").length > 0)!;
    const end = amp.gain.of("linear").at(-1)!;
    expect(end.time).toBeCloseTo(1 + 0.2 * GATE_RATIO + adsrFromKnobs(q.state.synth).release);
  });

  it("ignores an event with neither a drum nor a note", () => {
    const ctx = new MockContext();
    const engine = new BeatEngine(asCtx(ctx), seqWith());
    const before = ctx.nodes.length;
    engine.trigger({ track: 0, gain: 1, accent: false }, 0, 0.1);
    expect(ctx.nodes.length).toBe(before);
  });

  it("updates the effects when the beat changes, until disposed", () => {
    const ctx = new MockContext();
    const q = seqWith();
    const engine = new BeatEngine(asCtx(ctx), q);
    const delay = ctx.all<MockDelay>("delay")[0];
    q.setTempo(60);
    expect(delay.delayTime.of("target").at(-1)!.value).toBeCloseTo((60 / 60) * 0.75);
    engine.dispose();
    const n = delay.delayTime.events.length;
    q.setTempo(120);
    expect(delay.delayTime.events.length).toBe(n);
  });
});

describe("Player", () => {
  const rig = (edit?: (q: Sequencer) => void) => {
    const ctx = new MockContext();
    const q = seqWith(edit);
    const timer = new FakeTimer();
    const engine = new BeatEngine(asCtx(ctx), q);
    const player = new Player(ctx, q, engine, timer);
    const heads: PlayheadEvent[] = [];
    player.onPlayhead((e) => heads.push(e));
    const advance = (to: number) => {
      while (ctx.currentTime < to) {
        ctx.currentTime += 0.025;
        timer.fire();
      }
    };
    return { ctx, q, timer, engine, player, heads, advance };
  };

  it("plays the pattern in time: kicks land on the downbeats", () => {
    const { ctx, player, advance, heads } = rig((q) => {
      q.toggleStep(0, 0);
      q.toggleStep(0, 4);
    });
    player.start();
    advance(2.7);
    const kicks = ctx.all<MockOscillator>("oscillator").map((o) => o.startedAt!);
    const step = 60 / 100 / 4;
    expect(kicks[0]).toBeCloseTo(0.06);
    expect(kicks[1]).toBeCloseTo(0.06 + 4 * step);
    expect(kicks[2]).toBeCloseTo(0.06 + 16 * step);
    expect(heads.slice(0, 5).map((h) => h.step)).toEqual([0, 1, 2, 3, 4]);
    expect(player.isPlaying).toBe(true);
  });

  it("walks a chain: each loop plays the next pattern", () => {
    const { q, player, advance, heads } = rig((q) => {
      q.setLength(8, 0);
      q.setLength(8, 1);
      q.setChain([0, 1]);
      q.setChainMode(true);
    });
    player.start();
    advance(5.0);
    const patterns = heads.filter((h) => h.step === 0).map((h) => h.pattern);
    expect(patterns.slice(0, 5)).toEqual([0, 1, 0, 1, 0]);
    expect(q.state.chain).toEqual([0, 1]);
  });

  it("stops scheduling after stop() and start() is idempotent", () => {
    const { player, advance, heads, timer } = rig();
    player.start();
    player.start();
    advance(0.5);
    player.stop();
    const n = heads.length;
    expect(player.isPlaying).toBe(false);
    advance(2);
    expect(heads.length).toBe(n);
    expect(timer.pending).toHaveLength(0);
  });

  it("unsubscribes playhead listeners", () => {
    const { ctx, q, player } = rig();
    const fn = vi.fn();
    const off = player.onPlayhead(fn);
    off();
    player.start();
    ctx.currentTime = 0.5;
    expect(q.state.tempo).toBe(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not play muted tracks", () => {
    const { ctx, player, advance } = rig((q) => {
      q.toggleStep(0, 0);
      q.toggleMute(0);
    });
    player.start();
    advance(0.5);
    expect(ctx.all("oscillator")).toHaveLength(0);
  });
});

describe("AudioApp", () => {
  const make = (opts: { suspended?: boolean } = {}) => {
    const ctx = new MockContext();
    if (opts.suspended) {
      ctx.state = "suspended";
      ctx.resume = async () => {}; // the browser refuses
    }
    const timer = new FakeTimer();
    const create = vi.fn(() => ctx as unknown as AudioContext);
    const q = seqWith((s) => s.toggleStep(0, 0));
    const app = new AudioApp(q, { createContext: create, timer });
    return { ctx, app, create, timer, q };
  };

  it("is idle and silent until used", () => {
    const { app, create } = make();
    expect(app.playing).toBe(false);
    expect(app.currentTime).toBe(0);
    expect(app.latency).toBe(0);
    expect(app.analyser).toBeNull();
    expect(app.sampleRate).toBe(44100);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the context once, on first use, and starts playing", async () => {
    const { app, create, ctx } = make();
    expect(await app.play()).toBe(true);
    expect(await app.ensure()).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(app.playing).toBe(true);
    expect(app.analyser).not.toBeNull();
    ctx.currentTime = 1.5;
    expect(app.currentTime).toBe(1.5);
    expect(app.sampleRate).toBe(44100);
  });

  it("reports outputLatency when the browser has it", async () => {
    const { app, ctx } = make();
    await app.ensure();
    (ctx as unknown as { outputLatency: number }).outputLatency = 0.04;
    expect(app.latency).toBe(0.04);
  });

  it("toggles play and stop", async () => {
    const { app } = make();
    expect(await app.toggle()).toBe(true);
    expect(app.playing).toBe(true);
    expect(await app.toggle()).toBe(false);
    expect(app.playing).toBe(false);
    app.stop();
  });

  it("forwards playhead events from the player", async () => {
    const { app, ctx, timer } = make();
    const heads: PlayheadEvent[] = [];
    const off = app.onPlayhead((e) => heads.push(e));
    await app.play();
    ctx.currentTime = 0.3;
    timer.fire();
    expect(heads.length).toBeGreaterThan(2);
    off();
    const n = heads.length;
    ctx.currentTime = 0.6;
    timer.fire();
    expect(heads.length).toBe(n);
  });

  it("refuses to play when the browser will not start audio", async () => {
    const { app } = make({ suspended: true });
    expect(await app.play()).toBe(false);
    expect(app.playing).toBe(false);
  });

  it("auditions drums and the synth right away", async () => {
    const { app, ctx, q } = make();
    await app.audition(1);
    expect(ctx.all<MockBufferSource>("bufferSource").length).toBeGreaterThan(0);
    const oscsBefore = ctx.all("oscillator").length;
    q.setNote(3, 60);
    await app.audition(SYNTH_TRACK);
    expect(ctx.all("oscillator").length).toBe(oscsBefore + 1 + 0); // snare tone before, one synth voice after
    expect(ctx.all<MockOscillator>("oscillator").at(-1)!.frequency.of("set")[0].value).toBeCloseTo(261.63, 1);
  });

  it("auditions the default note when the synth row is empty, and does nothing if audio is blocked", async () => {
    const { app, ctx } = make();
    await app.audition(SYNTH_TRACK);
    expect(ctx.all<MockOscillator>("oscillator").at(-1)!.frequency.of("set")[0].value).toBeCloseTo(130.81, 1);
    const blocked = make({ suspended: true });
    await blocked.app.audition(0);
    expect(blocked.ctx.all("oscillator")).toHaveLength(0);
  });
});
