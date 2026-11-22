import { db, now, type BotRecord, type ProactivityRecord, type TaskRecord } from './db.js';
import type { Trigger } from './agent/turns.js';
import { env } from './env.js';
import type { CheckinSettings } from './types.js';

/**
 * Check-ins: at the local times set for a workspace (in its settings in the app, or by its primary bot
 * with the set_checkins tool), the workspace's primary bot gets a [check-in] turn and either sends ONE
 * concise message or stays silent. Each workspace has its own times, and a check-in looks only at its
 * own workspace: its bots, approvals, routines and task board.
 */

/** Check-in times a workspace may have in a day. */
export const MAX_CHECKIN_TIMES = 6;
/** A check-in waits while the user is talking to the workspace's bots, until this long after their last message. */
const QUIET_MS = 20 * 60_000;

let enqueueFn: ((botId: string, t: Trigger) => void) | null = null;

export function initProactive(enqueue: (botId: string, t: Trigger) => void) {
  enqueueFn = enqueue;
  setInterval(tick, 60_000).unref();
  console.log(`[proactive] ${db.prepare<[], { n: number }>('SELECT COUNT(*) n FROM proactivity WHERE enabled=1').get()!.n} workspace(s) with check-ins`);
}

export function getCheckins(workspaceId: string): CheckinSettings {
  const r = db.prepare<[string], ProactivityRecord>('SELECT * FROM proactivity WHERE workspace_id=?').get(workspaceId);
  return r ? { enabled: !!r.enabled, times: JSON.parse(r.times) as string[], timezone: r.timezone } : { enabled: false, times: ['09:00', '16:30'], timezone: env.timeZone };
}

/** Change a workspace's check-ins. Bad times are dropped; a bad time zone throws. */
export function setCheckins(workspaceId: string, p: { enabled?: boolean; times?: string[]; timezone?: string }): CheckinSettings {
  const cur = getCheckins(workspaceId);
  const times = [...new Set((p.times ?? cur.times).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, MAX_CHECKIN_TIMES);
  const tz = p.timezone ?? cur.timezone;
  new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on a bad zone
  db.prepare(`INSERT INTO proactivity(workspace_id,enabled,times,timezone,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled, times=excluded.times, timezone=excluded.timezone, updated_at=excluded.updated_at`)
    .run(workspaceId, (p.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(times), tz, now());
  return getCheckins(workspaceId);
}

function localParts(tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

function tick() {
  if (!enqueueFn) return;
  const rows = db.prepare<[], ProactivityRecord>('SELECT * FROM proactivity WHERE enabled=1').all();
  for (const r of rows) {
    try {
      const { date, hm } = localParts(r.timezone);
      const times: string[] = JSON.parse(r.times);
      const slot = times.find((t) => minutesBetween(t, hm) >= 0 && minutesBetween(t, hm) < 5);
      if (!slot) continue;
      const key = `${date} ${slot}`;
      if (r.last_fired === key) continue;
      db.prepare('UPDATE proactivity SET last_fired=? WHERE workspace_id=?').run(key, r.workspace_id);
      fireCheckin(r.workspace_id);
    } catch (e) {
      console.warn('[proactive] tick failed for', r.workspace_id, (e as Error).message);
    }
  }
}

const minutesBetween = (from: string, to: string) => {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the check-in is told of the workspace's board: what is stuck and what nobody has. Empty when the board is off. */
function boardSummary(workspaceId: string): string {
  if (!db.prepare<[string], { task_board: number }>('SELECT task_board FROM workspaces WHERE id=?').get(workspaceId)?.task_board) return '';
  const open = db.prepare<[string], TaskRecord & { owner_name: string | null }>(
    "SELECT t.*, b.name owner_name FROM tasks t LEFT JOIN bots b ON b.id=t.owner_id WHERE t.workspace_id=? AND t.status<>'done' ORDER BY t.updated_at DESC",
  ).all(workspaceId);
  if (!open.length) return 'The task board has no open tasks.';
  const line = (t: (typeof open)[number]) => `"${clip(t.title, 80)}"${t.owner_name ? ` (${t.owner_name})` : ''}`;
  const blocked = open.filter((t) => t.status === 'blocked');
  const nobody = open.filter((t) => !t.owner_id);
  return [
    `The task board has ${open.length} open task(s).`,
    blocked.length ? `Blocked: ${blocked.slice(0, 8).map(line).join('; ')}` : '',
    nobody.length ? `Nobody has: ${nobody.slice(0, 8).map(line).join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * The workspace's primary bot checks in now. Skipped while the user is talking to the workspace's bots,
 * unless `force` (the "Check in now" button). Returns whether a check-in turn was queued.
 */
export function fireCheckin(workspaceId: string, force = false): boolean {
  const primary = db.prepare<[string], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE workspace_id=? AND is_primary=1 AND kind<>'room'").get(workspaceId);
  if (!primary || !enqueueFn) return false;
  // Don't interrupt an active conversation.
  const lastUser = db.prepare<[string], { t: number | null }>("SELECT MAX(created_at) t FROM rows WHERE bot_id IN (SELECT id FROM bots WHERE workspace_id=?) AND kind='message' AND json_extract(body,'$.role')='user'").get(workspaceId);
  if (!force && lastUser?.t && now() - lastUser.t < QUIET_MS) return false;

  const since = now() - 12 * 3600_000;
  const routineRuns = db.prepare<[string, number], { bot: string; name: string }>('SELECT b.name bot, r.name FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.workspace_id=? AND r.last_run_at > ?').all(workspaceId, since);
  const pendingApprovals = db.prepare<[string], { bot: string; tool: string }>("SELECT b.name bot, a.tool FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE b.workspace_id=? AND a.status='pending'").all(workspaceId);
  const otherBots = db.prepare<[string], { name: string; label: string }>("SELECT name, label FROM bots WHERE workspace_id=? AND is_primary=0 AND kind<>'room'").all(workspaceId);

  const context = [
    pendingApprovals.length ? `Pending approvals: ${pendingApprovals.map((a) => `${a.bot}: ${a.tool}`).join('; ')}` : 'No pending approvals.',
    routineRuns.length ? `Routines that ran in the last 12h: ${routineRuns.map((r) => `${r.name} (${r.bot})`).join('; ')}` : 'No routines ran in the last 12h.',
    otherBots.length ? `Team: ${otherBots.map((b) => `${b.name}${b.label ? ` (${b.label})` : ''}`).join(', ')}` : '',
    boardSummary(workspaceId),
  ].filter(Boolean).join('\n');

  enqueueFn(primary.id, {
    type: 'system',
    text:
      `[check-in] Scheduled proactive check-in. Look at what's going on: read your memories, use your browser or web search if it helps, and check on other Bots if needed. ` +
      `If there is something genuinely useful to tell the user (a decision they owe, something that changed, today's schedule, a finished result, work that is stuck), send ONE short message. ` +
      `If not, call stay_silent and send nothing.\n${context}`,
  });
  return true;
}
