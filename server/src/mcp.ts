import crypto from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { conversation, getBotRow } from './store.js';
import { mcpToken, modelOffers } from './engine.js';
import { claimToolRow, enqueueBotMessage, turnDepth, wake } from './agent/turns.js';
import { askDepth } from './agent/asks.js';
import { inputSchema, runTool, toolMap, toolsFor, type ToolCtx } from './agent/tools.js';
import { liveCallOf } from './voice.js';
import { addTeammate, setModel, updatePersona } from './bots.js';
import { errorText } from './lib/errors.js';

/**
 * The app's tools, served to the Hermes engines over MCP (streamable HTTP, JSON answers only).
 *
 *   POST /mcp/<botId>     one bot's engine; the bearer token is derived from the bot id
 *
 * Every call is stateless: the URL says which bot is calling. Only the app's own tools are served.
 */

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface CallResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): CallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which bot a request is for, or null when the token does not fit the URL. */
function caller(slug: string, auth: string | undefined): { botId: string } | null {
  const given = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return null;
  return getBotRow(slug) ? { botId: slug } : null;
}

/** What Hermes is offered when it connects: the bot's tools (toolsFor), which the settings hash in engine.ts covers. */
const listTools = (botId: string) => toolsFor(botId).map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) }));

async function callTool(botId: string, rawName: string, rawArgs: unknown, signal?: AbortSignal): Promise<CallResult> {
  const bot = getBotRow(botId);
  if (!bot) return text('The team app has no bot for this agent any more.', true);
  const userId: string = bot.user_id;
  // Read before the wait below, during which the bot could be deleted.
  const current = conversation(botId, bot.generation);
  const name = [...toolMap.keys()].find((k) => k.toLowerCase() === rawName.toLowerCase()) ?? rawName;
  // The tool row the running chat turn made for this call, if the call is that turn's.
  const claim = await claimToolRow(botId, name);
  if (claim && rawArgs && typeof rawArgs === 'object') claim.transcript.noteArgs(claim.seq, rawArgs);
  const report = (status: 'done' | 'error', summary?: string) => claim?.transcript.noteOutcome(claim.seq, { status, summary });
  // A call no chat turn claimed came from elsewhere: the bot's voice call if it is on one (or, rarely,
  // Hermes' CLI while it is), or its answer to a teammate's question (agent/asks.ts), which counts how
  // deep in a chain of questions it is. Tools that write into the chat mark their rows with the call.
  const callId = claim ? undefined : liveCallOf(botId) ?? undefined;
  const ctx: ToolCtx = {
    userId, botId, workspaceId: bot.workspace_id, convo: claim?.transcript.convo ?? current, callId, enqueueBotMessage, wake, addTeammate, updatePersona, setModel, modelOffers,
    depth: turnDepth(botId), asking: claim ? 0 : askDepth(botId),
    // Hermes dropping the call, or the chat turn it belongs to being stopped.
    signal: AbortSignal.any([...(signal ? [signal] : []), ...(claim ? [claim.signal] : [])]),
  };
  const own = toolMap.get(name);
  if (!own) {
    report('error', 'Unknown tool');
    return text(`Unknown tool: ${rawName}`, true);
  }
  try {
    const r = await runTool(own, rawArgs, ctx);
    if (r.invalid) {
      report('error', r.summary);
      return text(r.output, true);
    }
    // Only the chat turn the call belongs to ends; a call from a voice call leaves a chat turn alone.
    if (r.endTurn) claim?.transcript.silence();
    report('done', r.summary);
    return text(r.output);
  } catch (e) {
    const msg = errorText(e);
    report('error', msg.slice(0, 200));
    return text(`Tool error: ${msg}`, true);
  }
}

type RpcId = string | number;
const rpcError = (id: RpcId | null | undefined, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// JSON-RPC 2.0, as the engines' MCP clients send it. Each method's params are checked where it reads them.
const RpcIdSchema = z.union([z.string(), z.number()]);
const RpcRequest = z.object({ jsonrpc: z.literal('2.0'), id: RpcIdSchema.nullish(), method: z.string(), params: z.unknown().optional() });
const InitializeParams = z.object({ protocolVersion: z.string() });
const CallParams = z.object({ name: z.string().min(1), arguments: z.unknown().optional() });

/** Answer one JSON-RPC message; null for notifications (they get no answer). */
async function handle(msg: unknown, botId: string, signal?: AbortSignal): Promise<object | null> {
  const req = RpcRequest.safeParse(msg);
  if (!req.success) {
    // A response to something we never asked; nothing to do with it.
    if (typeof msg === 'object' && msg !== null && ('result' in msg || 'error' in msg)) return null;
    return rpcError(z.object({ id: RpcIdSchema }).safeParse(msg).data?.id, -32600, 'Invalid request');
  }
  const { id, method, params } = req.data;
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = InitializeParams.safeParse(params).data?.protocolVersion ?? '';
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dispatch', title: 'Team app', version: '1.0.0' },
          instructions: 'Tools of the team app: files for the user, routines, other agents on the team.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: listTools(botId) } };
    case 'tools/call': {
      const call = CallParams.safeParse(params);
      if (!call.success) return rpcError(id, -32602, 'Missing tool name');
      // The tool checks its arguments against its own schema (runTool); none at all is an empty object.
      const args = call.data.arguments;
      return { jsonrpc: '2.0', id, result: await callTool(botId, call.data.name, args && typeof args === 'object' ? args : {}, signal) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const mcpApi = new Hono();

mcpApi.post('/:bot', async (c) => {
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handle(m, who.botId, c.req.raw.signal)))).filter(Boolean);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handle(body, who.botId, c.req.raw.signal);
  return answer ? c.json(answer) : c.body(null, 202);
});

// No server-to-client stream and no sessions to end.
mcpApi.all('/:bot', (c) => c.body(null, 405, { Allow: 'POST' }));
