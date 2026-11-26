// A small recording mock of the Web Audio API for Node tests. It implements
// only what Beat Lab touches, and keeps every automation event so tests can
// assert on exactly what was scheduled and when.

export interface ParamEvent {
  type: "set" | "linear" | "exp" | "target" | "cancel";
  time: number;
  value: number;
  timeConstant?: number;
}

export class MockParam {
  value: number;
  events: ParamEvent[] = [];
  constructor(public defaultValue = 0) {
    this.value = defaultValue;
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "set", time, value });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "linear", time, value });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "exp", time, value });
    return this;
  }
  setTargetAtTime(value: number, time: number, timeConstant: number) {
    this.events.push({ type: "target", time, value, timeConstant });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.events.push({ type: "cancel", time, value: 0 });
    return this;
  }
  /** Events of one type, in the order they were scheduled. */
  of(type: ParamEvent["type"]): ParamEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

export class MockNode {
  connections: unknown[] = [];
  constructor(public kind: string) {}
  connect<T>(dest: T): T {
    this.connections.push(dest);
    return dest;
  }
  disconnect() {
    this.connections = [];
  }
}

export class MockGain extends MockNode {
  gain = new MockParam(1);
  constructor() {
    super("gain");
  }
}

export class MockOscillator extends MockNode {
  type = "sine";
  frequency = new MockParam(440);
  detune = new MockParam(0);
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor() {
    super("oscillator");
  }
  start(t = 0) {
    this.startedAt = t;
  }
  stop(t = 0) {
    this.stoppedAt = t;
  }
}

export class MockBufferSource extends MockNode {
  buffer: MockBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new MockParam(1);
  startedAt: number | null = null;
  startOffset: number | null = null;
  stoppedAt: number | null = null;
  constructor() {
    super("bufferSource");
  }
  start(t = 0, offset = 0) {
    this.startedAt = t;
    this.startOffset = offset;
  }
  stop(t = 0) {
    this.stoppedAt = t;
  }
}

export class MockBiquad extends MockNode {
  type = "lowpass";
  frequency = new MockParam(350);
  Q = new MockParam(1);
  gain = new MockParam(0);
  detune = new MockParam(0);
  constructor() {
    super("biquad");
  }
}

export class MockCompressor extends MockNode {
  threshold = new MockParam(-24);
  knee = new MockParam(30);
  ratio = new MockParam(12);
  attack = new MockParam(0.003);
  release = new MockParam(0.25);
  reduction = 0;
  constructor() {
    super("compressor");
  }
}

export class MockDelay extends MockNode {
  delayTime = new MockParam(0);
  constructor(public maxDelayTime = 1) {
    super("delay");
  }
}

export class MockConvolver extends MockNode {
  buffer: MockBuffer | null = null;
  normalize = true;
  constructor() {
    super("convolver");
  }
}

export class MockAnalyser extends MockNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  minDecibels = -100;
  maxDecibels = -30;
  /** What getByteFrequencyData writes; tests replace this. */
  spectrum: (i: number, n: number) => number = () => 0;
  constructor() {
    super("analyser");
  }
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getByteFrequencyData(arr: Uint8Array) {
    for (let i = 0; i < arr.length; i++) arr[i] = this.spectrum(i, arr.length);
  }
}

export class MockBuffer {
  private data: Float32Array[];
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(ch: number) {
    return this.data[ch];
  }
}

export class MockContext {
  currentTime = 0;
  sampleRate = 44100;
  state: "suspended" | "running" | "closed" = "running";
  destination = new MockNode("destination");
  nodes: MockNode[] = [];
  resumeCalls = 0;

  private track<T extends MockNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return this.track(new MockGain());
  }
  createOscillator() {
    return this.track(new MockOscillator());
  }
  createBufferSource() {
    return this.track(new MockBufferSource());
  }
  createBiquadFilter() {
    return this.track(new MockBiquad());
  }
  createDynamicsCompressor() {
    return this.track(new MockCompressor());
  }
  createDelay(max = 1) {
    return this.track(new MockDelay(max));
  }
  createConvolver() {
    return this.track(new MockConvolver());
  }
  createAnalyser() {
    return this.track(new MockAnalyser());
  }
  createBuffer(channels: number, length: number, rate: number) {
    return new MockBuffer(channels, length, rate);
  }
  async resume() {
    this.resumeCalls++;
    this.state = "running";
  }
  /** All created nodes of one kind, typed. */
  all<T extends MockNode>(kind: string): T[] {
    return this.nodes.filter((n) => n.kind === kind) as T[];
  }
}

export const asCtx = (m: MockContext) => m as unknown as BaseAudioContext;
export const asNode = (m: MockNode) => m as unknown as AudioNode;
