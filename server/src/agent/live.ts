import { hub } from '../lib/hub.js';
import { now } from '../db.js';
import { getBotRow, listBots } from '../store.js';
import type { ActivityKind, LiveState } from '../types.js';

/**
 * What each bot is doing right now: the chat's status line, the rail's dot, the avatar's mood and
 * the call bar's activity. Kept in memory and sent to the user as a `live` event on every change.
 *
 *   idle ──turnStarted──► running ──turnEnded──► idle
 *                          │  ▲
 *                          └──┘ doing (what it works on now), caption (a line from its reasoning)
 *
 * LiveState's type allows only these two shapes. Only agent/turns.ts calls the transitions; changes
 * while a bot is idle are ignored, so a late event from a finished turn cannot make it look busy.
 */

const live = new Map<string, LiveState>();

const idle = (botId: string): LiveState => ({ botId, isRunning: false, activity: null, startedAt: null, caption: null });

export const getLive = (botId: string): LiveState => live.get(botId) ?? idle(botId);

export const allLive = (userId: string) => listBots(userId).map((b) => getLive(b.id));

function put(state: LiveState) {
  const b = getBotRow(state.botId);
  // A turn of a deleted bot ending.
  if (!b) { live.delete(state.botId); return; }
  live.set(state.botId, state);
  hub.emit(b.user_id, { type: 'live', state });
}

export function turnStarted(botId: string) {
  put({ botId, isRunning: true, activity: { kind: 'thinking', since: now() }, startedAt: now(), caption: null });
}

/**
 * The running turn moved on to something else. `clearCaption` when the old caption no longer fits;
 * `unlessAlready` keeps the activity (and its `since`) when it is already this kind.
 */
export function doing(botId: string, kind: ActivityKind, opts: { detail?: string; clearCaption?: boolean; unlessAlready?: boolean } = {}) {
  const cur = getLive(botId);
  if (!cur.isRunning || (opts.unlessAlready && cur.activity.kind === kind)) return;
  put({ ...cur, activity: { kind, ...(opts.detail ? { detail: opts.detail } : {}), since: now() }, ...(opts.clearCaption ? { caption: null } : {}) });
}

/** A new line for the status line, next to "Thinking". */
export function caption(botId: string, text: string) {
  const cur = getLive(botId);
  if (!cur.isRunning || cur.caption === text) return;
  put({ ...cur, caption: text });
}

export function turnEnded(botId: string) {
  put(idle(botId));
}
