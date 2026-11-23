import { db, now, type BotRecord, type RoutineRecord } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { box } from '../box.js';
import { env } from '../env.js';
import { appendRow, emitBot, getRoutine, listRoutines, describeCron, markUnread, type Conversation } from '../store.js';
import { applySchedule, scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { setCheckins } from '../proactive.js';
import { createRoom, postToRoom } from './rooms.js';
import { askBot } from './asks.js';
import { activitySnapshot, ago, recentMessages } from './catchup.js';
import { addTask, changeTask, getTask, listTasks, MAX_HOPS, ownerName, taskLine, type Actor } from './team.js';
import { listMemories } from '../engine-memory.js';
import { TASK_STATUSES, type ActivityKind, type EventBody } from '../types.js';
import { fetchWeather } from '../weather.js';
import { Cron } from 'croner';
import { BOTS_DIR, libraryDir } from '../machine.js';
import { z } from 'zod';
import { errorText } from '../lib/errors.js';
import { boardOn, nameInUse } from '../workspaces.js';
import { notify } from '../notifications.js';
import type { addTeammate, updatePersona } from '../bots.js';

export interface ToolCtx {
  userId: string;
  botId: string;
  /** The calling bot's workspace: the team its tools see and reach. */
  workspaceId: string;
  /** Where the tool's rows go: the calling chat turn's conversation, or the bot's current one for a call from elsewhere. */
  convo: Conversation;
  /** The voice call the tool was used on: set by mcp.ts when no chat turn claimed the call and the bot is on one. */
  callId?: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  /** Queue a turn for a bot that was given a task (turns.ts wake). */
  wake: (botId: string, depth: number) => void;
  /**
   * Add an agent to the calling bot's workspace, and change a teammate's label, About or instructions
   * (bots.ts). Passed in like wake: bots.ts loads turns.ts, which loads this module.
   */
  addTeammate: typeof addTeammate;
  updatePersona: typeof updatePersona;
  /** Bot-to-bot hops behind the turn that called the tool (team.ts MAX_HOPS). */
  depth: number;
  /** How deep in a chain of ask_bot questions the call is: 0 from a chat turn, 1 while answering a question asked from one. */
  asking: number;
  /** Ends when the call no longer matters: its turn was stopped, or Hermes gave up on the call. */
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Text handed back to the agent. */
  output: string;
  summary?: string;
  /** End the turn after this tool (e.g. a question was asked). */
  endTurn?: boolean;
}

/**
 * One of the app's tools. `params` is a zod object: mcp.ts advertises it as the tool's JSON schema
 * (with descriptions from `.describe()`) and parses every call with it, so `impl` gets typed
 * arguments and a malformed call is an error the agent can read, not a half-run tool.
 */
interface ToolDef<P extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  params: P;
  activity: ActivityKind;
  label: string;
  impl: (args: z.infer<P>, ctx: ToolCtx) => Promise<ToolResult>;
}

const tool = <P extends z.ZodObject>(def: ToolDef<P>): ToolDef => def as unknown as ToolDef;

/** The tool's arguments as JSON Schema, for MCP tools/list. Unknown keys are refused there and ignored by `parse`. */
export function inputSchema(t: ToolDef): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(t.params.strict(), { io: 'input' }) as Record<string, unknown>;
  return { ...schema, required: schema.required ?? [] };
}

/** Run a tool on a call's raw arguments. Arguments that don't fit its params are refused (`invalid`). */
export async function runTool(t: ToolDef, rawArgs: unknown, ctx: ToolCtx): Promise<ToolResult & { invalid?: true }> {
  const r = t.params.safeParse(rawArgs ?? {});
  if (!r.success) return { output: `Invalid arguments for ${t.name}:\n${z.prettifyError(r.error)}`, summary: 'Invalid arguments', invalid: true };
  return t.impl(r.data, ctx);
}

/** A bot or group chat of the workspace, by name. Bots of other workspaces aren't the caller's teammates. */
function botByName(workspaceId: string, name: string) {
  return db.prepare<[string, string], BotRecord>('SELECT * FROM bots WHERE workspace_id=? AND lower(name)=lower(?)').get(workspaceId, name.trim());
}

/** Deepest chain of questions ask_bot allows: a bot answering a question may ask one more teammate, and no further. */
const MAX_ASK_DEPTH = 2;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const agentNames = (workspaceId: string) => db.prepare<[string], Pick<BotRecord, 'name'>>("SELECT name FROM bots WHERE workspace_id=? AND kind<>'room' ORDER BY created_at").all(workspaceId).map((b) => b.name).join(', ');

/** Another agent on the team by name, or why the name doesn't do. */
function teammate(ctx: ToolCtx, name: string): { bot: BotRecord } | { output: string } {
  const bot = botByName(ctx.workspaceId, name);
  if (!bot) return { output: `No agent named "${name}". The team: ${agentNames(ctx.workspaceId)}.` };
  if (bot.id === ctx.botId) return { output: 'That is you.' };
  if (bot.kind === 'room') return { output: `"${bot.name}" is a group chat, not an agent.` };
  return { bot };
}

/**
 * A task's owner given by name: an agent on the team, "me" (the calling bot), or "nobody". Undefined
 * leaves the owner as it is. Returns the bot id (null for nobody), or why the name doesn't do.
 */
function ownerByName(ctx: ToolCtx, name: string | undefined): { id: string | null | undefined } | { output: string } {
  if (name === undefined) return { id: undefined };
  const n = name.trim().toLowerCase();
  if (!n || n === 'nobody' || n === 'none' || n === 'unassigned') return { id: null };
  if (n === 'me' || n === 'myself') return { id: ctx.botId };
  const bot = botByName(ctx.workspaceId, name);
  if (!bot || bot.kind === 'room') return { output: `No agent named "${name}". The team: ${agentNames(ctx.workspaceId)}.` };
  return { id: bot.id };
}

const nameOf = (botId: string) => db.prepare<[string], Pick<BotRecord, 'name'>>('SELECT name FROM bots WHERE id=?').get(botId)?.name;

const actorOf = (ctx: ToolCtx): Actor => ({ kind: 'bot', id: ctx.botId, name: nameOf(ctx.botId) ?? 'A teammate' });

/** The calling bot's own row, or undefined once it is deleted. */
const selfOf = (ctx: ToolCtx) => db.prepare<[string], BotRecord>('SELECT * FROM bots WHERE id=?').get(ctx.botId);

/**
 * The workspace's primary bot manages its team: it adds agents, changes their roles and instructions,
 * and sets up their routines. Any other bot is told to ask it, and it decides.
 */
function onlyPrimary(ctx: ToolCtx, what: string): { output: string } {
  const primary = db.prepare<[string], Pick<BotRecord, 'name'>>("SELECT name FROM bots WHERE workspace_id=? AND is_primary=1 AND kind<>'room'").get(ctx.workspaceId)?.name;
  return { output: `Only ${primary ?? 'the primary bot'}, the team's primary bot, can ${what}. If it's needed, ask ${primary ? 'them' : 'it'} with send_to_bot; they decide.` };
}

/** Whose routines a routine tool works on: the caller's own, or, for the primary bot, the teammate named. */
function routineOwner(ctx: ToolCtx, name: string | undefined): { me: BotRecord; bot: BotRecord } | { output: string } {
  const me = selfOf(ctx);
  if (!me) return { output: 'You are no longer on the team.' };
  const n = name?.trim().toLowerCase();
  if (!n || n === 'me' || n === 'myself' || n === me.name.toLowerCase()) return { me, bot: me };
  if (!me.is_primary) return onlyPrimary(ctx, "manage a teammate's routines");
  const t = teammate(ctx, name!);
  return 'output' in t ? t : { me, bot: t.bot };
}

/** A routine the calling bot may change: its own, or, for the workspace's primary bot, a teammate's. */
function routineFor(ctx: ToolCtx, id: string): RoutineRecord | undefined {
  const r = db.prepare<[string, string], RoutineRecord>('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.workspace_id=?').get(id, ctx.workspaceId);
  return r && (r.bot_id === ctx.botId || selfOf(ctx)?.is_primary) ? r : undefined;
}

/**
 * Something changed in a bot's routines or role: a line in its chat, so the user sees it there. Its
 * agent needs no word of it, since its app instructions list its routines and role afresh every turn.
 * A change to the caller's own goes in the calling turn's chat.
 */
function noteChange(ctx: ToolCtx, botId: string, row: EventBody) {
  if (botId === ctx.botId) ctx.convo.append('event', row);
  else appendRow(botId, 'event', row);
}

/** Wake the bot a task was given to, unless the chain of hops behind this turn is long enough already. */
function wakeGiven(ctx: ToolCtx, botId: string | null): string {
  if (!botId) return '';
  const name = nameOf(botId) ?? 'They';
  if (ctx.depth >= MAX_HOPS) return ` ${name} will see it at their next turn (too many hops between bots to wake them now).`;
  ctx.wake(botId, ctx.depth + 1);
  return ` ${name} was told and starts on it.`;
}

/** The tools that use the task board: a bot in a workspace that has turned the board off isn't offered them. */
const BOARD_TOOLS = new Set(['list_tasks', 'add_task', 'update_task']);
const BOARD_OFF = { output: 'The task board is turned off in this workspace.' };


export const TOOLS: ToolDef[] = [
  tool({
    name: 'save_file',
    description: `Save a finished deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. Saved under ~/${BOTS_DIR}/files/<your id>/ on your computer. Files you write into that folder yourself show up in the Library too.`,
    params: z.object({ filename: z.string().describe('e.g. briefing-2026-11-09.md'), content: z.string() }),
    activity: 'drafting_file',
    label: 'Saving a file',
    impl: async (a, ctx) => {
      const name = String(a.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file.txt';
      const file = `${libraryDir(ctx.botId)}/${name}`;
      await box.writeFile(file, String(a.content ?? ''));
      return { output: JSON.stringify({ ok: true, path: file }), summary: `Saved ${name}` };
    },
  }),
  tool({
    name: 'create_routine',
    description: 'Create a recurring routine run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction followed each time it runs. It is yours unless you name a teammate in bot_name, which only the primary bot can.',
    params: z.object({
      name: z.string(), prompt: z.string(), schedule: z.string(), timezone: z.string().describe(`IANA timezone, e.g. America/Los_Angeles. Default: ${env.timeZone}`).optional(),
      bot_name: z.string().optional().describe("The teammate whose routine it is (primary bot only). Default: you"),
    }),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      const o = routineOwner(ctx, a.bot_name);
      if ('output' in o) return o;
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || env.timeZone }); } catch (e) { return { output: `Invalid schedule: ${errorText(e)}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, o.bot.id, a.name, a.prompt, a.schedule, a.timezone || env.timeZone, now());
      const r = getRoutine(id)!;
      scheduleRoutine(r);
      const when = describeCron(a.schedule);
      noteChange(ctx, o.bot.id, { type: 'event', event: 'routine-created', text: o.bot.id === ctx.botId ? `Routine created: ${a.name} · ${when}` : `${o.me.name} set up a routine: ${a.name} · ${when}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: o.bot.id });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: o.bot.id === ctx.botId ? `Created routine ${a.name}` : `Created routine ${a.name} for ${o.bot.name}` };
    },
  }),
  tool({
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    params: z.object({ reason: z.string().optional() }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  }),
  tool({
    // The voice relay sees this call in the turn's event stream and hangs up once the goodbye has played.
    name: 'end_call',
    description: 'Hang up the voice call you are on. Use it only on a voice call, when the user says goodbye or asks to end the call: say a short goodbye in the same reply first, then call it, and write nothing after it.',
    params: z.object({}),
    activity: 'working',
    label: 'Ending the call',
    impl: async () => ({ output: 'The call hangs up after your goodbye has played. Write nothing more.', summary: 'Ended the call' }),
  }),
  tool({
    name: 'set_checkins',
    description: `Turn proactive check-ins on or off and set when they happen (only the primary Bot of each workspace does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Leave timezone out to keep the current one, which starts as ${env.timeZone}.`,
    params: z.object({ enabled: z.boolean(), times: z.array(z.string()).optional(), timezone: z.string().optional() }),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.workspaceId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e) {
        return { output: `Could not update check-ins: ${errorText(e)}` };
      }
    },
  }),
  tool({
    name: 'list_routines',
    description: "List your routines, or a teammate's (bot_name; primary bot only).",
    params: z.object({ bot_name: z.string().optional() }),
    activity: 'working',
    label: 'Checking routines',
    impl: async (a, ctx) => {
      const o = routineOwner(ctx, a.bot_name);
      return 'output' in o ? o : { output: JSON.stringify(listRoutines(o.bot.id)) };
    },
  }),
  tool({
    name: 'update_routine',
    description: "Change or pause one of your routines; the primary bot may also change a teammate's.",
    params: z.object({ routine_id: z.string(), name: z.string().optional(), prompt: z.string().optional(), schedule: z.string().optional(), timezone: z.string().optional(), enabled: z.boolean().optional() }),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = routineFor(ctx, a.routine_id);
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e) { return { output: `Invalid schedule: ${errorText(e)}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = getRoutine(cur.id)!;
      applySchedule(r);
      const state = r.enabled ? r.description : 'Paused';
      const by = nameOf(ctx.botId) ?? 'A teammate';
      noteChange(ctx, r.botId, { type: 'event', event: 'routine-updated', text: r.botId === ctx.botId ? `Routine updated: ${r.name} · ${state}` : `${by} updated a routine: ${r.name} · ${state}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: r.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  }),
  tool({
    name: 'delete_routine',
    description: "Delete one of your routines; the primary bot may also delete a teammate's.",
    params: z.object({ routine_id: z.string() }),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      // Only one it may change: another bot's id must not even unschedule anything.
      const cur = routineFor(ctx, a.routine_id);
      if (!cur || !db.prepare('DELETE FROM routines WHERE id=?').run(cur.id).changes) return { output: 'No such routine.' };
      unscheduleRoutine(cur.id);
      if (cur.bot_id !== ctx.botId) {
        const by = nameOf(ctx.botId) ?? 'A teammate';
        noteChange(ctx, cur.bot_id, { type: 'event', event: 'routine-updated', text: `${by} removed a routine: ${cur.name}` });
      }
      hub.emit(ctx.userId, { type: 'routines', botId: cur.bot_id });
      return { output: 'Deleted.' };
    },
  }),
  tool({
    name: 'send_to_bot',
    description: "Send a message to another agent on the user's team (by name). It becomes a turn in their chat, and their reply, if any, arrives later as a new message to you. For a question you need answered now use ask_bot; to give them work use add_task.",
    params: z.object({ bot_name: z.string(), message: z.string() }),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.workspaceId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${agentNames(ctx.workspaceId)}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= MAX_HOPS) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
    },
  }),
  tool({
    name: 'ask_bot',
    description: "Ask another agent on the team (by name) a question and get their answer now, in this turn. They answer from what they know: their chat with the user, their tasks, files and memory. Use it to check on a teammate's work or ask what they know instead of guessing. Takes a while when they have to look something up. To give them work, use add_task instead.",
    params: z.object({ bot_name: z.string(), question: z.string().describe('The question, with the context they need to answer it') }),
    activity: 'messaging_named',
    label: 'Asking a teammate',
    impl: async (a, ctx) => {
      const t = teammate(ctx, a.bot_name);
      if ('output' in t) return t;
      const question = a.question.trim();
      if (!question) return { output: 'Ask something: the question is empty.' };
      if (ctx.asking >= MAX_ASK_DEPTH) return { output: `You are already answering a teammate's question that came through another one; answer with what you know instead of asking ${t.bot.name}.` };
      const from = db.prepare<[string], BotRecord>('SELECT * FROM bots WHERE id=?').get(ctx.botId);
      if (!from) return { output: 'You are no longer on the team.' };
      const r = await askBot({ from, to: t.bot, question, depth: ctx.asking + 1, convo: ctx.convo, signal: ctx.signal });
      return r.ok
        ? { output: `${t.bot.name} answered:\n${r.answer}`, summary: `${t.bot.name} answered` }
        : { output: `${t.bot.name} didn't answer: ${r.answer}.`, summary: `No answer from ${t.bot.name}` };
    },
  }),
  tool({
    name: 'check_on_bot',
    description: "See where a teammate (another agent on the team, by name) stands: their role, About and instructions, skills, routines, their tasks on the board, what they're doing right now, their own notes, their latest messages with the user and where their Library is. Read-only; they aren't told.",
    params: z.object({ bot_name: z.string() }),
    activity: 'working',
    label: 'Checking on a teammate',
    impl: async (a, ctx) => {
      const t = teammate(ctx, a.bot_name);
      if ('output' in t) return t;
      const b = t.bot;
      const user = ownerName(ctx.userId);
      const out: string[] = [`# ${b.name}${b.label ? `, ${b.label}` : ''}${b.is_primary ? ` (${user}'s main point of contact)` : ''}`];
      if (b.description.trim()) out.push(`About: ${b.description.trim()}`);
      // Whole, as long as they are kept (bots.ts): the primary bot rewrites them from here with update_bot.
      if (b.instructions.trim()) out.push(`## Instructions from ${user}\n${clip(b.instructions.trim(), 8000)}`);
      const skills = db.prepare<[string], { name: string }>('SELECT name FROM skills WHERE bot_id=? ORDER BY created_at').all(b.id).map((s) => s.name);
      if (skills.length) out.push(`## Skills\n${skills.join(', ')}`);
      const routines = listRoutines(b.id).map((r) => `- ${r.name}: ${r.enabled ? r.description : 'paused'}; ${clip(r.prompt.replace(/\s+/g, ' '), 160)}`);
      if (routines.length) out.push(`## Routines\n${routines.join('\n')}`);
      if (boardOn(ctx.workspaceId)) {
        const tasks = listTasks(ctx.workspaceId).filter((x) => x.ownerId === b.id).map((x) => `- ${taskLine(x, user)}`);
        out.push(`## Tasks\n${tasks.length ? tasks.join('\n') : '(none)'}`);
      }
      out.push(`## Right now\n${activitySnapshot(b.id)}`);
      const notes = listMemories(b.id).filter((m) => m.source === 'notes').map((m) => `- ${clip(m.text.replace(/\s+/g, ' '), 300)}`).join('\n');
      if (notes) out.push(`## Their notes\n${clip(notes, 1500)}`);
      const recent = recentMessages(b.id, 10).map((m) => `- [${ago(m.at)}] ${m.who === 'User' ? user : m.who}: ${clip(m.text.replace(/\s+/g, ' '), 300)}`);
      out.push(`## Latest messages in their chat with ${user}, oldest first\n${recent.length ? recent.join('\n') : '(none)'}`);
      out.push(`## Library\n~/${BOTS_DIR}/files/${b.id}/ (you can read it; change only your own)`);
      return { output: out.join('\n\n'), summary: `Checked on ${b.name}` };
    },
  }),
  tool({
    name: 'list_tasks',
    description: "The team's task board: open tasks with their status, owner and notes, and the ones finished in the last two weeks. Filter by owner: an agent's name, \"me\" or \"nobody\".",
    params: z.object({ owner: z.string().optional(), include_done: z.boolean().optional().describe('Also list finished tasks') }),
    activity: 'working',
    label: 'Checking the task board',
    impl: async (a, ctx) => {
      if (!boardOn(ctx.workspaceId)) return BOARD_OFF;
      const o = ownerByName(ctx, a.owner);
      if ('output' in o) return o;
      const user = ownerName(ctx.userId);
      const tasks = listTasks(ctx.workspaceId).filter((t) => (o.id === undefined || t.ownerId === o.id) && (a.include_done || t.status !== 'done'));
      if (!tasks.length) return { output: 'No tasks.' };
      const order = (s: string) => TASK_STATUSES.indexOf(s as (typeof TASK_STATUSES)[number]);
      return { output: tasks.sort((x, y) => order(x.status) - order(y.status)).map((t) => `- ${taskLine(t, user, { owner: true })}`).join('\n') };
    },
  }),
  tool({
    name: 'add_task',
    description: "Put a task on the team's board. owner is the agent who should do it (by name), \"me\" (the default) or \"nobody\". A teammate you give a task to is told at once and starts on it, and you hear when they finish it.",
    params: z.object({
      title: z.string().describe('What to do, in a few words'),
      notes: z.string().optional().describe('What they need to know to do it: context, links, what done looks like'),
      owner: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional().describe('Default todo'),
    }),
    activity: 'working',
    label: 'Adding a task',
    impl: async (a, ctx) => {
      if (!boardOn(ctx.workspaceId)) return BOARD_OFF;
      const title = a.title.trim();
      if (!title) return { output: 'A task needs a title.' };
      const o = ownerByName(ctx, a.owner ?? 'me');
      if ('output' in o) return o;
      const r = addTask(ctx.workspaceId, actorOf(ctx), { title: clip(title, 200), notes: a.notes, ownerId: o.id === undefined ? ctx.botId : o.id, status: a.status });
      return { output: `Added ${r.task.id}.${wakeGiven(ctx, r.given)}`, summary: `Added "${clip(title, 60)}"` };
    },
  }),
  tool({
    name: 'update_task',
    description: "Change a task on the team's board: its status (todo, doing, blocked, done), its title, its owner (an agent's name, \"me\" or \"nobody\"), or add a note (say why when you mark it blocked). Keep your own tasks current as you work. Its owner is told what you changed, and a new owner starts on it.",
    params: z.object({
      task_id: z.string(),
      status: z.enum(TASK_STATUSES).optional(),
      note: z.string().optional().describe('Added to the end of its notes, with your name'),
      title: z.string().optional(),
      owner: z.string().optional(),
    }),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      if (!boardOn(ctx.workspaceId)) return BOARD_OFF;
      if (!getTask(ctx.workspaceId, a.task_id)) return { output: `No task ${a.task_id}. list_tasks shows the board.` };
      const o = ownerByName(ctx, a.owner);
      if ('output' in o) return o;
      const r = changeTask(ctx.workspaceId, actorOf(ctx), a.task_id, { status: a.status, note: a.note, title: a.title ? clip(a.title.trim(), 200) : undefined, ownerId: o.id });
      if (!r) return { output: `No task ${a.task_id}.` };
      return { output: `Updated: ${taskLine(r.task, ownerName(ctx.userId), { owner: true })}.${wakeGiven(ctx, r.given)}`, summary: `Updated "${clip(r.task.title, 60)}"` };
    },
  }),
  tool({
    name: 'create_bot',
    description: "Add a new agent to the team: a bot with its own chat, computer and browser, starting on the primary bot's model and reasoning effort. Only the primary bot can. Use it when the user asks for a new agent, or when a teammate asks for one and the team really needs it; never to get a one-off job done, which you or a teammate can do. It greets the user in its own chat; give it work afterwards with add_task or send_to_bot.",
    params: z.object({
      name: z.string().describe('Its name, one or two words, not already on the team'),
      label: z.string().optional().describe('Its role in a few words, e.g. "Researcher"'),
      about: z.string().optional().describe('A sentence or two on what it does, shown to the user and the team'),
      instructions: z.string().optional().describe('How it should work: its job, what to focus on, standing preferences of the user'),
    }),
    activity: 'working',
    label: 'Adding a teammate',
    impl: async (a, ctx) => {
      const by = selfOf(ctx);
      if (!by) return { output: 'You are no longer on the team.' };
      if (!by.is_primary) return onlyPrimary(ctx, 'add an agent to the team');
      const name = a.name.trim();
      if (!name) return { output: 'The new agent needs a name.' };
      const taken = nameInUse(ctx.workspaceId, name);
      if (taken) return { output: `${taken} Pick another name.` };
      const r = ctx.addTeammate(by, { name, label: a.label, description: a.about, instructions: a.instructions });
      if ('error' in r) return { output: r.error, summary: 'Not added' };
      return { output: `${r.bot.name} joined the team and is greeting ${ownerName(ctx.userId)} in their own chat. Give them work with add_task or send_to_bot.`, summary: `Added ${r.bot.name}` };
    },
  }),
  tool({
    name: 'update_bot',
    description: "Change a teammate's label (their role), About or instructions. Only the primary bot can. Each one you give replaces the old one whole, so read their instructions with check_on_bot first and keep what should stay. The teammate and the user see what changed.",
    params: z.object({
      bot_name: z.string(),
      label: z.string().optional().describe('Their role in a few words'),
      about: z.string().optional().describe('A sentence or two on what they do, shown to the user and the team'),
      instructions: z.string().optional().describe('All of their instructions, as they should read from now on'),
    }),
    activity: 'working',
    label: 'Updating a teammate',
    impl: async (a, ctx) => {
      const by = selfOf(ctx);
      if (!by) return { output: 'You are no longer on the team.' };
      if (!by.is_primary) return onlyPrimary(ctx, "change a teammate's role, About or instructions");
      const t = teammate(ctx, a.bot_name);
      if ('output' in t) return t;
      const changed = ctx.updatePersona(t.bot, { label: a.label, description: a.about, instructions: a.instructions });
      if (!changed.length) return { output: `Nothing changed: ${t.bot.name}'s are already that.` };
      const what = changed.map((k) => (k === 'description' ? 'About' : k)).join(' and ').replace(/ and (?=.* and )/, ', ');
      noteChange(ctx, t.bot.id, { type: 'event', event: 'bot-message', text: `${by.name} changed ${t.bot.name}'s ${what}` });
      return { output: `Changed ${t.bot.name}'s ${what}. They follow it from their next turn.`, summary: `Updated ${t.bot.name}` };
    },
  }),
  tool({
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    params: z.object({ name: z.string(), bot_names: z.array(z.string()) }),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.workspaceId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const taken = nameInUse(ctx.workspaceId, a.name);
      if (taken) return { output: `${taken} Pick another name.` };
      const id = createRoom(ctx.userId, ctx.workspaceId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${a.name}` };
    },
  }),
  tool({
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    params: z.object({ group_name: z.string(), text: z.string() }),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text));
      return { output: out, summary: `Posted to ${a.group_name}`, endTurn: out === 'Posted to the group.' };
    },
  }),
  tool({
    name: 'show_weather',
    description: 'Show the current weather and the forecast for a place as a card in the chat (temperature, conditions, the next hours and the next days), from Open-Meteo. Always use this for weather questions, even if you know another way to look the weather up, then answer in one or two short sentences; the card has the details.',
    params: z.object({ location: z.string().describe('City, optionally with region or country, e.g. "Louisville, KY" or "Tokyo"') }),
    activity: 'searching_web',
    label: 'Checking the weather',
    impl: async (a, ctx) => {
      const card = await fetchWeather(String(a.location ?? ''));
      if (!card) return { output: `No place called "${a.location}" was found. Ask the user where they mean.`, summary: 'Place not found' };
      ctx.convo.append('card', card);
      const c = card.current;
      const days = card.daily.slice(0, 5).map((d) => `${d.date}: ${Math.round(d.low)}–${Math.round(d.high)}°C, code ${d.code}, ${d.precip}% rain`).join('; ');
      return {
        output: `Shown to the user as a card. ${card.place} now: ${Math.round(c.temp)}°C (feels ${Math.round(c.feelsLike)}°C), WMO code ${c.code}, humidity ${c.humidity}%, wind ${Math.round(c.wind)} km/h, today ${Math.round(c.low)}–${Math.round(c.high)}°C. Next days: ${days}. Reply in one or two short sentences; don't repeat the card.`,
        summary: card.place,
      };
    },
  }),
  tool({
    name: 'post_to_chat',
    description: "Post a message in your text chat with the user. On a voice call, use it for anything better read than heard (links, addresses, lists, code, numbers to copy, a written summary), then tell the user it's in the chat instead of reading it out. In the text chat itself, write your reply instead.",
    params: z.object({ text: z.string().describe('The message, in markdown') }),
    activity: 'working',
    label: 'Posting in the chat',
    impl: async (a, ctx) => {
      const text = a.text.trim();
      if (!text) return { output: 'Nothing was posted: the text is empty.', summary: 'Nothing to post' };
      // Marked with the call, so the chat's agent is told what the call posted (agent/catchup.ts).
      const row = ctx.convo.append('message', { type: 'message', role: 'assistant', text, streaming: false, ...(ctx.callId ? { call: ctx.callId } : {}) });
      if (!row) return { output: 'The user started a new chat meanwhile; nothing was posted.', summary: 'Chat was cleared' };
      markUnread(ctx.botId);
      emitBot(ctx.botId);
      return { output: "Posted in the chat. Tell the user it's there; don't read it out.", summary: 'Posted in the chat' };
    },
  }),
  tool({
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Give up to 5 short options; the user can always answer something else instead. Set multiple to true when they may pick more than one. Ends your turn; their answer arrives as their next message.',
    params: z.object({ question: z.string(), options: z.array(z.string()), multiple: z.boolean().optional() }),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      const card = ctx.convo.append('card', { type: 'card', card: 'question', question: a.question, options: (a.options ?? []).slice(0, 6), ...(a.multiple ? { multiple: true } : {}), status: 'pending' });
      if (card) notify(ctx.botId, true);
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  }),
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools a bot is offered: all of them, but the board's while its workspace has turned the board off. */
export function toolsFor(botId: string): ToolDef[] {
  const b = db.prepare<[string], Pick<BotRecord, 'workspace_id'>>('SELECT workspace_id FROM bots WHERE id=?').get(botId);
  return b && !boardOn(b.workspace_id) ? TOOLS.filter((t) => !BOARD_TOOLS.has(t.name)) : TOOLS;
}

/** A Hermes tool name as the app knows it: tools served by this app's MCP server lose their `mcp_dispatch_` prefix. */
export function appToolName(raw: string): { name: string; ours: boolean; server?: string } {
  const own = /^mcp_+dispatch_+(.+)$/.exec(raw);
  if (own) {
    // Hermes may fold names to lower case; ours are matched case-insensitively.
    const hit = [...toolMap.keys()].find((k) => k.toLowerCase() === own[1].toLowerCase());
    return { name: hit ?? own[1], ours: true };
  }
  const other = /^mcp_+([a-zA-Z0-9-]+?)_+(.+)$/.exec(raw);
  if (other) return { name: other[2], ours: false, server: other[1] };
  return { name: raw, ours: false };
}

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What to show while a tool runs. `raw` is the name Hermes reports. */
export function activityFor(raw: string): { kind: ActivityKind; label: string; detail?: string } {
  const { name, ours, server } = appToolName(raw);
  const own = ours ? toolMap.get(name) : undefined;
  if (own) return { kind: own.activity, label: own.label };
  if (server) return { kind: 'connecting_service', label: `Using ${words(server)}`, detail: sentence(words(server)) };
  if (name === 'terminal' || name === 'process' || name === 'execute_code') return { kind: 'running_commands', label: 'Running commands' };
  if (name === 'write_file' || name === 'patch') return { kind: 'drafting_file', label: 'Writing a file' };
  if (name === 'read_file' || name === 'search_files') return { kind: 'working', label: 'Reading files' };
  if (name === 'web_search') return { kind: 'searching_web', label: 'Searching the web' };
  if (name === 'web_extract') return { kind: 'reading_web', label: 'Reading a page' };
  if (name.startsWith('browser_')) return { kind: 'browsing_web', label: 'Browsing a site' };
  if (name === 'computer_use') return { kind: 'on_its_computer', label: 'Using its computer' };
  if (name === 'vision_analyze') return { kind: 'working', label: 'Looking at an image' };
  if (name === 'memory') return { kind: 'remembering', label: 'Saving notes' };
  if (name === 'session_search') return { kind: 'remembering', label: 'Searching memory' };
  if (name === 'todo') return { kind: 'working', label: 'Planning' };
  if (name === 'delegate_task') return { kind: 'working', label: 'Handing off work' };
  if (name === 'send_message') return { kind: 'messaging_named', label: 'Sending a message' };
  if (name.startsWith('skill')) return { kind: 'working', label: 'Using a skill' };
  if (name === 'clarify') return { kind: 'waiting_for_you', label: 'Waiting on you' };
  if (name === 'cronjob') return { kind: 'working', label: 'Scheduling' };
  return { kind: 'working', label: sentence(words(name)) || 'Working' };
}
