import { db, type BotRecord, type UserRecord } from '../db.js';
import { conversation, emitBot, getBotRow, type Conversation } from '../store.js';
import { errorText } from '../lib/errors.js';
import type { BotQuestion, EventBody, Row } from '../types.js';
import { instructionsFor } from './prompt.js';
import { HermesRun } from './runs.js';
import { activitySnapshot, ago, chatCursor, chatNews, recentMessages, type ChatCursor } from './catchup.js';
import { listTasks, taskLine } from './team.js';

/**
 * ask_bot: one bot asks a teammate a question and gets the answer in the same turn.
 *
 * The answer comes from a Hermes run on the teammate's gateway, in a side conversation of its own for
 * each pair of bots (askSession), the way a voice call has one. So it doesn't wait behind the teammate's
 * turns, and two bots asking each other at once can't wait on each other: each one's question is
 * answered beside its own turn. An ask's life:
 *
 *   asking ──the run completes──► answered
 *     └──it fails, takes longer than ASK_WAIT_MS, the asker's turn stops, or a bot is deleted──► failed
 *
 * The question and its answer are a row in both bots' chats (EventBody 'bot-question'), written when it
 * goes out and rewritten when it ends, so the user sees who asked whom what. The teammate's chat agent
 * hears about it at its next turn (catchup.ts sideNews), so it knows what it told whom. The side
 * conversation hears what is new in the teammate's chat each time (catchup.ts chatNews), with a cursor
 * kept in memory; after a restart it starts again from the recent messages.
 *
 * Asks in flight live in memory: an answer may itself ask someone (nesting, which askDepth counts and
 * the tool limits), and deleting a bot stops the asks to and from it (dropAsks).
 */

/** How long a teammate has to answer. */
const ASK_WAIT_MS = 10 * 60_000;
/** Recent chat messages a side conversation starts with. */
const RECENT = 10;

interface Ask { from: string; to: string; depth: number; abort: AbortController }
const asks = new Set<Ask>();
const cursors = new Map<string, ChatCursor>();

/** The side conversation for questions from one bot to another, in the asked bot's current chat. */
export const askSession = (toBotId: string, fromBotId: string, generation: number) => `dispatch-${toBotId}-ask-${fromBotId}-g${generation}`;

/** How deep in a chain of questions the bot's answers are: 0 when it is answering none, 1 when answering one asked from a chat. */
export function askDepth(botId: string): number {
  let d = 0;
  for (const a of asks) if (a.to === botId) d = Math.max(d, a.depth);
  return d;
}

/** A bot was deleted: the questions it asked and the ones asked of it end now. */
export function dropAsks(botId: string) {
  for (const a of asks) if (a.from === botId || a.to === botId) a.abort.abort(new Error('a bot in the question was removed from the team'));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the side conversation adds to the asked bot's instructions. The same for every question from this teammate. */
function askInstructions(from: BotRecord, owner: string): string {
  return `# A teammate is asking you something
${from.name}${from.label ? `, ${from.label},` : ''} is another agent on ${owner}'s team. They asked you a question with ask_bot, and each message here is one of their questions. Your reply goes straight back to them as the answer.

- Answer from what you know: your chat with ${owner}, your tasks, your files and your memory. Look something up if you need to, but keep it quick: they are waiting for you.
- Be brief and specific, as you would answer a colleague in chat.
- This is a side conversation. Your chat with ${owner} carries on without it and doesn't show it, and nothing here reaches ${owner}. Don't use post_to_chat, ask_user or stay_silent here.
- If they want you to do real work, don't start it here. Say whether you can take it on, and ask them to give it to you on the task board with add_task, which puts it in your chat to work on.
- Lines in [brackets] are notes from the app about your chat with ${owner}, not words from ${from.name}.`;
}

/** What the side conversation hears before a question: what the asked bot is doing and has on its plate, and what is new in its chat. */
function context(to: BotRecord, session: string, owner: string): string {
  const parts = [`[What you are doing in your chat with ${owner} now:\n${activitySnapshot(to.id)}]`];
  const tasks = listTasks(to.user_id).filter((t) => t.ownerId === to.id && t.status !== 'done');
  parts.push(`[Your open tasks on the team's board:\n${tasks.length ? tasks.map((t) => `- ${taskLine(t, owner)}`).join('\n') : '(none)'}]`);
  let cursor = cursors.get(session);
  if (!cursor) {
    cursor = chatCursor(to.id);
    cursors.set(session, cursor);
    const recent = recentMessages(to.id, RECENT).map((m) => `- [${ago(m.at)}] ${m.who === 'User' ? owner : m.who}: ${clip(m.text.replace(/\s+/g, ' '), 400)}`);
    if (recent.length) parts.push(`[Recent messages in your chat with ${owner}, oldest first:\n${recent.join('\n')}]`);
  } else {
    const news = chatNews(to.id, '', cursor, owner);
    if (news) parts.push(news);
  }
  return parts.join('\n\n');
}

export interface AskResult { ok: boolean; answer: string }

/**
 * Ask `to` a question for `from`, whose chat is `convo`. `depth` is how deep in a chain of questions
 * this one is (1 when asked from a chat turn). Resolves with the answer, or with why there is none;
 * never rejects. `signal` stops it: the asker's turn was stopped, or its tool call went away.
 */
export async function askBot(o: { from: BotRecord; to: BotRecord; question: string; depth: number; convo: Conversation; signal?: AbortSignal }): Promise<AskResult> {
  const { from, to } = o;
  const owner = db.prepare<[string], Pick<UserRecord, 'username'>>('SELECT username FROM users WHERE id=?').get(to.user_id)?.username ?? 'the user';
  const record: BotQuestion = { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, question: o.question, status: 'asking' };
  const body = (r: BotQuestion): EventBody => ({ type: 'event', event: 'bot-question', text: `${from.name} asked ${to.name}: ${clip(r.question.replace(/\s+/g, ' '), 200)}`, ask: r });
  // In the asker's chat (its turn's conversation) and in the asked bot's current one.
  const rows = [o.convo.append('event', body(record)), conversation(to.id).append('event', body(record))].filter((r): r is Row => !!r);

  const ask: Ask = { from: from.id, to: to.id, depth: o.depth, abort: new AbortController() };
  asks.add(ask);
  const wait = AbortSignal.timeout(ASK_WAIT_MS);
  const signal = AbortSignal.any([ask.abort.signal, wait, ...(o.signal ? [o.signal] : [])]);
  const run = new HermesRun(to.id, 'ask');
  let result: AskResult;
  try {
    const session = askSession(to.id, from.id, to.generation);
    const instructions = `${await instructionsFor(to.user_id, to.id)}\n${askInstructions(from, owner)}`;
    await run.gateway();
    const input = `${context(to, session, owner)}\n\n${o.question}`;
    const started = await run.start({ model: to.model, provider: to.provider, input, instructions, session, effort: to.effort ?? 'medium' }, signal);
    if (!started) throw new Error('stopped');
    let lastTool: string | null = null;
    const end = await run.follow(signal, (d) => {
      if (d.event === 'tool.started') lastTool = d.tool ?? null;
      if (d.event !== 'approval.request') return;
      // Hermes asks before an action: the card shows in the asked bot's chat, where the user answers it.
      const bot = getBotRow(to.id);
      if (bot) run.askApproval(d, { convo: conversation(bot.id, bot.generation), tool: lastTool ? { name: lastTool, label: `Answering ${from.name}` } : null });
    });
    if (end.how === 'failed') throw new Error(end.error);
    if (end.how !== 'completed' || !end.output.trim()) throw new Error('no answer');
    result = { ok: true, answer: end.output.trim() };
  } catch (e) {
    const why = wait.aborted ? `no answer within ${ASK_WAIT_MS / 60_000} minutes`
      : ask.abort.signal.aborted ? errorText(ask.abort.signal.reason)
      : o.signal?.aborted ? 'the question was called off'
      : errorText(e);
    if (!o.signal?.aborted && !ask.abort.signal.aborted) console.warn(`[asks] ${from.id} asking ${to.id} failed: ${why}`);
    result = { ok: false, answer: why };
  } finally {
    run.close();
    asks.delete(ask);
  }
  const done: BotQuestion = { ...record, status: result.ok ? 'answered' : 'failed', answer: result.answer };
  for (const r of rows) conversation(r.botId, r.generation).update(r.seq, body(done));
  if (getBotRow(to.id)) emitBot(to.id);
  return result;
}
