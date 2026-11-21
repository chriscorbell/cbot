// The relay against a fake speech service, browser and gateway: event orders that are hard to hit by hand.
import type { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import type { RelayEvent } from '../src/voice-protocol.js';
import { gate } from './hermes.js';
import type { ChatCursor } from '../src/agent/catchup.js';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class WebSocket extends EventEmitter {
    static OPEN = 1;
    static instances: WebSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    constructor() { super(); WebSocket.instances.push(this); }
    send(d: string | Buffer) { this.sent.push(String(d)); }
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
  }
  return { WebSocket, WebSocketServer: class {} };
});
vi.mock('../src/engine.js', async (orig) => ({ ...(await orig<typeof import('../src/engine.js')>()), engineFor: async () => ({ url: 'http://engine.test', key: 'k', home: '/x' }) }));

const { Relay } = await import('../src/voice-relay.js');
const { WebSocket } = (await import('ws')) as unknown as { WebSocket: { new (): EventEmitter & { sent: string[] }; instances: (EventEmitter & { sent: string[] })[] } };

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * A gateway whose runs stream the events given per run (`event:tool`, or a whole event), whose steer answers when `steered` opens, and whose speech is `ttsBytes` of PCM a sentence.
 * Its stop says the run was still queued. Returns the requests that started runs.
 */
function fakeGateway(runs: Record<string, (string | Promise<unknown> | Record<string, unknown>)[]>, steered: Promise<unknown>, ttsBytes = 480) {
  let n = 0;
  const enc = new TextEncoder();
  const started: { input: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/v1/tts')) return new Response(new Uint8Array(ttsBytes), { status: 200 });
    if (url.endsWith('/v1/runs')) {
      started.push(JSON.parse(String(init.body)));
      return Response.json({ run_id: `run_${++n}` });
    }
    if (url.endsWith('/steer')) { await steered; return new Response('busy', { status: 409 }); }
    if (url.endsWith('/stop')) return Response.json({ status: 'cancelled' });
    if (url.endsWith('/approval')) return Response.json({ status: 'resolved' });
    const id = /\/v1\/runs\/(run_\d+)\/events/.exec(url)?.[1];
    if (id) {
      const script = runs[id] ?? [];
      return new Response(new ReadableStream({
        async start(c) {
          init.signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
          for (const step of script) {
            if (typeof step === 'string') c.enqueue(enc.encode(`data: ${JSON.stringify({ event: step.split(':')[0], tool: step.split(':')[1], tool_call_id: step.split(':')[1] })}\n\n`));
            else if (step instanceof Promise) await step;
            else c.enqueue(enc.encode(`data: ${JSON.stringify(step)}\n\n`));
          }
        },
      }), { status: 200 });
    }
    return new Response('?', { status: 404 });
  });
  return started;
}

test('a steer that fails after a newer reply took the call never leaves two replies running', async () => {
  const toolDone = gate();
  const steer = gate();
  fakeGateway({ run_1: ['tool.started:web_search', toolDone.opened, 'tool.completed:web_search', 'run.completed'], run_2: [new Promise(() => {})], run_3: [new Promise(() => {})] }, steer.opened);
  const client = new WebSocket();
  const call = {
    id: 'call_1', botId: 'bot_1', userId: 'usr_1', startedAt: Date.now(), generation: 1, botName: 'Ada', firstName: 'Chris',
    instructions: '', conversation: 'c', chat: { rev: 0, told: new Set<string>() }, model: null, provider: null, effort: 'medium', greeting: 'Hi.', voice: 'v', speed: 1, relayed: true,
  };
  new Relay(client as never, call);
  const speech = WebSocket.instances.at(-1)!;
  const said = (utterance: number, text: string) => speech.emit('message', Buffer.from(JSON.stringify({ type: 'final', utterance, text })), false);
  const events = () => client.sent.map((s) => JSON.parse(s) as RelayEvent);
  const open = () => {
    const created = events().flatMap((e) => (e.type === 'response.created' ? [e.response.id] : []));
    const done = new Set(events().flatMap((e) => (e.type === 'response.done' ? [e.response.id] : [])));
    return created.filter((id) => !done.has(id));
  };

  speech.emit('message', Buffer.from(JSON.stringify({ type: 'ready' })), false);
  said(1, 'What is the weather in Rome?');
  await vi.waitFor(() => expect(events().some((e) => e.type === 'dispatch.activity')).toBe(true));
  said(2, 'And in Paris?'); // a tool is running: steered into the turn
  toolDone.open(); // the first turn finishes while the steer is still in flight
  await vi.waitFor(() => expect(open()).toEqual([]));
  said(3, 'Also Tokyo.'); // a new reply takes the call
  await vi.waitFor(() => expect(open()).toEqual(['resp_2']));
  steer.open(); // the old steer is refused only now
  await vi.waitFor(() => expect(events().filter((e) => e.type === 'response.created').length).toBe(3));
  expect(open()).toEqual(['resp_3']);
  client.emit('close');
});

/** A call on a fake speech service whose streaming model is `nemotron-test`, and helpers to drive it. */
function startCall(over: { botId?: string; chat?: ChatCursor } = {}) {
  const client = new WebSocket();
  const call = {
    id: 'call_1', botId: 'bot_1', userId: 'usr_1', startedAt: Date.now(), generation: 1, botName: 'Ada', firstName: 'Chris',
    instructions: '', conversation: 'c', chat: { rev: 0, told: new Set<string>() }, model: null, provider: null, effort: 'medium', greeting: 'Hi.', voice: 'v', speed: 1, relayed: true,
    ...over,
  };
  new Relay(client as never, call);
  const speech = WebSocket.instances.at(-1)!;
  const emit = (ev: object) => speech.emit('message', Buffer.from(JSON.stringify(ev)), false);
  emit({ type: 'ready', model: 'nemotron-test' });
  const events = () => client.sent.map((s) => JSON.parse(s) as RelayEvent);
  return {
    client, events,
    start: (utterance: number) => emit({ type: 'speech_started', utterance, start_ms: 0, audio_ms: 200 }),
    /** An utterance's final transcript, Parakeet's unless `model` says otherwise. */
    final: (utterance: number, text: string, model = 'parakeet-test') => emit({ type: 'final', utterance, text, model }),
    /** One utterance: speech_started, then its final. */
    utter: (utterance: number, text: string, model = 'parakeet-test') => {
      emit({ type: 'speech_started', utterance, start_ms: 0, audio_ms: 200 });
      emit({ type: 'final', utterance, text, model });
    },
    playback: () => events().flatMap((e) => (e.type === 'dispatch.playback' ? [e.action] : [])),
    done: (id: string) => events().find((e): e is Extract<RelayEvent, { type: 'response.done' }> => e.type === 'response.done' && e.response.id === id)?.response.status,
    spoken: () => events().flatMap((e) => (e.type === 'response.output_audio_transcript.delta' ? [e.delta.trim()] : [])),
  };
}

// A second of speech for each sentence, so the bot is still talking when the user's sounds come.
const SECOND = 48000;

test('a sound with no words over the bot pauses it, and it plays on with nothing lost', async () => {
  const more = gate();
  fakeGateway({ run_1: [{ event: 'message.delta', delta: 'One. Two. ' }, more.opened, { event: 'message.delta', delta: 'Three.' }, 'run.completed'] }, gate().opened, SECOND);
  const c = startCall();
  c.utter(1, 'Count to three.');
  await vi.waitFor(() => expect(c.spoken()).toEqual(['One.', 'Two.']));
  c.start(2); // a cough: the browser pauses
  more.open(); // the turn writes on meanwhile, but nothing new is spoken over the user
  await vi.waitFor(() => expect(c.done('resp_1')).toBeUndefined());
  await new Promise((r) => setTimeout(r, 20));
  expect(c.spoken()).toEqual(['One.', 'Two.']);
  c.final(2, ''); // no words: the browser plays on
  expect(c.playback()).toEqual(['stop', 'resume']);
  await vi.waitFor(() => expect(c.done('resp_1')).toBe('completed'));
  expect(c.spoken()).toEqual(['One.', 'Two.', 'Three.']);
  expect(c.events().filter((e) => e.type === 'response.created')).toHaveLength(1);
  c.client.emit('close');
});

test('over the bot, a word only the streaming model heard is dropped; the bot plays on', async () => {
  fakeGateway({ run_1: [{ event: 'message.delta', delta: 'One. Two.' }, 'run.completed'] }, gate().opened, SECOND);
  const c = startCall();
  c.utter(1, 'Yes', 'nemotron-test'); // the bot is quiet: the stream's word is the user's
  await vi.waitFor(() => expect(c.spoken()).toEqual(['One.', 'Two.']));
  c.utter(2, 'That’s', 'nemotron-test');
  expect(c.playback()).toEqual(['stop', 'resume']);
  expect(c.events().filter((e) => e.type === 'response.created')).toHaveLength(1);
  expect(c.events().some((e) => e.type === 'conversation.item.deleted' && e.item_id === 'call_1_u2')).toBe(true);
  c.client.emit('close');
});

test('words over the bot stop its speech and start a new reply', async () => {
  fakeGateway({ run_1: [{ event: 'message.delta', delta: 'One. Two. Three.' }, 'run.completed'], run_2: [new Promise(() => {})] }, gate().opened, SECOND);
  const c = startCall();
  c.utter(1, 'Count to three.');
  await vi.waitFor(() => expect(c.spoken()).toEqual(['One.', 'Two.', 'Three.']));
  c.utter(2, 'Stop there.');
  expect(c.playback()).toEqual(['stop', 'stop']);
  await vi.waitFor(() => expect(c.events().filter((e) => e.type === 'response.created')).toHaveLength(2));
  c.client.emit('close');
});

test('over the bot, its own words heard back are dropped; the bot plays on', async () => {
  fakeGateway({ run_1: [{ event: 'message.delta', delta: 'Yeah, loud and clear. How about me?' }, 'run.completed'] }, gate().opened, SECOND);
  const c = startCall();
  c.utter(1, 'Can you hear me okay?');
  await vi.waitFor(() => expect(c.spoken()).toEqual(['Yeah, loud and clear.', 'How about me?']));
  await new Promise((r) => setTimeout(r, 100)); // the first sentence is playing
  c.utter(2, 'loud and clear');
  expect(c.playback()).toEqual(['stop', 'resume']);
  expect(c.events().some((e) => e.type === 'conversation.item.deleted' && e.item_id === 'call_1_u2')).toBe(true);
  c.utter(3, 'Loud, yes. Now open my calendar.'); // the user's own words still stop it
  expect(c.playback()).toEqual(['stop', 'resume', 'stop']);
  await vi.waitFor(() => expect(c.events().filter((e) => e.type === 'response.created')).toHaveLength(2));
  c.client.emit('close');
});

test('over the bot, a "yeah" only acknowledges it; the bot plays on', async () => {
  fakeGateway({ run_1: [{ event: 'message.delta', delta: 'One. Two. Three.' }, 'run.completed'] }, gate().opened, SECOND);
  const c = startCall();
  c.utter(1, 'Count to three.');
  await vi.waitFor(() => expect(c.spoken()).toEqual(['One.', 'Two.', 'Three.']));
  await new Promise((r) => setTimeout(r, 100));
  c.utter(2, 'Yeah.');
  expect(c.playback()).toEqual(['stop', 'resume']);
  expect(c.events().some((e) => e.type === 'conversation.item.deleted' && e.item_id === 'call_1_u2')).toBe(true);
  expect(c.events().filter((e) => e.type === 'response.created')).toHaveLength(1);
  c.client.emit('close');
});

test('a "yeah" while the bot asks its last question answers it', async () => {
  fakeGateway({ run_1: [{ event: 'message.delta', delta: 'Here is one. Want another?' }, 'run.completed'], run_2: [new Promise(() => {})] }, gate().opened, SECOND);
  const c = startCall();
  c.utter(1, 'Tell me a joke.');
  await vi.waitFor(() => expect(c.spoken()).toEqual(['Here is one.', 'Want another?']));
  await new Promise((r) => setTimeout(r, 1200)); // the question is playing
  c.utter(2, 'Yeah.');
  expect(c.playback()).toEqual(['stop', 'stop']);
  await vi.waitFor(() => expect(c.events().filter((e) => e.type === 'response.created')).toHaveLength(2));
  c.client.emit('close');
});

test('a prompt on a call shows its card in the chat, and the call bar says the bot waits for it', async () => {
  const { seedBot, seedOwner } = await import('./helpers.js');
  const store = await import('../src/store.js');
  const approvals = await import('../src/agent/approvals.js');
  const owner = seedOwner();
  const bot = seedBot(owner.id);
  const answered = gate();
  fakeGateway({
    run_1: [
      'tool.started:terminal',
      { event: 'approval.request', prompt_id: 'p1', execution_generation: 1, command: 'rm -rf /tmp/x', description: 'delete in root path', choices: ['once', 'deny'] },
      answered.opened, 'tool.completed:terminal', 'run.completed',
    ],
  }, new Promise(() => {}));
  const client = new WebSocket();
  new Relay(client as never, {
    id: 'call_2', botId: bot.id, userId: owner.id, startedAt: Date.now(), generation: 1, botName: 'Ada', firstName: 'Chris',
    instructions: '', conversation: 'c', chat: { rev: 0, told: new Set<string>() }, model: null, provider: null, effort: 'medium', greeting: 'Hi.', voice: 'v', speed: 1, relayed: true,
  });
  const speech = WebSocket.instances.at(-1)!;
  const activity = () => client.sent.map((s) => JSON.parse(s) as RelayEvent).flatMap((e) => (e.type === 'dispatch.activity' ? [e.label] : []));
  speech.emit('message', Buffer.from(JSON.stringify({ type: 'ready' })), false);
  speech.emit('message', Buffer.from(JSON.stringify({ type: 'final', utterance: 1, text: 'Clean up the temp folder.' })), false);

  const card = () => store.listRows(bot.id).find((r) => r.kind === 'card')?.body as Extract<ReturnType<typeof store.listRows>[number]['body'], { card: 'approval' }> | undefined;
  await vi.waitFor(() => expect(card()).toMatchObject({ title: 'Delete in root path', command: 'rm -rf /tmp/x', choices: ['once', 'deny'], status: 'pending' }));
  expect(activity().at(-1)).toBe('Waiting for you in the chat');
  await approvals.answerApproval(owner.id, card()!.approvalId, 'once');
  expect(activity().at(-1)).toBe('Running commands');
  answered.open();
  await vi.waitFor(() => expect(card()!.status).toBe('allowed'));
});

test('each run hears what is new in the text chat, and a run stopped before it started asks again with it', async () => {
  const runs = fakeGateway({ run_1: [new Promise(() => {})], run_2: [new Promise(() => {})] }, gate().opened);
  const { seedBot, seedOwner } = await import('./helpers.js');
  const { appendRow } = await import('../src/store.js');
  const { chatCursor } = await import('../src/agent/catchup.js');
  const bot = seedBot(seedOwner().id);
  const c = startCall({ botId: bot.id, chat: chatCursor(bot.id) });
  appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'Find flights to Tokyo' });
  c.utter(1, 'Is it done yet?');
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  const news = '[New in your text chat with Chris since you last heard, oldest first:\n- Chris: Find flights to Tokyo (just now)]';
  expect(runs[0].input).toBe(`${news}\nIs it done yet?`);
  c.utter(2, 'Hello?'); // the first run is still thinking: it is stopped, and it had not started
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].input).toBe(`${news}\nIs it done yet? Hello?`);
  c.client.emit('close');
});
