// How a turn turns the events of a Hermes run into rows and live state. These pin the chat's behaviour:
// what shows as a message, what stays a note, what a tool row says, what the status line shows, and
// how Hermes' approval prompts become cards.
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { MessageBody, Row, ToolCallBody } from '../src/types.js';
import { ev, fakeHermes, gate } from './hermes.js';

vi.mock('../src/computer.js', async (orig) => ({
  ...(await orig<typeof import('../src/computer.js')>()),
  screenForWork: async () => {},
}));
vi.mock('../src/engine.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine.js')>()),
  engineFor: async () => ({ url: 'http://engine.test', key: 'k', home: '/nonexistent' }),
  gatewayIfRunning: () => ({ url: 'http://engine.test', key: 'k', home: '/nonexistent' }),
}));

const loop = await import('../src/agent/turns.js');
const live = await import('../src/agent/live.js');
const store = await import('../src/store.js');
const { seedBot, seedOwner } = await import('./helpers.js');
const { db } = await import('../src/db.js');
const { hub } = await import('../src/lib/hub.js');
const approvals = await import('../src/agent/approvals.js');

let userId: string;
beforeAll(() => { userId = seedOwner().id; });
afterEach(() => { vi.unstubAllGlobals(); });

/** Runs one user turn against a script and waits until the bot is idle again. */
async function turn(script: Parameters<typeof fakeHermes>[0], text = 'hi') {
  const bot = seedBot(userId);
  fakeHermes(script);
  loop.enqueue(bot.id, { type: 'user', text });
  await loop.whenIdle(bot.id);
  return bot.id;
}

const rows = (botId: string) => store.listRows(botId);
const msg = (r: Row) => r.body as MessageBody;
const tool = (r: Row) => r.body as ToolCallBody;
const unread = (botId: string) => store.requireBot(botId).unread;

describe('messages', () => {
  test('streamed text becomes one finished message and one unread', async () => {
    const id = await turn([ev.text('\n\nHello'), ev.text(' there'), ev.completed('Hello there')]);
    expect(rows(id).map((r) => msg(r))).toEqual([{ type: 'message', role: 'assistant', text: 'Hello there', streaming: false }]);
    expect(unread(id)).toBe(1);
  });

  test('a final answer that never streamed comes whole with the end of the run', async () => {
    const id = await turn([ev.completed('All done.')]);
    expect(rows(id).map((r) => msg(r).text)).toEqual(['All done.']);
    expect(unread(id)).toBe(1);
  });

  test('text followed by a tool call is a note to itself, not a message', async () => {
    const id = await turn([
      ev.text('Let me check the file.'),
      ev.toolCall('read_file', 'c1', '/x'),
      ev.toolDone('c1'),
      ev.text('The file says x.'),
      ev.completed('The file says x.'),
    ]);
    expect(rows(id).map((r) => [r.kind, r.body.type === 'message' ? [msg(r).text, !!msg(r).note] : tool(r).status])).toEqual([
      ['message', ['Let me check the file.', true]],
      ['tool-call', 'done'],
      ['message', ['The file says x.', false]],
    ]);
    expect(unread(id)).toBe(1);
  });

  test('commentary that arrives whole is a note', async () => {
    const id = await turn([ev.interim('Thinking about it.'), ev.toolCall('todo', 'c1'), ev.toolDone('c1'), ev.completed('Done.')]);
    expect(rows(id).map((r) => (r.body.type === 'message' ? [msg(r).text, !!msg(r).note] : r.kind))).toEqual([
      ['Thinking about it.', true],
      'tool-call',
      ['Done.', false],
    ]);
  });

  test('streamed commentary followed by a whole final answer shows both, the final as the message', async () => {
    const id = await turn([ev.text('Checking.'), ev.interim('Checking.', true), ev.completed('Here it is.')]);
    expect(rows(id).map((r) => [msg(r).text, !!msg(r).note])).toEqual([['Checking.', true], ['Here it is.', false]]);
  });

  test("streamed commentary a tool call already closed as a note isn't noted again", async () => {
    const id = await turn([ev.text('Let me look.'), ev.toolCall('todo', 'c1'), ev.interim('Let me look.', true), ev.toolDone('c1'), ev.text('Found it.'), ev.completed('Found it.')]);
    expect(rows(id).filter((r) => r.kind === 'message').map((r) => [msg(r).text, !!msg(r).note])).toEqual([['Let me look.', true], ['Found it.', false]]);
  });

  test.each([['Found it: 42.'], ['']])('a turn that only thought aloud answers with its last note (run output %j)', async (output) => {
    const id = await turn([ev.text('First I look.'), ev.toolCall('todo', 'c1'), ev.toolDone('c1'), ev.text('Found it: 42.'), ev.toolCall('todo', 'c2'), ev.toolDone('c2'), ev.completed(output)]);
    const messages = rows(id).filter((r) => r.kind === 'message');
    expect(messages.map((r) => [msg(r).text, !!msg(r).note])).toEqual([['First I look.', true], ['Found it: 42.', false]]);
    expect(unread(id)).toBe(1);
  });

  test('long text shows while it streams; short text waits', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    fakeHermes([ev.text('Short.'), hold.opened, ev.text(` ${'x'.repeat(150)}`), ev.completed('done')]);
    const seen: Row[] = [];
    const off = hub.subscribe(userId, (e) => { if (e.type === 'rows' && e.botId === bot.id) seen.push(...e.rows); });
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await vi.waitFor(() => expect(live.getLive(bot.id).isRunning).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.filter((r) => r.kind === 'message')).toEqual([]);
    hold.open();
    await loop.whenIdle(bot.id);
    off();
    expect(seen.some((r) => r.kind === 'message' && msg(r).streaming)).toBe(true);
    expect(msg(rows(bot.id)[0]).streaming).toBe(false);
  });
});

describe('tools', () => {
  test('a tool row says what the tool is doing and how it went', async () => {
    const id = await turn([
      ev.toolCall('terminal', 'c1', 'false'),
      ev.toolDone('c1', { error: true, preview: '{"exit_code": 2, "output": ""}' }),
      ev.toolCall('web_search', 'c2', 'x'),
      ev.toolDone('c2', { error: true, preview: '{"error": "no backend"}' }),
      ev.toolCall('read_file', 'c3', '/x'),
      ev.toolDone('c3', { error: true }),
      ev.toolCall('mcp_dispatch_save_file', 'c4', 'a.md'),
      ev.toolDone('c4'),
      ev.completed('Done.'),
    ]);
    expect(rows(id).filter((r) => r.kind === 'tool-call').map((r) => {
      const t = tool(r);
      return [t.name, t.label, t.status, t.summary];
    })).toEqual([
      ['terminal', 'Running commands', 'error', 'Exit code 2'],
      ['web_search', 'Searching the web', 'error', 'no backend'],
      ['read_file', 'Reading files', 'error', undefined],
      ['save_file', 'Saving a file', 'done', undefined],
    ]);
  });

  test("Hermes looking through its own toolbox makes no row", async () => {
    const id = await turn([ev.toolCall('tool_search', 'c1'), ev.toolDone('c1'), ev.completed('Done.')]);
    expect(rows(id).map((r) => r.kind)).toEqual(['message']);
  });

  test('a tool still running when the run ends is marked done', async () => {
    const id = await turn([ev.toolCall('terminal', 'c1'), ev.completed('Started it.')]);
    expect(tool(rows(id)[0]).status).toBe('done');
  });

  test("an app tool's own outcome beats the guess from its output", async () => {
    const bot = seedBot(userId);
    const called = gate();
    const answered = gate();
    fakeHermes([ev.toolCall('mcp_dispatch_create_routine', 'c1'), called.opened, answered.opened, ev.toolDone('c1', { error: true }), ev.completed('ok')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await vi.waitFor(() => expect(rows(bot.id).length).toBe(1));
    called.open();
    const claim = await loop.claimToolRow(bot.id, 'create_routine');
    expect(claim).not.toBeNull();
    // The run's events carry no arguments; the app's call does.
    claim!.transcript.noteArgs(claim!.seq, { name: 't' });
    claim!.transcript.noteOutcome(claim!.seq, { status: 'done', summary: 'Made a routine' });
    answered.open();
    await loop.whenIdle(bot.id);
    expect(tool(rows(bot.id)[0])).toMatchObject({ status: 'done', summary: 'Made a routine', args: { name: 't' } });
  });
});

describe('live state', () => {
  test('running while the turn runs, idle after, with captions', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    fakeHermes([ev.reasoning('I should look this up. Then '), hold.opened, ev.toolCall('web_search', 'c1'), ev.toolDone('c1'), ev.completed('Found nothing.')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await vi.waitFor(() => expect(live.getLive(bot.id).caption).toBe('I should look this up.'));
    expect(live.getLive(bot.id)).toMatchObject({ isRunning: true, activity: { kind: 'thinking' } });
    hold.open();
    await loop.whenIdle(bot.id);
    expect(live.getLive(bot.id)).toEqual({ botId: bot.id, isRunning: false, activity: null, startedAt: null, caption: null });
  });
});

describe('endings', () => {
  test('a failed run leaves a notice and marks unfinished tools', async () => {
    const id = await turn([ev.toolCall('terminal', 'c1'), ev.failed('model overloaded')]);
    expect(rows(id).map((r) => r.body)).toEqual([
      expect.objectContaining({ type: 'tool-call', status: 'error', summary: 'Did not finish' }),
      { type: 'notice', text: 'Something went wrong: model overloaded', tone: 'error' },
    ]);
    expect(live.getLive(id).isRunning).toBe(false);
  });

  test('a run whose events stop with no end failed: the gateway may be gone, and the run is stopped', async () => {
    // What a gateway killed for running out of memory leaves: a stream that just stops.
    const bot = seedBot(userId);
    const hermes = fakeHermes([ev.toolCall('terminal', 'c1'), ev.text('Half of an answ')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => r.body)).toEqual([
      expect.objectContaining({ type: 'tool-call', status: 'error', summary: 'Did not finish' }),
      expect.objectContaining({ type: 'message', text: 'Half of an answ' }),
      { type: 'notice', text: 'Something went wrong: the agent stopped answering before it finished; its gateway may have restarted or run out of memory', tone: 'error' },
    ]);
    // Hermes still had it as running: nobody can follow it now.
    await vi.waitFor(() => expect(hermes.calls).toContainEqual({ method: 'POST', path: '/v1/runs/run_1/stop', body: {} }));
  });

  test('a stream that breaks after the run finished still shows its whole answer', async () => {
    const bot = seedBot(userId);
    const hermes = fakeHermes([ev.text('The answer is'), ev.toolCall('todo', 'c1')]);
    hermes.states.set('run_1', { status: 'completed', output: 'The answer is 42.' });
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => (r.body.type === 'message' ? [msg(r).text, !!msg(r).note] : tool(r).status))).toEqual([['The answer is', true], 'done', ['The answer is 42.', false]]);
    expect(hermes.calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
  });

  test('a stream cut short mid-answer is completed from what Hermes kept', async () => {
    const bot = seedBot(userId);
    const hermes = fakeHermes([ev.text('The answer')]);
    hermes.states.set('run_1', { status: 'completed', output: 'The answer is 42.' });
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => msg(r))).toEqual([{ type: 'message', role: 'assistant', text: 'The answer is 42.', streaming: false }]);
  });

  test('Stop ends the turn with a quiet notice, stops its tools and asks Hermes to stop the run', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    const hermes = fakeHermes([ev.toolCall('terminal', 'c1'), hold.opened, ev.completed('never')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await vi.waitFor(() => expect(rows(bot.id).length).toBe(1));
    loop.interrupt(bot.id);
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => r.body)).toEqual([
      expect.objectContaining({ type: 'tool-call', status: 'error', summary: 'Stopped' }),
      { type: 'notice', text: 'Stopped.', tone: 'info' },
    ]);
    await vi.waitFor(() => expect(hermes.calls).toContainEqual({ method: 'POST', path: '/v1/runs/run_1/stop', body: {} }));
  });

  test('a turn-ending tool (ask_user) drops the closing text', async () => {
    const bot = seedBot(userId);
    const called = gate();
    fakeHermes([ev.toolCall('mcp_dispatch_ask_user', 'c1'), called.opened, ev.toolDone('c1'), ev.text('I asked you.'), ev.completed('I asked you.')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await vi.waitFor(() => expect(rows(bot.id).length).toBe(1));
    const claim = await loop.claimToolRow(bot.id, 'ask_user');
    claim!.transcript.silence();
    claim!.transcript.noteOutcome(claim!.seq, { status: 'done' });
    called.open();
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => r.kind)).toEqual(['tool-call']);
  });

  test('turns of one bot run one after another, in order', async () => {
    const bot = seedBot(userId);
    const requests = fakeHermes([ev.completed('one')], [ev.completed('two')]);
    loop.enqueue(bot.id, { type: 'user', text: 'a' });
    loop.enqueue(bot.id, { type: 'user', text: 'b' });
    await loop.whenIdle(bot.id);
    expect(requests.map((r) => r.input)).toEqual(['a', 'b']);
    expect(rows(bot.id).map((r) => msg(r).text)).toEqual(['one', 'two']);
  });

  test('a routine still running or queued is not queued again; other turns are', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    const requests = fakeHermes([hold.opened, ev.completed('one')], [ev.completed('two')], [ev.completed('three')]);
    const daily = { type: 'routine', routineId: 'rt_1', name: 'Daily', prompt: 'Do it' } as const;
    expect(loop.enqueue(bot.id, daily)).toBe(true);
    await vi.waitFor(() => expect(requests.length).toBe(1));
    // Running: a second firing is skipped.
    expect(loop.enqueue(bot.id, daily)).toBe(false);
    expect(loop.enqueue(bot.id, { type: 'user', text: 'hi' })).toBe(true);
    expect(loop.enqueue(bot.id, { ...daily, routineId: 'rt_2' })).toBe(true);
    // Queued: skipped too.
    expect(loop.enqueue(bot.id, { ...daily, routineId: 'rt_2' })).toBe(false);
    hold.open();
    await loop.whenIdle(bot.id);
    expect(requests.map((r) => r.input)).toEqual(['[Routine "Daily" is running now. Do this:]\nDo it', 'hi', '[Routine "Daily" is running now. Do this:]\nDo it']);
    // Finished: it runs again.
    fakeHermes([ev.completed('again')]);
    expect(loop.enqueue(bot.id, daily)).toBe(true);
    await loop.whenIdle(bot.id);
  });

  test("the run carries the conversation's session, model choice and effort", async () => {
    const bot = seedBot(userId);
    db.prepare("UPDATE bots SET model='m1', provider='p1', effort='high' WHERE id=?").run(bot.id);
    const requests = fakeHermes([ev.completed('ok')]);
    loop.enqueue(bot.id, { type: 'routine', routineId: 'rt_1', name: 'Daily', prompt: 'Do it' });
    await loop.whenIdle(bot.id);
    expect(requests[0]).toMatchObject({
      model: 'm1', provider: 'p1', session_id: `dispatch-${bot.id}-g1`,
      model_options: { reasoning_effort: 'high' }, input: '[Routine "Daily" is running now. Do this:]\nDo it',
    });
  });
});

describe('voice calls', () => {
  /** A call that ended in the bot's chat, after posting a link there. */
  function callHappened(botId: string, id = 'call_x') {
    store.appendRow(botId, 'message', { type: 'message', role: 'assistant', text: 'https://example.com/table', call: id });
    store.appendRow(botId, 'event', {
      type: 'event', event: 'voice-call', text: 'Voice call ended · 1m 05s', ref: id,
      call: { id, phase: 'ended', durationMs: 65_000, transcript: [{ role: 'user', text: 'Book a table for seven' }, { role: 'assistant', text: 'Booked. The link is in the chat.' }] },
    });
  }

  test('the next turn hears about a call that ended, once', async () => {
    const bot = seedBot(userId);
    callHappened(bot.id);
    const requests = fakeHermes([ev.completed('ok')], [ev.completed('ok')]);
    loop.enqueue(bot.id, { type: 'user', text: 'thanks' });
    loop.enqueue(bot.id, { type: 'user', text: 'and again' });
    await loop.whenIdle(bot.id);
    const input = String(requests[0].input);
    expect(input).toMatch(/^\[Note from the app: since your last turn here, tess talked with you on a voice call\./);
    expect(input).toContain('Voice call, 1m 05s, ended just now:\ntess: Book a table for seven\nYou: Booked. The link is in the chat.\nYou posted in this chat during the call:\nhttps://example.com/table]');
    expect(input.endsWith(']\n\nthanks')).toBe(true);
    expect(requests[1].input).toBe('and again');
  });

  test('news a turn never got to Hermes with waits for the next turn', async () => {
    const bot = seedBot(userId);
    callHappened(bot.id);
    fakeHermes([ev.completed('ok')]);
    const hermes = globalThis.fetch;
    const inputs: string[] = [];
    // The gateway refuses the first run.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (new URL(url).pathname !== '/v1/runs') return hermes(url, init);
      inputs.push(String(JSON.parse(String(init.body)).input));
      return inputs.length === 1 ? new Response('gateway down', { status: 502 }) : hermes(url, init);
    });
    loop.enqueue(bot.id, { type: 'user', text: 'one' });
    loop.enqueue(bot.id, { type: 'user', text: 'two' });
    await loop.whenIdle(bot.id);
    expect(inputs.map((i) => i.includes('Book a table'))).toEqual([true, true]);
  });

  test('after New chat, a call recorded in the new chat is news to it', async () => {
    const bot = seedBot(userId);
    fakeHermes([ev.completed('ok')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await loop.whenIdle(bot.id);
    store.clearConversation(bot.id);
    callHappened(bot.id);
    const requests = fakeHermes([ev.completed('ok')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hello' });
    await loop.whenIdle(bot.id);
    expect(String(requests[0].input)).toContain('tess: Book a table for seven');
  });
});

describe('the runner', () => {
  test('Stop ends the running turn; the ones queued behind it still run', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    const requests = fakeHermes([hold.opened, ev.completed('never')], [ev.completed('second')]);
    loop.enqueue(bot.id, { type: 'user', text: 'a' });
    loop.enqueue(bot.id, { type: 'user', text: 'b' });
    await vi.waitFor(() => expect(requests.length).toBe(1));
    loop.interrupt(bot.id);
    await loop.whenIdle(bot.id);
    expect(requests.map((r) => r.input)).toEqual(['a', 'b']);
    expect(rows(bot.id).map((r) => r.body.type === 'message' ? msg(r).text : r.body.type)).toEqual(['notice', 'second']);
  });

  test('"New chat" drops the running and queued turns, and nothing of them shows in the new chat', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    const requests = fakeHermes([ev.text('x'.repeat(200)), hold.opened, ev.completed('never')], [ev.completed('queued')]);
    loop.enqueue(bot.id, { type: 'user', text: 'a' });
    loop.enqueue(bot.id, { type: 'user', text: 'b' });
    await vi.waitFor(() => expect(rows(bot.id).length).toBe(1));
    loop.clear(bot.id);
    store.clearConversation(bot.id);
    await loop.whenIdle(bot.id);
    expect(requests.length).toBe(1);
    expect(rows(bot.id)).toEqual([]);
    expect(unread(bot.id)).toBe(0);
    // The old chat's message was still closed off, in the old chat.
    expect(store.getRow({ botId: bot.id, generation: 1, seq: 1 })?.body).toMatchObject({ streaming: false });
  });

  test('a turn queued before "New chat" is skipped, and later turns use the new conversation', async () => {
    const bot = seedBot(userId);
    store.clearConversation(bot.id);
    const requests = fakeHermes([ev.completed('hello')]);
    loop.enqueue(bot.id, { type: 'user', text: 'new' });
    await loop.whenIdle(bot.id);
    expect(requests[0]).toMatchObject({ session_id: `dispatch-${bot.id}-g2` });
  });

  test('a tool call that is not the turn\'s claims nothing', async () => {
    const bot = seedBot(userId);
    expect(await loop.claimToolRow(bot.id, 'ask_user')).toBeNull();
    const hold = gate();
    fakeHermes([ev.toolCall('mcp_dispatch_create_routine', 'c1'), hold.opened, ev.toolDone('c1'), ev.completed('Done.')]);
    loop.enqueue(bot.id, { type: 'user', text: 'hi' });
    await vi.waitFor(() => expect(rows(bot.id).length).toBe(1));
    // Same bot, another tool (say, ask_user on a voice call): no row of this turn is that tool's.
    expect(await loop.claimToolRow(bot.id, 'ask_user')).toBeNull();
    hold.open();
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => r.kind)).toEqual(['tool-call', 'message']);
  });

  test('deleting a bot mid-turn leaves nothing running', async () => {
    const hold = gate();
    const bot = seedBot(userId);
    fakeHermes([ev.text('x'.repeat(200)), hold.opened]);
    loop.enqueue(bot.id, { type: 'user', text: 'a' });
    await vi.waitFor(() => expect(live.getLive(bot.id).isRunning).toBe(true));
    loop.clear(bot.id);
    db.prepare('DELETE FROM bots WHERE id=?').run(bot.id);
    await loop.whenIdle(bot.id);
    expect(live.getLive(bot.id).isRunning).toBe(false);
  });
});

describe('chats from before runs', () => {
  /** A chat as the Responses API left it: a question answered, then a new message. */
  function oldChat() {
    const bot = seedBot(userId);
    store.appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'What is 2+2?' });
    store.appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'Thinking.', note: true });
    store.appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: '4.' });
    store.appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'And 3+3?' });
    return bot;
  }

  test("the first run starts the chat's session with what the chat shows", async () => {
    const bot = oldChat();
    const requests = fakeHermes([ev.completed('6.')], [ev.completed('8.')]);
    loop.enqueue(bot.id, { type: 'user', text: 'And 3+3?' });
    await loop.whenIdle(bot.id);
    expect(requests[0].input).toBe('[Earlier in this chat (your tool calls are not shown):]\nUser: What is 2+2?\n\nYou: 4.\n[End of the earlier chat. The new message follows.]\n\nAnd 3+3?');
    // From then on the session has the history.
    store.appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'And 4+4?' });
    loop.enqueue(bot.id, { type: 'user', text: 'And 4+4?' });
    await loop.whenIdle(bot.id);
    expect(requests[1].input).toBe('And 4+4?');
  });

  test('a chat whose session Hermes has gets no recap, and a new chat asks nothing', async () => {
    const bot = oldChat();
    const hermes = fakeHermes([ev.completed('6.')]);
    hermes.sessions.add(`dispatch-${bot.id}-g1`);
    loop.enqueue(bot.id, { type: 'user', text: 'And 3+3?' });
    await loop.whenIdle(bot.id);
    expect(hermes[0].input).toBe('And 3+3?');

    const fresh = seedBot(userId);
    const next = fakeHermes([ev.completed('hi')]);
    loop.enqueue(fresh.id, { type: 'user', text: 'hello' });
    await loop.whenIdle(fresh.id);
    expect(next.calls.map((c) => c.path)).toEqual(['/v1/runs', '/v1/runs/run_1/events']);
  });
});

describe("Hermes' approval prompts", () => {
  const card = (botId: string) => rows(botId).find((r) => r.kind === 'card')?.body as Extract<Row['body'], { card: 'approval' }> | undefined;

  /** A turn whose command Hermes asks about, held at the prompt until the test opens `after`; then the command `ran` or failed. */
  async function asking(ran: boolean) {
    const after = gate();
    const bot = seedBot(userId);
    const hermes = fakeHermes([ev.text('I will clean up.'), ev.toolCall('terminal', 'c1', 'rm -rf /tmp/x'), ev.approval('p1'), after.opened, ev.toolDone('c1', { error: !ran }), ev.completed('Done.')]);
    loop.enqueue(bot.id, { type: 'user', text: 'clean up' });
    await vi.waitFor(() => expect(card(bot.id)).toBeDefined());
    return { bot, hermes, after };
  }

  test('a prompt shows a card, the tool waits, and Allow lets the run carry on', async () => {
    const { bot, hermes, after } = await asking(true);
    expect(card(bot.id)).toMatchObject({
      title: 'Delete in root path', command: 'rm -rf /tmp/x', tool: 'terminal', label: 'Running commands',
      choices: ['once', 'always', 'deny'], status: 'pending',
    });
    expect(tool(rows(bot.id).find((r) => r.kind === 'tool-call')!).status).toBe('awaiting-approval');
    expect(live.getLive(bot.id).activity?.kind).toBe('waiting_for_you');

    await approvals.answerApproval(userId, card(bot.id)!.approvalId, 'once');
    expect(hermes.calls).toContainEqual({ method: 'POST', path: '/v1/runs/run_1/approval', body: { request_id: 'p1', execution_generation: 1, choice: 'once' } });
    expect(card(bot.id)!.status).toBe('allowed');
    expect(tool(rows(bot.id).find((r) => r.kind === 'tool-call')!).status).toBe('running');
    expect(live.getLive(bot.id).activity?.kind).toBe('running_commands');
    after.open();
    await loop.whenIdle(bot.id);
    expect(tool(rows(bot.id).find((r) => r.kind === 'tool-call')!).status).toBe('done');
    await expect(approvals.answerApproval(userId, card(bot.id)!.approvalId, 'once')).rejects.toThrow('already answered');
  });

  test("Don't allow turns the tool down", async () => {
    const { bot, after } = await asking(false);
    await approvals.answerApproval(userId, card(bot.id)!.approvalId, 'deny');
    after.open();
    await loop.whenIdle(bot.id);
    expect(card(bot.id)!.status).toBe('denied');
    expect(tool(rows(bot.id).find((r) => r.kind === 'tool-call')!).status).toBe('denied');
  });

  test('a prompt Hermes gave up on expires once the run moves on, and can no longer be answered', async () => {
    const { bot, hermes, after } = await asking(false);
    hermes.expire('p1');
    after.open();
    await loop.whenIdle(bot.id);
    expect(card(bot.id)!.status).toBe('expired');
    await expect(approvals.answerApproval(userId, card(bot.id)!.approvalId, 'once')).rejects.toThrow('expired');
    expect(hermes.calls.some((c) => c.path.endsWith('/approval'))).toBe(false);
  });

  test('stopping the turn expires its prompt', async () => {
    const { bot } = await asking(false);
    loop.interrupt(bot.id);
    await loop.whenIdle(bot.id);
    expect(card(bot.id)!.status).toBe('expired');
  });

  test('a prompt that offers no lasting answer shows only Allow and Don\'t allow', async () => {
    const after = gate();
    const bot = seedBot(userId);
    fakeHermes([ev.toolCall('terminal', 'c1'), ev.approval('p1', { choices: ['once', 'deny'], command: '<write to /root/.ssh/config>', description: 'Write to SSH client config file(s): /root/.ssh/config. The SSH config can carry ProxyCommand directives.' }), after.opened, ev.completed('ok')]);
    loop.enqueue(bot.id, { type: 'user', text: 'x' });
    await vi.waitFor(() => expect(card(bot.id)).toBeDefined());
    expect(card(bot.id)).toMatchObject({
      title: 'Write to SSH client config file(s): /root/.ssh/config.', detail: 'The SSH config can carry ProxyCommand directives.', choices: ['once', 'deny'],
    });
    expect(card(bot.id)!.command).toBeUndefined();
    after.open();
    await loop.whenIdle(bot.id);
  });
});

describe('after a restart', () => {
  /** What a server process that stopped mid-turn leaves: the turn in `turns`, its run in `runs`, and the rows it was writing. */
  function leftMidTurn(runId: string) {
    const bot = seedBot(userId);
    store.appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'one' });
    store.appendRow(bot.id, 'tool-call', { type: 'tool-call', callId: 'c1', name: 'terminal', label: 'Running commands', status: 'running' });
    store.appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'The answer', streaming: true });
    const at = Date.now();
    db.prepare("INSERT INTO turns(bot_id,generation,trigger,run_id,created_at) VALUES (?,1,'{\"type\":\"user\",\"text\":\"one\"}',?,?)").run(bot.id, runId, at);
    db.prepare("INSERT INTO runs(id,bot_id,surface,started_at) VALUES (?,?,'chat',?)").run(runId, bot.id, at);
    return bot;
  }
  const left = (botId: string) => [
    db.prepare('SELECT COUNT(*) n FROM turns WHERE bot_id=?').get(botId),
    db.prepare('SELECT COUNT(*) n FROM runs WHERE bot_id=?').get(botId),
  ];

  test('a turn cut short is closed and says so, its run is stopped, and the messages queued behind it run', async () => {
    const bot = leftMidTurn('run_old');
    store.appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'two' });
    db.prepare("INSERT INTO turns(bot_id,generation,trigger,created_at) VALUES (?,1,'{\"type\":\"user\",\"text\":\"two\"}',?)").run(bot.id, Date.now());
    // A voice reply the last process was following: nobody hears it now.
    db.prepare("INSERT INTO runs(id,bot_id,surface,started_at) VALUES ('run_call',?,'voice',?)").run(bot.id, Date.now());
    const hermes = fakeHermes([ev.completed('Two it is.')]);
    hermes.states.set('run_old', { status: 'running' });
    hermes.sessions.add(`dispatch-${bot.id}-g1`); // the cut-short run made it
    hermes.states.set('run_call', { status: 'waiting_for_approval' });

    await loop.resumeTurns();
    await loop.whenIdle(bot.id);
    expect(rows(bot.id).map((r) => r.body)).toEqual([
      expect.objectContaining({ text: 'one' }),
      expect.objectContaining({ type: 'tool-call', status: 'error', summary: 'Interrupted' }),
      { type: 'message', role: 'assistant', text: 'The answer', streaming: false },
      expect.objectContaining({ text: 'two' }),
      { type: 'notice', text: 'Interrupted: Dispatch restarted before this was finished.', tone: 'warn' },
      { type: 'message', role: 'assistant', text: 'Two it is.', streaming: false },
    ]);
    expect(hermes.map((r) => r.input)).toEqual(['two']);
    expect(hermes.calls.filter((c) => c.path.endsWith('/stop')).map((c) => c.path).sort()).toEqual(['/v1/runs/run_call/stop', '/v1/runs/run_old/stop']);
    expect(left(bot.id)).toEqual([{ n: 0 }, { n: 0 }]);
  });

  test('a run that finished while the server was down shows its answer', async () => {
    const bot = leftMidTurn('run_done');
    const hermes = fakeHermes();
    hermes.states.set('run_done', { status: 'completed', output: 'The answer is 42.' });
    await loop.resumeTurns();
    expect(rows(bot.id).slice(1).map((r) => r.body)).toEqual([
      expect.objectContaining({ type: 'tool-call', status: 'done' }),
      { type: 'message', role: 'assistant', text: 'The answer is 42.', streaming: false },
    ]);
    expect(unread(bot.id)).toBe(1);
    expect(hermes.calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
  });

  test('a queued turn of a chat cleared since, or that the gateway has forgotten, is dropped quietly', async () => {
    const bot = seedBot(userId);
    db.prepare("INSERT INTO turns(bot_id,generation,trigger,created_at) VALUES (?,1,'{\"type\":\"user\",\"text\":\"old\"}',?)").run(bot.id, Date.now());
    store.clearConversation(bot.id);
    const hermes = fakeHermes();
    await loop.resumeTurns();
    await loop.whenIdle(bot.id);
    expect(hermes.length).toBe(0);
    expect(rows(bot.id)).toEqual([]);
    expect(left(bot.id)).toEqual([{ n: 0 }, { n: 0 }]);
  });

  test('a turn runs and ends with nothing left in turns or runs', async () => {
    const id = await turn([ev.completed('ok')]);
    expect(left(id)).toEqual([{ n: 0 }, { n: 0 }]);
  });
});
