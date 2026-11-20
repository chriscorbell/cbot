import { beforeAll, expect, test } from 'vitest';
import { EchoCanceller, loadAec3 } from '../src/voice/aec';

// The real AEC3 WebAssembly, loaded as the page loads it.
let mod: Awaited<ReturnType<typeof loadAec3>>;
beforeAll(async () => {
  mod = await loadAec3();
});

const RATE = 48000;
const BLOCK = 1920; // 40 ms, as the capture worklet posts

/** Seconds of something speech-like: noise in syllable-length bursts. */
function speech(seconds: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    lp = lp * 0.9 + rnd() * 0.1; // a little lowpass
    const syllable = Math.sin((Math.PI * i) / (0.2 * RATE)) ** 2;
    out[i] = lp * syllable * 1.2;
  }
  return out;
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));

/** Runs the canceller over `heard` and `played` in capture blocks; returns its output at 24 kHz. */
function run(aec: EchoCanceller, heard: Float32Array, played: Float32Array): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i + BLOCK <= heard.length; i += BLOCK) parts.push(aec.process(heard.subarray(i, i + BLOCK), played.subarray(i, i + BLOCK)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

test('what the call plays, heard back 60 ms later, is cancelled', () => {
  const played = speech(6, 11);
  const delay = Math.round(0.06 * RATE);
  const heard = new Float32Array(played.length);
  for (let i = delay + 240; i < heard.length; i++) heard[i] = played[i - delay] * 0.4 + played[i - delay - 240] * 0.15;
  const aec = new EchoCanceller(mod, RATE);
  const out = run(aec, heard, played);
  expect(out.length).toBeGreaterThan(heard.length / 2 - 2400); // 24 kHz, less AEC3's 10 ms
  const tail = (a: Float32Array, rate: number) => a.subarray(Math.round(2 * rate));
  const removed = 20 * Math.log10(rms(tail(heard, RATE)) / rms(tail(out, 24000)));
  expect(removed).toBeGreaterThan(20);
  expect(aec.removedDb()).toBeGreaterThan(15);
  aec.free();
});

test('with nothing playing, the microphone passes through', () => {
  const heard = speech(3, 5);
  const aec = new EchoCanceller(mod, RATE);
  const out = run(aec, heard, new Float32Array(heard.length));
  const ratio = rms(out.subarray(24000)) / rms(heard.subarray(RATE));
  expect(ratio).toBeGreaterThan(0.7);
  expect(ratio).toBeLessThan(1.3);
  expect(aec.removedDb()).toBeNull();
  aec.free();
});

test('the context may run at 44.1 kHz', () => {
  const aec = new EchoCanceller(mod, 44100);
  const out = aec.process(new Float32Array(1764 * 3), new Float32Array(1764 * 3));
  expect(out.length).toBeGreaterThan(0);
  expect(out.length % 240).toBe(0);
  aec.free();
});
