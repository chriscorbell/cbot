import { expect, test } from 'vitest';
import { EchoLog } from '../src/voice/echo-log';

const RATE = 48000;
const BLOCK = 1920;

/** Seconds of something speech-like: noise in syllable-length bursts. */
function speech(seconds: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    lp = lp * 0.9 + rnd() * 0.1;
    out[i] = lp * Math.sin((Math.PI * i) / (0.2 * RATE)) ** 2 * 1.2;
  }
  return out;
}

function feed(log: EchoLog, heard: Float32Array, played: Float32Array, gapsAt: (block: number) => number = () => 0) {
  for (let i = 0, b = 0; i + BLOCK <= heard.length; i += BLOCK, b++) {
    const h = heard.subarray(i, i + BLOCK);
    log.add(h, played.subarray(i, i + BLOCK), h.subarray(0, BLOCK / 2).map((x) => x * 0.01), gapsAt(b));
  }
}

test('each second the bot is audible, and the one after, logs levels and the echo delay', () => {
  // Three seconds of the bot, two of silence; the microphone hears it 84 ms late at a third.
  const played = new Float32Array(5 * RATE);
  played.set(speech(3, 7));
  const delay = Math.round(0.084 * RATE);
  const heard = new Float32Array(played.length);
  for (let i = delay; i < heard.length; i++) heard[i] = played[i - delay] * 0.33;
  const log = new EchoLog(RATE, () => 42);
  feed(log, heard, played, (b) => (b === 30 ? 2 : 0));
  expect(log.seconds.map((s) => s[0])).toEqual([0, 1, 2, 3]);
  for (const [, p, h, c, d] of log.seconds.slice(1, 3)) {
    expect(h - p).toBeGreaterThanOrEqual(-11); // -9.6 dB
    expect(h - p).toBeLessThanOrEqual(-9);
    expect(c - h).toBeLessThan(-30);
    expect(d).toBeGreaterThanOrEqual(83);
    expect(d).toBeLessThanOrEqual(85);
  }
  expect(log.seconds.map((s) => s[5])).toEqual([0, 2, 0, 0]); // block 30 is 1.2 s in
  expect(log.seconds[0][6]).toBe(42);
  expect(log.seconds[3][4]).toBeNull(); // the bot was silent: no delay to find
});

test('a microphone that hears nothing of the bot has no delay', () => {
  const played = speech(2, 3);
  const log = new EchoLog(RATE, () => null);
  let s = 99;
  const noise = played.map(() => (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1) * 0.01); // a fan, say
  feed(log, noise, played);
  expect(log.seconds.map((s) => s[4])).toEqual([null, null]);
  expect(log.seconds[1][6]).toBeNull();
});
