import { beforeAll, expect, test } from 'vitest';
import * as live from '../src/agent/live.js';
import { hub } from '../src/lib/hub.js';
import type { LiveState } from '../src/types.js';
import { seedBot, seedOwner } from './helpers.js';

let userId: string;
beforeAll(() => { userId = seedOwner().id; });

test('a bot is idle until a turn starts, and idle again after it ends', () => {
  const bot = seedBot(userId);
  const sent: LiveState[] = [];
  const off = hub.subscribe(userId, (e) => { if (e.type === 'live') sent.push(e.state); });
  expect(live.getLive(bot.id)).toEqual({ botId: bot.id, isRunning: false, activity: null, startedAt: null, caption: null });
  live.turnStarted(bot.id);
  live.caption(bot.id, 'Looking it up.');
  live.doing(bot.id, 'searching_web', { clearCaption: true });
  expect(live.getLive(bot.id)).toMatchObject({ isRunning: true, activity: { kind: 'searching_web' }, caption: null });
  live.turnEnded(bot.id);
  off();
  expect(sent.map((s) => (s.isRunning ? s.activity.kind : 'idle'))).toEqual(['thinking', 'thinking', 'searching_web', 'idle']);
});

test('changes while idle are ignored, so a late event cannot make a bot look busy', () => {
  const bot = seedBot(userId);
  live.doing(bot.id, 'working');
  live.caption(bot.id, 'late');
  expect(live.getLive(bot.id).isRunning).toBe(false);
  expect(live.getLive(bot.id).caption).toBeNull();
});

test('"unlessAlready" keeps an activity and when it started', () => {
  const bot = seedBot(userId);
  live.turnStarted(bot.id);
  const before = live.getLive(bot.id);
  live.doing(bot.id, 'thinking', { unlessAlready: true });
  expect(live.getLive(bot.id)).toBe(before);
});
