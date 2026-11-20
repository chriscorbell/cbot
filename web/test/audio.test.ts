import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// A stand-in for Web Audio that, like Firefox, refuses a microphone in a context at another rate.
class FakeCtx {
  static made: FakeCtx[] = [];
  static accepts = 44100;
  sampleRate: number;
  closed = false;
  resumed = 0;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  constructor(o?: { sampleRate?: number }) { this.sampleRate = o?.sampleRate ?? 48000; FakeCtx.made.push(this); }
  createMediaStreamSource() {
    if (this.sampleRate !== FakeCtx.accepts) throw Object.assign(new Error('Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported.'), { name: 'NotSupportedError' });
    return { connect: (n: unknown) => n, disconnect() {} };
  }
  createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n, disconnect() {} }; }
  resume() { this.resumed++; return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}
let nodes: { port: { onmessage: ((e: { data: { pcm: ArrayBuffer; level: number } }) => void) | null } }[] = [];
class FakeWorkletNode {
  port = { onmessage: null as ((e: { data: { pcm: ArrayBuffer; level: number } }) => void) | null };
  constructor() { nodes.push(this); }
  connect(n: unknown) { return n; }
  disconnect() {}
}

beforeEach(() => {
  FakeCtx.made = []; FakeCtx.accepts = 44100; nodes = [];
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const { captureContext, MicCapture } = await import('../src/voice/audio');

const stream = (rate?: number) => {
  const track = { getSettings: () => (rate ? { sampleRate: rate } : {}), enabled: true, stop() {} };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
};
const frame = () => ({ data: { pcm: new Int16Array(960).buffer, level: 0.1 } });

test('a microphone Firefox refuses at one rate gets a capture context at a rate it accepts', async () => {
  const found = await captureContext(stream());
  expect(found && (found.ctx as unknown as FakeCtx).sampleRate).toBe(44100);
  expect(FakeCtx.made.map((c) => [c.sampleRate, c.closed])).toEqual([[48000, true], [44100, false]]);
});

test('the rate the track reports is tried first, and no rate at all gives up with every context closed', async () => {
  FakeCtx.accepts = 22050;
  expect(((await captureContext(stream(22050)))!.ctx as unknown as FakeCtx).sampleRate).toBe(22050);
  expect(FakeCtx.made).toHaveLength(1);
  FakeCtx.made = []; FakeCtx.accepts = 8000;
  expect(await captureContext(stream())).toBeNull();
  expect(FakeCtx.made.every((c) => c.closed)).toBe(true);
});

test('a call whose context the microphone refuses captures in its own context, and closes it when done', async () => {
  const call = new FakeCtx({ sampleRate: 48000 });
  const got: Int16Array[] = [];
  const mic = new MicCapture(call as unknown as AudioContext, stream(), (pcm) => got.push(pcm));
  const started = mic.start();
  await vi.waitFor(() => expect(nodes[0]?.port.onmessage).toBeTruthy());
  nodes[0].port.onmessage!(frame());
  await started;
  expect(got).toHaveLength(1);
  const own = FakeCtx.made.find((c) => c !== call && !c.closed)!;
  expect(own.sampleRate).toBe(44100);
  mic.stop();
  expect(own.closed).toBe(true);
  expect(call.closed).toBe(false);
});

test('a microphone that sends nothing is woken once, then reported instead of a call that never hears', async () => {
  vi.useFakeTimers();
  FakeCtx.accepts = 48000;
  const call = new FakeCtx();
  const mic = new MicCapture(call as unknown as AudioContext, stream(), () => {});
  const started = mic.start();
  const failed = expect(started).rejects.toThrow('No sound is coming from your microphone');
  await vi.advanceTimersByTimeAsync(1500);
  expect(call.resumed).toBe(1);
  await vi.advanceTimersByTimeAsync(1500);
  await failed;
});
