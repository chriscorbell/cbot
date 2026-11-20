import { Cron } from 'croner';
import { db, now, type RoutineRecord } from './db.js';
import type { Trigger } from './agent/turns.js';
import { env } from './env.js';
import type { Routine } from './types.js';

const jobs = new Map<string, Cron>();
let enqueueFn: ((botId: string, t: Trigger) => boolean) | null = null;

/** `enqueue` is the turn runner's: it answers false for a routine whose last run is still going or waiting. */
export function initRoutines(enqueue: (botId: string, t: Trigger) => boolean) {
  enqueueFn = enqueue;
  const all = db.prepare<[], RoutineRecord>('SELECT * FROM routines WHERE enabled=1').all();
  for (const r of all) scheduleRoutine({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone });
  console.log(`[routines] scheduled ${jobs.size}`);
}

export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  unscheduleRoutine(r.id);
  try {
    const job = new Cron(r.schedule, { timezone: r.timezone || env.timeZone, protect: true }, () => {
      if (runRoutine(r.id) === 'busy') console.log(`[routines] ${r.id} skipped a run: the last one is still going`);
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
 * Start a run of the routine, on its schedule or from "Run now". 'busy' when its last run is still going
 * or waiting: a routine that fires faster than it finishes skips a run instead of stacking turns ahead of
 * the user's messages. 'off' when this server runs no routines (CBOT_NO_SCHEDULER=1) or it's gone.
 */
export function runRoutine(id: string): 'queued' | 'busy' | 'off' {
  const r = db.prepare<[string], RoutineRecord>('SELECT * FROM routines WHERE id=?').get(id);
  if (!r || !enqueueFn) return 'off';
  if (!enqueueFn(r.bot_id, { type: 'routine', routineId: id, name: r.name, prompt: r.prompt })) return 'busy';
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), id);
  return 'queued';
}
