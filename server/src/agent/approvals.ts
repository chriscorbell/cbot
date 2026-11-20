import crypto from 'node:crypto';
import { db, now, type ApprovalRecord } from '../db.js';
import { failureText } from '../lib/sse.js';
import { currentRow, getRow, getBotRow, updateRow, type Conversation, type RowRef } from '../store.js';
import { syncApprovals, type Engine } from '../engine.js';
import type { ApprovalChoice, CardBody } from '../types.js';

/**
 * Hermes' approval prompts, as cards in the chat.
 *
 * With approvals on (Settings > Permissions: Smart or Ask), Hermes pauses a run before an action it
 * flags, such as a risky command or a write to ~/.ssh/config, and sends `approval.request` on the run's
 * stream. A chat turn (turns.ts) or a voice call (voice-relay.ts) hands it to `askApproval`: a row in
 * `approvals` and an approval card in the bot's chat. The user's answer goes to Hermes
 * (POST /v1/runs/<id>/approval) and the run carries on.
 *
 *   pending ──answered──► allowed | always | denied
 *      └──── the run moved on without an answer (Hermes' timeout, Stop, the call ended) ──► expired
 *
 * A pending approval lives in memory beside the run that waits for it, so one left by a process that
 * stopped expires at startup. Approval and draft cards from older versions, which nothing waits for,
 * expire when answered.
 */

const CHOICES: ApprovalChoice[] = ['once', 'always', 'deny'];
const OUTCOME = { once: 'allowed', always: 'always', deny: 'denied' } as const;

export type Settled = 'allowed' | 'always' | 'denied' | 'expired';

interface Pending {
  id: string;
  userId: string;
  runId: string;
  engine: Engine;
  /** Hermes' prompt id and the run's execution generation: the answer must name both. */
  promptId: string;
  executionGeneration: number;
  card: RowRef;
  /** An answer is on its way to Hermes: nothing else may settle the approval meanwhile. */
  answering: boolean;
  onSettled?: (outcome: Settled) => void;
}

const pending = new Map<string, Pending>();
/** Runs whose prompts are being checked against Hermes right now (runMoved). */
const checking = new Set<string>();

const hermes = (e: Engine, path: string, body?: unknown) => fetch(`${e.url}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', ...(e.key ? { authorization: `Bearer ${e.key}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  signal: AbortSignal.timeout(15_000),
});

/** The card's words, from Hermes' prompt: its description says what, its command shows how. */
function cardText(ev: any): { title: string; detail: string; command?: string } {
  const description = String(ev?.description ?? '').replace(/\s+/g, ' ').trim();
  const command = String(ev?.command ?? '').trim();
  const [first = '', ...rest] = description.split(/(?<=[.!?])\s+/);
  const title = first ? first.charAt(0).toUpperCase() + first.slice(1) : 'Allow this action?';
  // Hermes writes a non-command action as "<write to …>", which the title already says.
  const isCommand = !!command && !/^<.*>$/s.test(command);
  return { title: title.slice(0, 160), detail: rest.join(' ').slice(0, 600), ...(isCommand ? { command: command.slice(0, 2000) } : {}) };
}

/**
 * Hermes asked before an action: show the card and remember what answering it takes. `tool` is the
 * tool waiting on it, when known. Returns the approval's id, or null when the prompt can't be answered.
 */
export function askApproval(o: {
  convo: Conversation; engine: Engine; runId: string; event: any; tool?: { name: string; label: string } | null;
  onSettled?: (outcome: Settled) => void;
}): string | null {
  const promptId = o.event?.prompt_id ?? o.event?.request_id;
  const executionGeneration = o.event?.execution_generation;
  const bot = getBotRow(o.convo.botId);
  if (typeof promptId !== 'string' || !promptId || typeof executionGeneration !== 'number' || !bot) return null;
  const offered = Array.isArray(o.event?.choices) ? CHOICES.filter((c) => o.event.choices.includes(c)) : CHOICES;
  const id = `ap_${crypto.randomBytes(9).toString('base64url')}`;
  const card = o.convo.append('card', {
    type: 'card', card: 'approval', approvalId: id, ...cardText(o.event),
    tool: o.tool?.name ?? '', ...(o.tool?.label ? { label: o.tool.label } : {}),
    choices: offered.length ? offered : ['once', 'deny'], args: null, status: 'pending',
  } satisfies CardBody);
  // The chat was cleared while the run waited: nobody can see a card, so the prompt is left to time out.
  if (!card) return null;
  db.prepare("INSERT INTO approvals(id,bot_id,generation,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)")
    .run(id, bot.id, card.generation, card.seq, promptId, o.tool?.name ?? '', now());
  pending.set(id, {
    id, userId: bot.user_id, runId: o.runId, engine: o.engine, promptId, executionGeneration,
    card: { botId: bot.id, generation: card.generation, seq: card.seq }, answering: false, onSettled: o.onSettled,
  });
  return id;
}

/** Record how an approval ended, on its row and its card. */
function settle(ap: Pick<ApprovalRecord, 'id' | 'bot_id' | 'generation' | 'row_seq'>, outcome: Settled) {
  db.prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(outcome, now(), ap.id);
  const card = ap.generation === null ? currentRow(ap.bot_id, ap.row_seq) : getRow({ botId: ap.bot_id, generation: ap.generation, seq: ap.row_seq });
  if (card?.body.type === 'card' && card.body.card === 'approval' && card.body.approvalId === ap.id && card.body.status === 'pending') {
    updateRow(card, { ...card.body, status: outcome });
  }
  const p = pending.get(ap.id);
  pending.delete(ap.id);
  p?.onSettled?.(outcome);
}

const recordOf = (p: Pending) => ({ id: p.id, bot_id: p.card.botId, generation: p.card.generation, row_seq: p.card.seq });

export class ApprovalGone extends Error {}

/**
 * The user answered a card. Without a choice (an old draft card) the approval just expires. Throws
 * `ApprovalGone` when nothing waits for the answer any more; the card then says it expired.
 */
export async function answerApproval(userId: string, approvalId: string, choice?: ApprovalChoice): Promise<Settled> {
  const ap = db.prepare<[string, string], ApprovalRecord>('SELECT a.* FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=? AND b.user_id=?').get(approvalId, userId);
  if (!ap) throw new Error('not found');
  const p = pending.get(approvalId);
  if (!p || !choice) {
    if (ap.status === 'pending') settle(ap, 'expired');
    if (choice) throw new ApprovalGone(ap.status === 'pending' || ap.status === 'expired' ? 'This request expired.' : 'This was already answered.');
    return 'expired';
  }
  if (p.answering) throw new ApprovalGone('This was already answered.');
  p.answering = true;
  let res: Response | null = null;
  try {
    res = await hermes(p.engine, `/v1/runs/${p.runId}/approval`, { request_id: p.promptId, execution_generation: p.executionGeneration, choice });
  } catch { /* the gateway is gone */ }
  if (!res?.ok) {
    console.warn(`[approvals] ${approvalId}: Hermes did not take the answer: ${res ? await failureText(res) : 'no gateway'}`);
    settle(recordOf(p), 'expired');
    throw new ApprovalGone('This request expired.');
  }
  const outcome = OUTCOME[choice];
  settle(recordOf(p), outcome);
  // Hermes saves an "Always allow" into the asking bot's config once the run resumes; then every bot gets it.
  if (choice === 'always') setTimeout(() => { try { syncApprovals(userId); } catch (e) { console.warn('[approvals] sharing an allowed action failed', e); } }, 2000);
  return outcome;
}

/**
 * The run sent something after a prompt, so a prompt may have ended without an answer (Hermes' own
 * timeout). Hermes' run status lists the prompts still open; the others expire.
 */
export function runMoved(runId: string) {
  const waiting = [...pending.values()].filter((p) => p.runId === runId && !p.answering);
  if (!waiting.length || checking.has(runId)) return;
  checking.add(runId);
  void (async () => {
    try {
      const res = await hermes(waiting[0].engine, `/v1/runs/${runId}`);
      if (!res.ok) return;
      const open = new Set(((await res.json()) as any)?.pending_controls?.map((c: any) => c?.prompt_id) ?? []);
      for (const p of waiting) if (!open.has(p.promptId) && pending.get(p.id) === p && !p.answering) settle(recordOf(p), 'expired');
    } catch { /* checked again on the next event, and at the run's end */ } finally {
      checking.delete(runId);
    }
  })();
}

/** The run is over: whatever it still waited for can't be answered any more. */
export function runEnded(runId: string) {
  for (const p of [...pending.values()]) if (p.runId === runId && !p.answering) settle(recordOf(p), 'expired');
}

/** On startup: nothing waits for an approval from the last process any more. */
export function expireStaleApprovals() {
  for (const ap of db.prepare<[], ApprovalRecord>("SELECT * FROM approvals WHERE status='pending'").all()) settle(ap, 'expired');
}
