import { db, now, type BotRecord, type RoutineRecord } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { box } from '../box.js';
import { env } from '../env.js';
import { appendRow, emitBot, getRoutine, listRoutines, describeCron, markUnread, type Conversation } from '../store.js';
import { applySchedule, scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { setCheckins } from '../proactive.js';
import { createRoom, postToRoom } from './rooms.js';
import type { ActivityKind } from '../types.js';
import { fetchWeather } from '../weather.js';
import { Cron } from 'croner';
import { libraryDir } from '../machine.js';
import { z } from 'zod';

export interface ToolCtx {
  userId: string;
  botId: string;
  /** Where the tool's rows go: the calling chat turn's conversation, or the bot's current one for a call from elsewhere. */
  convo: Conversation;
  /** The voice call the tool was used on: set by mcp.ts when no chat turn claimed the call and the bot is on one. */
  callId?: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
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

function botByName(userId: string, name: string) {
  return db.prepare<[string, string], BotRecord>('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, name.trim());
}


export const TOOLS: ToolDef[] = [
  tool({
    name: 'save_file',
    description: "Save a finished deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. Saved under /root/dispatch/files/<your id>/ on your computer. Files you write into that folder yourself show up in the Library too.",
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
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    params: z.object({ name: z.string(), prompt: z.string(), schedule: z.string(), timezone: z.string().describe(`IANA timezone, e.g. America/Los_Angeles. Default: ${env.timeZone}`).optional() }),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || env.timeZone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, a.timezone || env.timeZone, now());
      const r = getRoutine(id)!;
      scheduleRoutine(r);
      ctx.convo.append('event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeCron(a.schedule)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${a.name}` };
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
    description: `Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Leave timezone out to keep the current one, which starts as ${env.timeZone}.`,
    params: z.object({ enabled: z.boolean(), times: z.array(z.string()).optional(), timezone: z.string().optional() }),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e: any) {
        return { output: `Could not update check-ins: ${e?.message ?? e}` };
      }
    },
  }),
  tool({
    name: 'list_routines',
    description: 'List your routines.',
    params: z.object({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  }),
  tool({
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    params: z.object({ routine_id: z.string(), name: z.string().optional(), prompt: z.string().optional(), schedule: z.string().optional(), timezone: z.string().optional(), enabled: z.boolean().optional() }),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare<[string, string], RoutineRecord>('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId);
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = getRoutine(cur.id)!;
      applySchedule(r);
      ctx.convo.append('event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} · ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  }),
  tool({
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    params: z.object({ routine_id: z.string() }),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      // Only its own routines: another bot's id must not even unschedule anything.
      if (!db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(a.routine_id, ctx.botId).changes) return { output: 'No such routine.' };
      unscheduleRoutine(a.routine_id);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  }),
  tool({
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    params: z.object({ bot_name: z.string(), message: z.string() }),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${db.prepare<[string], Pick<BotRecord, 'name'>>('SELECT name FROM bots WHERE user_id=?').all(ctx.userId).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= 3) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
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
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
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
      ctx.convo.append('card', { type: 'card', card: 'question', question: a.question, options: (a.options ?? []).slice(0, 6), ...(a.multiple ? { multiple: true } : {}), status: 'pending' });
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  }),
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

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
