import { expect, test } from 'vitest';
import { EchoGate, pcmLevel } from '../src/voice/echo';

/** A 40 ms frame of tone at an RMS level (full scale 1). */
const frame = (level: number) => {
  const pcm = new Int16Array(960);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 3) * level * Math.SQRT2 * 0x7fff);
  return pcm;
};
const silent = (pcm: Int16Array) => pcm.every((s) => s === 0);
/** The bot plays at 0.1 and a third of it reaches the microphone. */
const echoFor = (gate: EchoGate, frames: number, mic = 0.03) => {
  const out = [];
  for (let i = 0; i < frames; i++) out.push(gate.process(frame(mic), 0.1));
  return out;
};

test('with the bot silent, frames go out as they are', () => {
  const gate = new EchoGate();
  const pcm = frame(0.02);
  expect(gate.process(pcm, 0)).toBe(pcm);
  expect(gate.frames).toBe(0);
});

test('the bot heard back is held back, once the gate has learned how loud it is', () => {
  const gate = new EchoGate();
  const sent = echoFor(gate, 100);
  expect(gate.coupling).toBeCloseTo(0.3, 2);
  // The first second only teaches it.
  expect(sent.slice(0, 25).some(silent)).toBe(false);
  expect(sent.slice(25).every(silent)).toBe(true);
});

test('the user talking over the bot goes out, and the gate stays open a moment', () => {
  const gate = new EchoGate();
  echoFor(gate, 100);
  expect(silent(gate.process(frame(0.02), 0.1))).toBe(true); // quieter than the echo
  const loud = frame(0.2);
  expect(gate.process(loud, 0.1)).toBe(loud);
  const after = echoFor(gate, 13);
  expect(after.slice(0, 12).some(silent)).toBe(false);
  expect(silent(after[12])).toBe(true);
});

test('when the bot stops, its echo is held a little longer, then everything goes out', () => {
  const gate = new EchoGate();
  echoFor(gate, 100);
  const tail = Array.from({ length: 9 }, () => gate.process(frame(0.03), 0));
  expect(tail.slice(0, 7).every(silent)).toBe(true);
  expect(silent(tail[8])).toBe(false);
});

test('talking over the bot moves the estimate a little; the echo itself moves it all the way', () => {
  const gate = new EchoGate();
  echoFor(gate, 300);
  for (let i = 0; i < 8; i++) gate.process(frame(0.5), 0.1);
  expect(gate.coupling).toBeLessThan(0.36);
  // Louder speakers: the gate follows, though the echo was louder than its limit at first.
  echoFor(gate, 1000, 0.15);
  expect(gate.coupling).toBeGreaterThan(1.4);
});

test('pcmLevel is the RMS, full scale 1', () => {
  expect(pcmLevel(frame(0.25))).toBeCloseTo(0.25, 2);
  expect(pcmLevel(new Int16Array(0))).toBe(0);
});
