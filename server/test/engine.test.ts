import { expect, test } from 'vitest';
import { runSlot } from '../src/engine.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a gateway's first run goes alone until Hermes has begun answering it", async () => {
  const first = await runSlot('bot-a');
  let second: ((event?: unknown) => void) | null = null;
  void runSlot('bot-a').then((s) => { second = s; });
  await tick();
  expect(second).toBeNull();

  // Hermes sends these before it builds the agent: the second run still waits.
  first('run.started'); first('message.started');
  await tick();
  expect(second).toBeNull();

  first('message.delta');
  await tick();
  expect(second).not.toBeNull();
  // Answered once: later runs start at once.
  let third = false;
  void runSlot('bot-a').then(() => { third = true; });
  await tick();
  expect(third).toBe(true);
});

test('a first run that ends without answering hands the turn to the next run', async () => {
  const first = await runSlot('bot-b');
  const order: string[] = [];
  const second = runSlot('bot-b').then((s) => { order.push('second'); return s; });
  const third = runSlot('bot-b').then((s) => { order.push('third'); return s; });
  first();
  const s2 = await second;
  await tick();
  // The second is now the first run, so the third waits for it.
  expect(order).toEqual(['second']);
  s2('run.completed');
  await third;
  expect(order).toEqual(['second', 'third']);
});
