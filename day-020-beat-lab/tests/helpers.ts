import { Rng } from "../src/audio-context";
import { DELAY_DIVISIONS, LENGTHS, NOTE_MAX, PATTERN_COUNT, createDefaultState, type BeatState } from "../src/state";

/** A valid but random beat, to stress the codec. Same seed, same beat. */
export function randomState(seed: number, density = 0.4): BeatState {
  const r = new Rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r.next() * (hi - lo + 1));
  const chance = (p: number) => r.next() < p;
  const s = createDefaultState();
  s.tempo = int(60, 200);
  s.swing = int(0, 75);
  s.current = int(0, PATTERN_COUNT - 1);
  s.chainMode = chance(0.5);
  s.chain = Array.from({ length: int(0, 8) }, () => int(0, PATTERN_COUNT - 1));
  for (const p of s.patterns) {
    p.length = LENGTHS[int(0, 2)];
    for (const row of p.drums) for (const st of row) if (chance(density)) Object.assign(st, { on: true, vel: int(1, 16), accent: chance(0.3) });
    for (const st of p.synth) if (chance(density)) Object.assign(st, { on: true, vel: int(1, 16), accent: chance(0.3), note: int(0, NOTE_MAX) });
  }
  for (const t of s.tracks) Object.assign(t, { tune: int(0, 100), decay: int(0, 100), level: int(0, 100), mute: chance(0.2), solo: chance(0.2) });
  Object.assign(s.synth, {
    wave: int(0, 3), attack: int(0, 100), decay: int(0, 100), sustain: int(0, 100), release: int(0, 100),
    cutoff: int(0, 100), resonance: int(0, 100), envAmt: int(0, 100), glide: int(0, 100), level: int(0, 100),
    mute: chance(0.2), solo: chance(0.2),
  });
  Object.assign(s.fx, {
    comp: int(0, 100), delayDiv: int(0, DELAY_DIVISIONS.length - 1), delayFb: int(0, 100), delayMix: int(0, 100),
    reverbSize: int(0, 100), reverbMix: int(0, 100), master: int(0, 100),
  });
  return s;
}

/** The biggest possible beat: every step of every pattern on, every knob at its maximum. */
export function fullState(): BeatState {
  const s = createDefaultState();
  for (const p of s.patterns) {
    p.length = 32;
    for (const row of p.drums) for (const st of row) Object.assign(st, { on: true, vel: 16, accent: true });
    for (const st of p.synth) Object.assign(st, { on: true, vel: 16, accent: true, note: 127 });
  }
  s.tempo = 200;
  s.swing = 75;
  s.chain = [3, 3, 3, 3, 3, 3, 3, 3];
  s.chainMode = true;
  s.current = 3;
  for (const t of s.tracks) Object.assign(t, { tune: 100, decay: 100, level: 100, mute: true, solo: true });
  Object.assign(s.synth, { wave: 3, attack: 100, decay: 100, sustain: 100, release: 100, cutoff: 100, resonance: 100, envAmt: 100, glide: 100, level: 100, mute: true, solo: true });
  Object.assign(s.fx, { comp: 100, delayDiv: 5, delayFb: 100, delayMix: 100, reverbSize: 100, reverbMix: 100, master: 100 });
  return s;
}
