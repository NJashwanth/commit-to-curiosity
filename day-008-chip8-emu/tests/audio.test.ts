import { describe, expect, it, vi } from "vitest";
import { Beeper } from "../src/audio";

/** Just enough of the Web Audio API to watch what the beeper does. */
function fakeAudio(state: AudioContextState = "running") {
  const setTargetAtTime = vi.fn();
  const resume = vi.fn(async () => {});
  const start = vi.fn();
  const gainNode = { gain: { value: 1, setTargetAtTime }, connect: vi.fn((dest) => dest) };
  const ctx = {
    state,
    currentTime: 1.5,
    destination: {},
    resume,
    createOscillator: () => ({
      type: "",
      frequency: { value: 0 },
      connect: vi.fn(() => gainNode),
      start,
    }),
    createGain: () => gainNode,
  };
  return { ctx: ctx as unknown as AudioContext, setTargetAtTime, resume, start, gainNode };
}

describe("Beeper", () => {
  it("stays silent until unlocked", () => {
    const audio = fakeAudio();
    const factory = vi.fn(() => audio.ctx);
    const beeper = new Beeper(factory);
    beeper.set(true);
    expect(factory).not.toHaveBeenCalled();
    expect(beeper.isPlaying).toBe(false);
  });

  it("creates one running oscillator, muted by default gain", () => {
    const audio = fakeAudio();
    const factory = vi.fn(() => audio.ctx);
    const beeper = new Beeper(factory);
    beeper.unlock();
    beeper.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(audio.gainNode.gain.value).toBe(0);
  });

  it("ramps the gain up while active and down when not", () => {
    const audio = fakeAudio();
    const beeper = new Beeper(() => audio.ctx);
    beeper.unlock();
    beeper.set(true);
    beeper.set(true);
    expect(audio.setTargetAtTime).toHaveBeenCalledTimes(1);
    expect(audio.setTargetAtTime.mock.calls[0][0]).toBeGreaterThan(0);
    expect(beeper.isPlaying).toBe(true);
    beeper.set(false);
    expect(audio.setTargetAtTime).toHaveBeenLastCalledWith(0, 1.5, expect.any(Number));
    expect(beeper.isPlaying).toBe(false);
  });

  it("stays quiet when muted", () => {
    const audio = fakeAudio();
    const beeper = new Beeper(() => audio.ctx);
    beeper.unlock();
    beeper.muted = true;
    beeper.set(true);
    expect(beeper.isPlaying).toBe(false);
    expect(audio.setTargetAtTime).not.toHaveBeenCalled();
  });

  it("resumes a suspended context on the next gesture", () => {
    const audio = fakeAudio("suspended");
    const beeper = new Beeper(() => audio.ctx);
    beeper.unlock();
    beeper.unlock();
    expect(audio.resume).toHaveBeenCalledTimes(1);
  });

  it("runs silently when Web Audio is unavailable", () => {
    const beeper = new Beeper(() => {
      throw new Error("no audio");
    });
    expect(() => beeper.unlock()).not.toThrow();
    beeper.set(true);
    expect(beeper.isPlaying).toBe(false);
  });
});
