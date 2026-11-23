import { z } from 'zod';
import { db, now, type RowRecord, type TurnRecord } from '../db.js';
import { appendRow, conversation, emitBot, getBotRow, requireBot, type Conversation } from '../store.js';
import { screenForWork } from '../computer.js';
import type { Engine } from '../engine.js';
import type { RowBody } from '../types.js';
import { instructionsFor } from './prompt.js';
import { markTold, sideNews } from './catchup.js';
import * as live from './live.js';
import { closeCutShort, TurnTranscript, type ToolClaim } from './transcript.js';
import { HermesRun, settleLeftoverRuns } from './runs.js';
import { markTeamSeen, teamNews } from './team.js';

/**
 * Turns: each one hands a message to the bot's Hermes gateway and streams the answer into the chat.
 * Hermes owns the agent loop, its history and its tools; this file decides when a turn runs.
 *
 * Every bot has a runner that runs one turn at a time:
 *
 *   idle ──enqueue──► running ──turn ends──► running (the next queued turn) or idle
 *
 *   interrupt  stops the running turn ("Stop"). Turns queued behind it still run.
 *   clear      stops the running turn and drops the queue ("New chat", bot deleted).
 *
 * A turn belongs to the conversation it was queued in. One whose conversation was cleared before it
 * started is skipped, and a running one writes only into its own conversation (store.ts Conversation),
 * so nothing of an old chat appears in a new one.
 *
 * The runners live in memory, and every turn queued or running is also a row in `turns` until it ends,
 * with its Hermes run once it has one. A restart (every deploy and update) starts from there
 * (resumeTurns): queued turns run again, and one that was running is closed off in its chat.
 *
 * The turn itself: make sure the bot's screen is ready (its browser tools point at it), then start a
 * Hermes run (agent/runs.ts) on the conversation's session and feed the run's events to a
 * TurnTranscript (transcript.ts). Stop asks Hermes to stop the run, which a dropped connection alone
 * would not. When Hermes asks before an action, the prompt becomes a card in the chat (approvals.ts)
 * and the run waits for the user's answer. The input starts with what the chat missed on voice calls
 * and in teammates' questions (catchup.ts), and with the team's news (team.ts).
 *
 * A 'team' turn is a wake-up: the bot was given a task (team.ts), and the turn is its news. Only one
 * waits in the queue at a time, and one whose news an earlier turn already told is skipped.
 */

/** What a turn answers. Kept in `turns` as JSON and read back after a restart. */
const TriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), text: z.string() }),
  z.object({ type: z.literal('routine'), routineId: z.string(), name: z.string(), prompt: z.string() }),
  z.object({ type: z.literal('bot'), fromBotId: z.string(), fromName: z.string(), text: z.string(), depth: z.number() }),
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('team'), depth: z.number() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

/** A queued or running turn: its row in `turns`, what it answers and the conversation it belongs to. */
interface Job { id: number; trigger: Trigger; generation: number }

const insertTurn = db.prepare<[string, number, string, number]>('INSERT INTO turns(bot_id,generation,trigger,created_at) VALUES (?,?,?,?)');
const forgetTurn = db.prepare<[number]>('DELETE FROM turns WHERE id=?');

interface Running {
  job: Job;
  abort: AbortController;
  /** How many bot-to-bot hops led here (the app's tools stop waking bots at team.ts MAX_HOPS). */
  depth: number;
  /** Set once the request is under way. */
  transcript: TurnTranscript | null;
}

/** Bots whose current conversation already has a Hermes session of its own, by generation (recapFor). */
const sessions = new Map<string, number>();

interface Runner { current: Running | null; queued: Job[]; idle: (() => void)[] }

const runners = new Map<string, Runner>();

/**
 * Queue a turn for the bot; it runs after the turns already queued. A routine whose last run is still
 * running or queued isn't queued again, so one that fires faster than it finishes can't pile up.
 * Returns whether the turn was queued.
 */
export function enqueue(botId: string, trigger: Trigger): boolean {
  const bot = getBotRow(botId);
  if (!bot) return false;
  let r = runners.get(botId);
  if (trigger.type === 'routine' && r && [r.current?.job, ...r.queued].some((j) => j?.trigger.type === 'routine' && j.trigger.routineId === trigger.routineId)) return false;
  if (!r) runners.set(botId, (r = { current: null, queued: [], idle: [] }));
  const id = Number(insertTurn.run(botId, bot.generation, JSON.stringify(trigger), now()).lastInsertRowid);
  r.queued.push({ id, trigger, generation: bot.generation });
  pump(botId, r);
  return true;
}

/**
 * Wake the bot for its team news (it was given a task): a 'team' turn, unless one is already waiting in
 * its queue, which will tell this news too. `depth`: the bot-to-bot hops that led here.
 */
export function wake(botId: string, depth: number) {
  if (runners.get(botId)?.queued.some((j) => j.trigger.type === 'team')) return;
  enqueue(botId, { type: 'team', depth });
}

/** "Stop": end the running turn. Queued turns still run. */
export function interrupt(botId: string) {
  runners.get(botId)?.current?.abort.abort();
}

/** End the running turn and drop the queued ones ("New chat", the bot was deleted). */
export function clear(botId: string) {
  const r = runners.get(botId);
  if (!r) return;
  for (const job of r.queued.splice(0)) forgetTurn.run(job.id);
  r.current?.abort.abort();
}

/** Resolves once the bot has no turn running or queued. */
export function whenIdle(botId: string): Promise<void> {
  const r = runners.get(botId);
  if (!r) return Promise.resolve();
  return new Promise((resolve) => r.idle.push(resolve));
}

function pump(botId: string, r: Runner) {
  if (r.current) return;
  const job = r.queued.shift();
  if (!job) {
    runners.delete(botId);
    for (const resolve of r.idle.splice(0)) resolve();
    return;
  }
  const t = job.trigger;
  const running: Running = { job, abort: new AbortController(), depth: t.type === 'bot' || t.type === 'team' ? t.depth : 0, transcript: null };
  r.current = running;
  runTurn(botId, running)
    .catch((e) => console.error('[agent] turn failed', botId, e))
    .finally(() => {
      forgetTurn.run(job.id);
      r.current = null;
      pump(botId, r);
    });
}

/**
 * On server start: the turns the last process had queued or running, in the order they were queued.
 * One whose run hadn't started never reached Hermes, so it is queued again (it starts once the runs the
 * last process left are settled, so never beside one), unless its chat was cleared since. One whose
 * run had started was cut short: the run is settled with the others (agent/runs.ts: stopped, or its
 * answer kept if Hermes finished it meanwhile), and its chat shows the answer or that it was
 * interrupted, with the rows it left half-written closed (transcript.ts closeCutShort).
 */
export async function resumeTurns() {
  const left = db.prepare<[], TurnRecord>('SELECT * FROM turns ORDER BY id').all();
  // Read before anything new can write: every row still open now was left by the last process. By
  // bot, in the chat it has open now; a New chat meanwhile leaves them in that one.
  const open = new Map(db.prepare<[], { bot_id: string; generation: number; seqs: string }>(
    `SELECT r.bot_id, r.generation, json_group_array(r.seq) AS seqs FROM rows r JOIN bots b ON b.id = r.bot_id AND b.generation = r.generation
     WHERE (r.kind = 'message' AND json_extract(r.body, '$.streaming') = 1)
        OR (r.kind = 'tool-call' AND json_extract(r.body, '$.status') IN ('running', 'awaiting-approval'))
     GROUP BY r.bot_id`,
  ).all().map((o) => [o.bot_id, { generation: o.generation, seqs: z.array(z.number()).parse(JSON.parse(o.seqs)) }]));
  const cut = new Map<string, { generation: number; runId: string }>();
  for (const t of left) {
    forgetTurn.run(t.id);
    const bot = getBotRow(t.bot_id);
    // Its chat was cleared since, or the bot is gone.
    if (!bot || bot.generation !== t.generation) continue;
    if (t.run_id) {
      cut.set(bot.id, { generation: t.generation, runId: t.run_id });
      continue;
    }
    let json: unknown = null;
    try { json = JSON.parse(t.trigger); } catch { /* checked below */ }
    const trigger = TriggerSchema.safeParse(json);
    if (trigger.success) enqueue(bot.id, trigger.data);
    else console.warn(`[agent] ${bot.id}: dropped a queued turn that can't be read: ${t.trigger.slice(0, 200)}`);
  }
  const runs = await settleLeftoverRuns();
  for (const botId of new Set([...cut.keys(), ...open.keys()])) {
    // A run not among those left ended while the last process still followed it: its turn was ending too.
    const run = runs.get(cut.get(botId)?.runId ?? '');
    const seqs = open.get(botId)?.seqs ?? [];
    const generation = open.get(botId)?.generation ?? cut.get(botId)?.generation;
    if (!getBotRow(botId) || generation === undefined || (!run && !seqs.length)) continue;
    closeCutShort(conversation(botId, generation), seqs, run?.answer ?? null);
    emitBot(botId);
  }
}

// ---------- what the app's tools (mcp.ts) see of the running turn ----------

/** Bot-to-bot hops behind the bot's running turn (0 when none runs). */
export const turnDepth = (botId: string) => runners.get(botId)?.current?.depth ?? 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An app tool was called through MCP: find the tool row the running turn made for it. The stream
 * announces a call just before Hermes runs it, so wait a moment for the row. Null when the call is
 * not this turn's: none runs, or the agent used the tool elsewhere (on a voice call, in Hermes' CLI).
 * Only a claimed call may change the turn (its row's outcome, ending it); see mcp.ts.
 */
export async function claimToolRow(botId: string, name: string): Promise<(ToolClaim & { signal: AbortSignal }) | null> {
  // The turn running when the call came in; a turn that starts after it ends had nothing to do with it.
  const turn = runners.get(botId)?.current;
  if (!turn) return null;
  const deadline = Date.now() + 600;
  for (;;) {
    if (runners.get(botId)?.current !== turn) return null;
    const claim = turn.transcript?.claim(name);
    // The turn's Stop stops what the tool started for it too (a question to a teammate).
    if (claim) return { ...claim, signal: turn.abort.signal };
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

/**
 * A message from another bot: it becomes the recipient's turn. Its row keeps it in the recipient's
 * record, for its voice calls and teammates' questions (catchup.ts), but the user isn't shown it
 * (isTeammateMessage): only what the recipient makes of it.
 */
export function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number) {
  const from = requireBot(fromBotId);
  appendRow(toBotId, 'message', { type: 'message', role: 'user', text, from: { kind: 'bot', id: fromBotId, name: from.name } });
  enqueue(toBotId, { type: 'bot', fromBotId, fromName: from.name, text, depth });
}

// ---------- the turn ----------

function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. The user doesn't see it. Reply to them with send_to_bot if they asked you something. Tell the user only what they need to know or act on, briefly and in your own words; if nothing, use stay_silent.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
    case 'team': return '[The team news above is why you are running now. Act on what needs you: start on a task you were given (mark it doing with update_task, and done when it is finished), or follow up with a teammate. If nothing needs you, use stay_silent.]';
  }
}

const authHeaders = (e: Engine) => ({ 'content-type': 'application/json', ...(e.key ? { authorization: `Bearer ${e.key}` } : {}) });

/** One engine-side session per conversation; "New chat" bumps the generation and starts another. */
export const sessionFor = (botId: string, generation: number) => `dispatch-${botId}-g${generation}`;

/**
 * Compatibility: chats from before turns ran on Hermes runs kept their history in a Responses
 * conversation, which a run can't continue. The first run of such a chat starts its session with what
 * the chat shows (Hermes keeps the history of the session from then on). A chat whose session exists,
 * or that has nothing from the bot yet, needs none.
 */
async function recapFor(engine: Engine, convo: Conversation): Promise<string> {
  if (sessions.get(convo.botId) === convo.generation) return '';
  const rows = db.prepare<[string, number], RowRecord>("SELECT * FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq").all(convo.botId, convo.generation)
    .map((r) => JSON.parse(r.body) as RowBody)
    // A voice call's posts are told with the call (catchup.ts).
    .filter((b): b is Extract<RowBody, { type: 'message' }> => b.type === 'message' && !b.note && !b.call && !!b.text.trim());
  // Messages that have not been answered yet are inputs of this turn and the ones queued behind it.
  while (rows.length && rows[rows.length - 1].role === 'user') rows.pop();
  if (!rows.some((b) => b.role === 'assistant')) return '';
  const res = await fetch(`${engine.url}/api/sessions/${encodeURIComponent(sessionFor(convo.botId, convo.generation))}`, { headers: authHeaders(engine), signal: AbortSignal.timeout(10_000) }).catch((e) => {
    console.warn(`[agent] ${convo.botId}: couldn't ask Hermes for the chat's session, so this turn has no recap:`, (e as Error)?.message ?? e);
    return null;
  });
  if (res?.ok) {
    sessions.set(convo.botId, convo.generation);
    return '';
  }
  if (res?.status !== 404) return ''; // Hermes didn't say; a recap in a session that has history would repeat it
  const lines: string[] = [];
  let size = 0;
  for (const b of rows.reverse()) {
    const line = `${b.role === 'user' ? (b.from?.kind === 'bot' ? b.from.name : 'User') : 'You'}: ${b.text.trim().slice(0, 2000)}`;
    if (size + line.length > 16_000 || lines.length >= 40) break;
    lines.unshift(line);
    size += line.length;
  }
  return `[Earlier in this chat (your tool calls are not shown):]\n${lines.join('\n\n')}\n[End of the earlier chat. The new message follows.]\n\n`;
}

async function runTurn(botId: string, running: Running) {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') return;
  const convo = conversation(botId, running.job.generation);
  // Queued in a conversation the user has since cleared.
  if (!convo.isCurrent()) return;
  // A wake-up whose news an earlier turn already told.
  const team = teamNews(botId);
  if (running.job.trigger.type === 'team' && !team?.note) return;
  const transcript = new TurnTranscript(botId, convo);
  const { signal } = running.abort;
  live.turnStarted(botId);
  let outcome: 'done' | 'failed' | 'stopped' = 'done';
  const run = new HermesRun(botId, 'chat');

  try {
    // The screen first: the engine's browser and computer tools point at it.
    await screenForWork(bot.user_id, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    if (signal.aborted) throw new Error('interrupted');
    const engine = await run.gateway();
    if (signal.aborted) throw new Error('interrupted');

    let input = triggerText(running.job.trigger);
    if (bot.handback_at) {
      input = `[Note: the user took control of your screen for a while and has just handed it back. Look at the screen before you rely on what was there.]\n\n${input}`;
      db.prepare('UPDATE bots SET handback_at=NULL WHERE id=?').run(botId);
    }
    // Voice calls and teammates' questions run in conversations of their own: what this one hasn't heard of them goes first.
    const news = sideNews(botId, convo.generation);
    if (team?.note) input = `${team.note}\n\n${input}`;
    if (news?.note) input = `${news.note}\n\n${input}`;
    input = `${await recapFor(engine, convo)}${input}`;
    if (signal.aborted) throw new Error('interrupted');

    const started = await run.start({
      model: bot.model, provider: bot.provider, input, instructions: await instructionsFor(bot.user_id, botId),
      session: sessionFor(botId, convo.generation), effort: bot.effort ?? 'medium',
    }, signal);
    if (!started) throw new Error('interrupted');
    db.prepare('UPDATE turns SET run_id=? WHERE id=?').run(run.id, running.job.id);
    sessions.set(botId, convo.generation);
    // Hermes has the run and its input: the news in it is told.
    if (news) markTold(botId, convo.generation, news.upTo);
    if (team) markTeamSeen(botId, team.upTo);
    if (signal.aborted) throw new Error('interrupted');

    running.transcript = transcript;
    const end = await run.follow(signal, (d) => {
      if (d.event !== 'approval.request') {
        transcript.onRunEvent(d);
        return;
      }
      const tool = transcript.awaitingApproval();
      const seq = tool?.seq ?? null;
      run.askApproval(d, { convo, tool, onSettled: (o) => transcript.approvalSettled(seq, o) });
    });
    if (end.how === 'failed') throw new Error(end.error);
    if (end.how === 'completed') transcript.completed(end.output, end.recovered);
  } catch (e) {
    outcome = signal.aborted ? 'stopped' : 'failed';
    if (outcome === 'failed') console.error('[agent]', botId, e);
    transcript.failed(outcome === 'stopped', e);
  } finally {
    // Stopped by the user (or New chat): Hermes would carry on with a run whose stream nobody reads.
    run.close();
    running.transcript = null;
    transcript.finish(outcome);
    live.turnEnded(botId);
    emitBot(botId);
  }
}
