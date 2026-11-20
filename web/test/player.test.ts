import { expect, test } from 'vitest';
import { CallOutput, PcmPlayer } from '../src/voice/audio';

// Just enough Web Audio to see what the player schedules: sources record when, and from where, they start.
class Param { value = 1; setValueAtTime() { return this; } linearRampToValueAtTime() { return this; } }
interface Source { buffer: { duration: number } | null; started?: [number, number]; stopped: boolean; onended: (() => void) | null }
class Ctx {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: Source[] = [];
  createGain() { return { gain: new Param(), connect: (n: unknown) => n, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect: (n: unknown) => n, disconnect() {}, getFloatTimeDomainData() {} }; }
  createBuffer(_ch: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
  createBufferSource() {
    const s: Source & { connect: () => void; start: (at: number, offset?: number) => void; stop: () => void } = {
      buffer: null, stopped: false, onended: null,
      connect() {}, start(at, offset = 0) { s.started = [at, offset]; }, stop() { s.stopped = true; },
    };
    this.sources.push(s);
    return s;
  }
}

const second = () => new Int16Array(24000);
const starts = (list: Source[]) => list.map((s) => s.started?.map((t) => Math.round(t * 1000) / 1000));

test('a paused player keeps what it has not played, and plays on from the same point', async () => {
  const ctx = new Ctx();
  const player = new PcmPlayer(ctx as unknown as AudioContext);
  const log: string[] = [];
  player.onStart = () => log.push('start');
  player.onIdle = () => log.push('idle');
  player.push(second());
  player.push(second());
  expect(starts(ctx.sources)).toEqual([[0.06, 0], [1.06, 0]]);

  ctx.currentTime = 0.56;
  player.pause();
  expect(ctx.sources.every((s) => s.stopped)).toBe(true);
  expect(player.playing).toBe(false);
  expect(player.holding).toBe(true);
  player.push(second()); // arrives while paused: held behind the rest
  expect(ctx.sources).toHaveLength(2);
  let idle = false;
  void player.whenIdle().then(() => { idle = true; });

  ctx.currentTime = 5;
  player.resume();
  expect(starts(ctx.sources.slice(2))).toEqual([[5.06, 0.5], [5.56, 0], [6.56, 0]]);
  expect(log).toEqual(['start', 'idle', 'start']);
  for (const s of ctx.sources.slice(2)) s.onended?.();
  await Promise.resolve();
  expect(idle).toBe(true);
});

test('a paused player that is told to stop drops what it holds', () => {
  const ctx = new Ctx();
  const player = new PcmPlayer(ctx as unknown as AudioContext);
  player.push(second());
  player.pause();
  player.push(second());
  player.clear();
  expect(player.holding).toBe(false);
  player.resume();
  expect(ctx.sources).toHaveLength(1);
  player.push(second()); // the next reply plays at once
  expect(starts(ctx.sources.slice(1))).toEqual([[0.06, 0]]);
});

test('without WebRTC, a call plays straight from the context', async () => {
  const ctx = new Ctx();
  const output = new CallOutput(ctx as unknown as AudioContext);
  await output.start();
  expect(output.route).toBe('direct');
  output.dispose();
});
