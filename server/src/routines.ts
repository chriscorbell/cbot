import { Cron } from 'croner';
import { db, now, type RoutineRecord } from './db.js';
import type { Trigger } from './agent/turns.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { errorText } from './lib/errors.js';
import { runPrecheck, verdict, type Verdict } from './precheck.js';
import { getBotRow } from './store.js';
import type { Routine } from './types.js';

const jobs = new Map<string, Cron>();
let enqueueFn: ((botId: string, t: Trigger) => boolean) | null = null;
let queuedFn: ((botId: string, routineId: string) => boolean) | null = null;
/** Routines whose precheck is running now, so a schedule that fires again meanwhile doesn't start a second one. */
const checking = new Set<string>();

const getRecord = db.prepare<[string], RoutineRecord>('SELECT * FROM routines WHERE id=?');

/**
 * `enqueue` is the turn runner's: it answers false for a routine whose last run is still going or
 * waiting. `queued` asks the same without queuing anything, before a precheck runs.
 */
export function initRoutines(enqueue: (botId: string, t: Trigger) => boolean, queued: (botId: string, routineId: string) => boolean) {
  enqueueFn = enqueue;
  queuedFn = queued;
  const all = db.prepare<[], RoutineRecord>('SELECT * FROM routines WHERE enabled=1').all();
  for (const r of all) scheduleRoutine({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone });
  console.log(`[routines] scheduled ${jobs.size}`);
}

export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  unscheduleRoutine(r.id);
  try {
    const job = new Cron(r.schedule, { timezone: r.timezone || env.timeZone, protect: true }, () => {
      runRoutine(r.id).then(
        (o) => { if (o === 'busy') console.log(`[routines] ${r.id} skipped a run: the last one is still going`); },
        (e: unknown) => console.warn(`[routines] ${r.id} failed to run: ${errorText(e)}`),
      );
    });
    jobs.set(r.id, job);
  } catch (e) {
    console.warn('[routines] bad schedule', r.id, r.schedule, (e as Error).message);
  }
}

/** Schedule the routine if it is enabled, else make sure it is not scheduled. Call after every change to one. */
export function applySchedule(r: Routine) {
  if (r.enabled) scheduleRoutine(r);
  else unscheduleRoutine(r.id);
}

export function unscheduleRoutine(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

/**
 * What became of a run: queued as a turn; 'busy' when its last run is still going or waiting, or its
 * precheck is still running; 'off' when this server runs no routines (DISPATCH_NO_SCHEDULER=1) or it's
 * gone; or skipped by its precheck, with the reason (null when the precheck found nothing to do).
 */
export type RunOutcome = 'queued' | 'busy' | 'off' | { skipped: string | null };

/**
 * Start a run of the routine, on its schedule or from "Run now". A routine that fires faster than it
 * finishes skips a run instead of stacking turns ahead of the user's messages. A routine with a
 * precheck (precheck.ts) runs it first, and runs only when it printed something, which is added to
 * the prompt; otherwise the run is skipped without a model call and recorded on the routine, which the
 * app shows. A precheck isn't run while the last run is still going, so what it reports isn't lost.
 */
export async function runRoutine(id: string): Promise<RunOutcome> {
  const r = getRecord.get(id);
  if (!r || !enqueueFn || !queuedFn) return 'off';
  if (!r.precheck) return start(r, r.prompt);
  if (checking.has(id) || queuedFn(r.bot_id, id)) return 'busy';
  checking.add(id);
  let v: Verdict;
  try {
    v = verdict(await runPrecheck(r.bot_id, r.precheck));
  } finally {
    checking.delete(id);
  }
  // It may have been deleted, or its prompt changed, while the precheck ran.
  const cur = getRecord.get(id);
  if (!cur) return 'off';
  if (!v.run) {
    db.prepare('UPDATE routines SET last_skipped_at=?, last_skip_reason=? WHERE id=?').run(now(), v.reason, id);
    if (v.reason) console.warn(`[routines] ${id}'s precheck ${v.reason}`);
    changed(cur);
    return { skipped: v.reason };
  }
  const o = start(cur, `${cur.prompt}\n\n[Its precheck printed this:]\n${v.output}`);
  if (o === 'queued') changed(cur);
  return o;
}

function start(r: RoutineRecord, prompt: string): 'queued' | 'busy' | 'off' {
  if (!enqueueFn) return 'off';
  if (!enqueueFn(r.bot_id, { type: 'routine', routineId: r.id, name: r.name, prompt })) return 'busy';
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), r.id);
  return 'queued';
}

/** The app shows whether a routine with a precheck last ran or was skipped, and why. */
function changed(r: RoutineRecord) {
  const bot = getBotRow(r.bot_id);
  if (bot) hub.emit(bot.user_id, { type: 'routines', botId: r.bot_id });
}
