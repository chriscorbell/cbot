import { db, type RowRecord } from '../db.js';
import { failureText, sseEvents } from '../lib/sse.js';
import { appendRow, conversation, emitBot, getBotRow, requireBot, type Conversation } from '../store.js';
import { screenForWork } from '../computer.js';
import { engineFor, runSlot, type Engine } from '../engine.js';
import type { RowBody } from '../types.js';
import { askApproval, runEnded, runMoved } from './approvals.js';
import { instructionsFor } from './prompt.js';
import { callNews, markTold } from './catchup.js';
import * as live from './live.js';
import { TurnTranscript, type ToolClaim } from './transcript.js';

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
 * The turn itself: make sure the bot's screen is ready (its browser tools point at it), make sure its
 * gateway runs, start a Hermes run (POST /v1/runs) on the conversation's session and feed the run's
 * events to a TurnTranscript (transcript.ts). Stop asks Hermes to stop the run, which a dropped
 * connection alone would not. When Hermes asks before an action, the prompt becomes a card in the
 * chat (approvals.ts) and the run waits for the user's answer. The input starts with what the chat
 * missed on voice calls (catchup.ts).
 */

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  | { type: 'system'; text: string };

interface Job { trigger: Trigger; generation: number }

interface Running {
  job: Job;
  abort: AbortController;
  /** How many bot-to-bot hops led here (send_to_bot stops a ping-pong at 3). */
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
  r.queued.push({ trigger, generation: bot.generation });
  pump(botId, r);
  return true;
}

/** "Stop": end the running turn. Queued turns still run. */
export function interrupt(botId: string) {
  runners.get(botId)?.current?.abort.abort();
}

/** End the running turn and drop the queued ones ("New chat", the bot was deleted). */
export function clear(botId: string) {
  const r = runners.get(botId);
  if (!r) return;
  r.queued.length = 0;
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
  const running: Running = { job, abort: new AbortController(), depth: job.trigger.type === 'bot' ? job.trigger.depth : 0, transcript: null };
  r.current = running;
  runTurn(botId, running)
    .catch((e) => console.error('[agent] turn failed', botId, e))
    .finally(() => {
      r.current = null;
      pump(botId, r);
    });
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
export async function claimToolRow(botId: string, name: string): Promise<ToolClaim | null> {
  // The turn running when the call came in; a turn that starts after it ends had nothing to do with it.
  const turn = runners.get(botId)?.current;
  if (!turn) return null;
  const deadline = Date.now() + 600;
  for (;;) {
    if (runners.get(botId)?.current !== turn) return null;
    const claim = turn.transcript?.claim(name);
    if (claim) return claim;
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

/** A message from another bot: it shows in the recipient's chat and becomes the recipient's turn. */
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
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. Reply to them with send_to_bot if they asked you something.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
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
  const transcript = new TurnTranscript(botId, convo);
  const { signal } = running.abort;
  live.turnStarted(botId);
  let outcome: 'done' | 'failed' | 'stopped' = 'done';
  let run: { engine: Engine; id: string } | null = null;
  let slot: ((event?: unknown) => void) | null = null;

  try {
    // The screen first: the engine's browser and computer tools point at it.
    await screenForWork(bot.user_id, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    if (signal.aborted) throw new Error('interrupted');
    const engine = await engineFor(botId);
    if (signal.aborted) throw new Error('interrupted');

    let input = triggerText(running.job.trigger);
    if (bot.handback_at) {
      input = `[Note: the user took control of your screen for a while and has just handed it back. Look at the screen before you rely on what was there.]\n\n${input}`;
      db.prepare('UPDATE bots SET handback_at=NULL WHERE id=?').run(botId);
    }
    // Voice calls run in conversations of their own: what this one hasn't heard of them goes first.
    const news = callNews(botId, convo.generation);
    if (news?.note) input = `${news.note}\n\n${input}`;
    input = `${await recapFor(engine, convo)}${input}`;
    if (signal.aborted) throw new Error('interrupted');
    // Right after its gateway starts, a bot's first run goes alone for a moment (runSlot).
    slot = await runSlot(botId);
    if (signal.aborted) throw new Error('interrupted');

    // Not aborted with the turn: a run Hermes started that nobody knows the id of could not be stopped.
    const res = await fetch(`${engine.url}/v1/runs`, {
      method: 'POST',
      headers: authHeaders(engine),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: bot.model || 'hermes-agent',
        ...(bot.provider ? { provider: bot.provider } : {}),
        input,
        instructions: await instructionsFor(bot.user_id, botId),
        session_id: sessionFor(botId, convo.generation),
        model_options: { reasoning_effort: bot.effort ?? 'medium' },
      }),
    });
    if (!res.ok) throw new Error(await failureText(res));
    const runId = String(((await res.json()) as any)?.run_id ?? '');
    if (!runId) throw new Error('Hermes started no run');
    run = { engine, id: runId };
    sessions.set(botId, convo.generation);
    // Hermes has the run and its input: the news in it is told.
    if (news) markTold(botId, convo.generation, news.upTo);
    if (signal.aborted) throw new Error('interrupted');

    const events = await fetch(`${engine.url}/v1/runs/${runId}/events`, { headers: authHeaders(engine), signal });
    if (!events.ok || !events.body) throw new Error(await failureText(events));
    running.transcript = transcript;
    for await (const ev of sseEvents(events.body)) {
      const d = ev.data;
      slot(d?.event);
      if (d?.event === 'approval.request') {
        const tool = transcript.awaitingApproval();
        const seq = tool?.seq ?? null;
        askApproval({ convo, engine, runId, event: d, tool, onSettled: (o) => transcript.approvalSettled(seq, o) });
        continue;
      }
      if (d?.event !== 'approval.responded') runMoved(runId);
      if (transcript.onRunEvent(d)) break;
    }
  } catch (e) {
    outcome = signal.aborted ? 'stopped' : 'failed';
    if (outcome === 'failed') console.error('[agent]', botId, e);
    transcript.failed(outcome === 'stopped', e);
  } finally {
    slot?.();
    if (run) {
      runEnded(run.id);
      // Stopped by the user (or New chat): Hermes would carry on with a run whose stream nobody reads.
      if (outcome === 'stopped') {
        const id = run.id;
        void fetch(`${run.engine.url}/v1/runs/${id}/stop`, { method: 'POST', headers: authHeaders(run.engine), body: '{}', signal: AbortSignal.timeout(10_000) })
          .then((r) => { if (!r.ok) console.warn(`[agent] ${botId}: Hermes refused to stop run ${id} (HTTP ${r.status}); it may still be running`); })
          .catch((e) => console.warn(`[agent] ${botId}: couldn't stop run ${id}; it may still be running:`, (e as Error)?.message ?? e));
      }
    }
    running.transcript = null;
    transcript.finish(outcome);
    live.turnEnded(botId);
    emitBot(botId);
  }
}
