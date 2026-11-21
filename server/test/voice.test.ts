import { beforeAll, expect, test, vi } from 'vitest';

// Starting a call wakes the bot's gateway and screen and asks the speech service for its voices: none of that here.
vi.mock('../src/speech.js', async (orig) => ({
  ...(await orig<typeof import('../src/speech.js')>()),
  voiceCatalog: async () => ({ defaultVoice: 'harper', speed: { min: 0.86, max: 1.27 }, voices: [{ id: 'harper', name: 'Harper' }] }),
}));
vi.mock('../src/engine.js', async (orig) => ({ ...(await orig<typeof import('../src/engine.js')>()), engineFor: async () => ({ url: 'http://engine.test', key: 'k', home: '/nonexistent' }) }));
vi.mock('../src/computer.js', async (orig) => ({ ...(await orig<typeof import('../src/computer.js')>()), screenForWork: async () => {} }));

const { createApp } = await import('../src/app.js');
const { mapVoice } = await import('../src/speech.js');
const { clearConversation, listRows } = await import('../src/store.js');
const { json, seedBot, seedOwner } = await import('./helpers.js');
const { browserName, dropCalls, echoSeconds } = await import('../src/voice.js');

const app = createApp();
let userId: string;
beforeAll(() => { userId = seedOwner().id; });

// The bot's gateway, for the summary a call gets when it ends: a run that answers with two lines.
const hermesCalls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
  const { pathname } = new URL(url);
  hermesCalls.push({ method: init?.method ?? 'GET', path: pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (pathname === '/v1/runs') return Response.json({ run_id: 'run_1', status: 'started' });
  if (pathname === '/v1/runs/run_1/events') {
    return new Response(`data: ${JSON.stringify({ event: 'run.completed', output: 'Tokyo weather check\nAsked about the weather in Tokyo.' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response('not found', { status: 404 });
});

const events = (botId: string) => listRows(botId).flatMap((r) => (r.body.type === 'event' && r.body.call ? [`${r.body.call.phase}${r.body.call.transcript ? ` (${r.body.call.transcript.length} lines)` : ''}`] : []));

test('a call writes a start row, and its end row with the transcript when it hangs up', async () => {
  const bot = seedBot(userId, { name: 'Vee' });
  const { callId } = (await (await app.request('/api/voice/session', json({ botId: bot.id }))).json()) as { callId: string };
  expect(events(bot.id)).toEqual(['started']);
  const end = await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }] }));
  expect(((await end.json()) as { seq?: number }).seq).toBeTypeOf('number');
  expect(events(bot.id)).toEqual(['started', 'ended (2 lines)']);
  // A second /end (the beacon after the button) is a no-op.
  const again = await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [] }));
  expect(await again.json()).toMatchObject({ duplicate: true });
});

test('a call the server lost in a restart still ends with its record and transcript, once', async () => {
  const bot = seedBot(userId, { name: 'Rae' });
  const { callId } = (await (await app.request('/api/voice/session', json({ botId: bot.id }))).json()) as { callId: string };
  dropCalls(bot.id); // all a restart leaves of the calls in memory
  const end = await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }] }));
  expect(((await end.json()) as { seq?: number }).seq).toBeTypeOf('number');
  expect(events(bot.id)).toEqual(['started', 'ended (2 lines)']);
  const again = await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [] }));
  expect(await again.json()).toMatchObject({ duplicate: true });
  // A call nobody started is no call.
  const made = await app.request('/api/voice/end', json({ botId: bot.id, callId: 'call_never', transcript: [] }));
  expect(await made.json()).toMatchObject({ duplicate: true });
  expect(events(bot.id)).toEqual(['started', 'ended (2 lines)']);
});

test("the bot's own agent titles and summarises a call when it ends, on a session beside the call's", async () => {
  const bot = seedBot(userId, { name: 'Tia' });
  const { callId } = (await (await app.request('/api/voice/session', json({ botId: bot.id }))).json()) as { callId: string };
  hermesCalls.length = 0;
  await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [{ role: 'user', text: 'Weather in Tokyo?' }, { role: 'assistant', text: 'Sunny.' }] }));
  const ended = () => listRows(bot.id).find((r) => r.body.type === 'event' && r.body.call?.phase === 'ended')!.body;
  await vi.waitFor(() => expect(ended()).toMatchObject({ call: { title: 'Tokyo weather check', summary: 'Asked about the weather in Tokyo.' } }), { timeout: 5000 });
  const run = hermesCalls.find((c) => c.path === '/v1/runs')!.body!;
  expect(run).toMatchObject({ model: 'hermes-agent', session_id: `dispatch-${bot.id}-${callId}-summary` });
  expect(run.input).toContain('User: Weather in Tokyo?\nTia: Sunny.');
});

test('a call that spans a New chat keeps its record in the chat the user has open', async () => {
  const bot = seedBot(userId, { name: 'Wes' });
  const { callId } = (await (await app.request('/api/voice/session', json({ botId: bot.id }))).json()) as { callId: string };
  clearConversation(bot.id);
  await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [{ role: 'user', text: 'Hi' }] }));
  expect(events(bot.id)).toEqual(['ended (1 lines)']);
});

test('post_to_chat on a call puts a message in the chat marked with that call; without a call, unmarked', async () => {
  const { claimCall } = await import('../src/voice.js');
  const { mcpToken } = await import('../src/engine.js');
  const bot = seedBot(userId, { name: 'Pat' });
  const post = (text: string) => app.request(`/mcp/${bot.id}`, {
    method: 'POST', headers: { authorization: `Bearer ${mcpToken(bot.id)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_to_chat', arguments: { text } } }),
  });
  const posts = () => listRows(bot.id).flatMap((r) => (r.body.type === 'message' ? [[r.body.text, r.body.call ?? null]] : []));
  const { callId } = (await (await app.request('/api/voice/session', json({ botId: bot.id }))).json()) as { callId: string };
  expect(claimCall(callId, userId)).not.toBeNull(); // the relay's socket connected
  expect(await (await post('https://example.com/a')).json()).toMatchObject({ result: { content: [{ text: "Posted in the chat. Tell the user it's there; don't read it out." }] } });
  await app.request('/api/voice/end', json({ botId: bot.id, callId, transcript: [] }));
  await post('https://example.com/b');
  expect(posts()).toEqual([['https://example.com/a', callId], ['https://example.com/b', null]]);
});

test('a voice the speech service does not list reads as its default', () => {
  const phonon = { defaultVoice: 'harper', speed: { min: 0.86, max: 1.27 }, voices: ['harper', 'edwin', 'hugh', 'preston'].map((id) => ({ id, name: id })) };
  expect(mapVoice('preston', phonon)).toBe('preston');
  expect(mapVoice('an-old-voice', phonon)).toBe('harper');
  expect(mapVoice(undefined, phonon)).toBe('harper');
  // Before the service has answered, a stored voice passes through.
  expect(mapVoice('edwin', null)).toBe('edwin');
  expect(mapVoice('', null)).toBe('harper');
});

test('browserName names the browser a call came from, for the log', () => {
  expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15')).toBe('Safari');
  expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox');
  expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome');
  expect(browserName(undefined)).toBe('unknown browser');
});

test('echoSeconds writes a call\'s echo log in a line, latency only when it changes', () => {
  expect(echoSeconds([[12, -24, -33, -71, 84, 0, 42], [13, -26, -35, -70, 85, 0, 42], [14, -25, -34, -12, null, 3, 61]]))
    .toBe('12s -24/-33/-71 d84 out42, 13s -26/-35/-70 d85, 14s -25/-34/-12 gap3 out61');
  expect(echoSeconds([[0, -30, -40, -70, null, 0, null]])).toBe('0s -30/-40/-70');
});
