// Voice call latency, measured at the relay's socket. Talks to a bot's call relay the way the browser
// does (web/src/voice/call.ts), with the user's lines spoken by Phonon through /api/voice/preview and
// streamed as microphone audio in real time. Measures, for each question, the end of the user's speech
// to the first audio of the bot's answer, then talks over a long reply and measures how soon it pauses and stops.
// Every answer is a turn of the bot's own agent and model.
// Usage: DISPATCH_USER=… DISPATCH_PASSWORD=… node tests/voice-latency.mjs [baseUrl] [botName]
//   (default http://127.0.0.1:8788 and the primary bot; records one short call in that bot's chat)
import { createRequire } from 'node:module';
import { signIn } from './signin.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const { WebSocket } = require('ws');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8788';
const COOKIE = await signIn(BASE);
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: COOKIE, ...(init.headers ?? {}) } });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

const RATE = 24000;
const FRAME = RATE * 0.04; // the browser sends 40 ms frames
const USER_VOICE = 'micah';
const QUESTIONS = [
  'Hi! What is seven times eight?',
  'How many days are there in a leap year?',
  'Can you give me one quick tip for sleeping better?',
  'What is the capital of Australia?',
  'How do you say thank you in French?',
];
const STORY = 'Tell me a story about a lighthouse keeper and a lost whale, in about eight sentences.';
const INTERRUPT = 'Sorry to cut you off. What day is it today?';
const PLANETS = 'Name the planets of the solar system, with one sentence about each.';
const INTERRUPT2 = 'Okay, that\'s enough. What is two plus two?';
const SLOW_TASK = 'Run the command sleep 8 in your terminal, then tell me how many files are in the slash etc folder.';
const STEER = 'Also, what is six times seven?';

const bots = (await (await api('/api/bots')).json()).bots;
const bot = process.argv[3] ? bots.find((b) => b.name === process.argv[3]) : bots.find((b) => b.isPrimary);
if (!bot) throw new Error('bot not found');
log(`bot ${bot.name}, voice ${bot.voice} at ${bot.voiceSpeed}x; the user speaks as ${USER_VOICE}`);

/** Phonon speech for a line, trimmed to the speech itself. */
async function line(text) {
  const r = await api('/api/voice/preview', { method: 'POST', body: JSON.stringify({ botId: bot.id, voice: USER_VOICE, speed: 1, text }) });
  if (!r.ok) throw new Error(`preview failed: ${r.status} ${await r.text()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  let a = 0; let b = pcm.length - 1;
  while (a < b && Math.abs(pcm[a]) < 600) a++;
  while (b > a && Math.abs(pcm[b]) < 600) b--;
  return pcm.slice(a, b + 1);
}
const lines = {};
for (const q of [...QUESTIONS, STORY, INTERRUPT, PLANETS, INTERRUPT2, SLOW_TASK, STEER]) lines[q] = await line(q);

// ---------- the call ----------
const sess = await (await api('/api/voice/session', { method: 'POST', body: JSON.stringify({ botId: bot.id }) })).json();
if (!sess.websocketUrl) throw new Error('no session: ' + JSON.stringify(sess));
const ws = new WebSocket(new URL(sess.websocketUrl, BASE.replace(/^http/, 'ws')).href, { headers: { cookie: COOKIE } });
const events = []; // { at, ev }
const waiters = [];
/** The first unclaimed event that matches, already received or yet to come, from `since` on. */
const on = (pred, ms = 60000, since = 0) => new Promise((resolve, reject) => {
  const hit = events.find((e) => e.at >= since && pred(e.ev) && !e.used);
  if (hit) { hit.used = true; return resolve(hit); }
  const w = { pred, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timed out waiting')); }, ms) };
  waiters.push(w);
});
ws.on('message', (d) => {
  const e = { at: Date.now(), ev: JSON.parse(String(d)) };
  events.push(e);
  if (e.ev.type === 'error') log('error event', JSON.stringify(e.ev.error));
  if (e.ev.type === 'dispatch.activity') log(`   the bot is ${e.ev.label.toLowerCase()}`);
  for (const w of [...waiters]) if (w.pred(e.ev)) { e.used = true; clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(e); break; }
});
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
await on((ev) => ev.type === 'session.created', 15000);
log('relay ready');

// The microphone: 40 ms frames in real time, silence unless a line is playing.
let tape = null; let tapePos = 0; let tapeEnd = null;
let sent = 0;
const startAt = Date.now();
const mic = setInterval(() => {
  const due = Math.floor((Date.now() - startAt) / 40);
  while (sent < due) {
    const frame = new Int16Array(FRAME);
    if (tape) {
      const n = Math.min(FRAME, tape.length - tapePos);
      frame.set(tape.subarray(tapePos, tapePos + n));
      tapePos += n;
      if (tapePos >= tape.length) { tapeEnd?.(startAt + (sent * 40) + (n / RATE) * 1000); tape = null; }
    }
    sent++;
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(frame.buffer).toString('base64') }));
  }
}, 10);
/** Plays a line; resolves with the wall-clock times its first and last samples were due. */
const play = (pcm) => new Promise((resolve) => {
  const first = startAt + sent * 40;
  tape = pcm; tapePos = 0;
  tapeEnd = (end) => resolve({ first, end });
});
const replyAudio = (id) => events.filter((e) => e.ev.type === 'response.output_audio.delta' && e.ev.response_id === id);
const transcriptOf = (id) => events.filter((e) => e.ev.type === 'response.output_audio_transcript.delta' && e.ev.response_id === id).map((e) => e.ev.delta).join('');

// The bot greets first, as in the browser.
ws.send(JSON.stringify({ type: 'response.create' }));
const greet = await on((ev) => ev.type === 'response.created');
const greetDone = await on((ev) => ev.type === 'response.done' && ev.response.id === greet.ev.response.id);
const greetAudio = replyAudio(greet.ev.response.id);
log(`greeting: "${transcriptOf(greet.ev.response.id)}" first audio ${greetAudio[0].at - greet.at} ms after response.create, ${greetAudio.length} deltas`);
const audioSeconds = (id) => replyAudio(id).reduce((s, e) => s + Buffer.from(e.ev.delta, 'base64').length / 2 / RATE, 0);
await sleep(audioSeconds(greet.ev.response.id) * 1000 - (Date.now() - greetAudio[0].at) + 800);

const latencies = [];
for (const q of QUESTIONS) {
  const spoken = await play(lines[q]);
  const final = await on((ev) => ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript, 60000, spoken.first);
  const created = await on((ev) => ev.type === 'response.created', 60000, final.at);
  const id = created.ev.response.id;
  const done = await on((ev) => ev.type === 'response.done' && ev.response.id === id, 180000);
  const audio = replyAudio(id);
  const stopped = events.find((e) => e.ev.type === 'input_audio_buffer.speech_stopped' && e.ev.item_id === final.ev.item_id);
  const firstAudio = audio[0]?.at;
  const ms = firstAudio ? firstAudio - spoken.end : NaN;
  latencies.push(ms);
  log(`"${final.ev.transcript}" → "${transcriptOf(id)}"`);
  log(`   end of speech → speech_stopped ${stopped.at - spoken.end} ms, final ${final.at - spoken.end} ms, first audio of the answer ${ms} ms (${done.ev.response.status})`);
  // Let the reply play out, as the browser would, before the next question.
  await sleep(Math.max(0, audioSeconds(id) * 1000 - (Date.now() - (firstAudio ?? Date.now()))) + 1000);
}

// Barge-in: talk over a long reply, once while the browser is still playing a story that has all been
// made (Phonon makes speech about 17 times faster than it plays), and once while a reply is still
// being made.
const barges = [];
async function bargeIn(request, interruption, afterMs) {
  const asked = await play(lines[request]);
  const created = await on((ev) => ev.type === 'response.created', 60000, asked.first);
  const id = created.ev.response.id;
  const firstAudio = await on((ev) => ev.type === 'response.output_audio.delta' && ev.response_id === id, 120000);
  log(`"${request}": first audio ${firstAudio.at - asked.end} ms after the request`);
  await sleep(afterMs);
  const queued = audioSeconds(id);
  const generating = !events.some((e) => e.ev.type === 'response.done' && e.ev.response.id === id);
  if (!generating && queued * 1000 < afterMs + 1000) {
    log(`   the reply was ${queued.toFixed(1)} s long: "${transcriptOf(id)}"; too short to talk over`);
    await on((ev) => ev.type === 'response.done' && ev.response.id === id);
    await sleep(1000);
    return;
  }
  const cut = await play(lines[interruption]);
  const started = events.find((e) => e.ev.type === 'input_audio_buffer.speech_started' && e.at >= cut.first);
  // Once the final transcript is in, the relay says whether the paused speech plays on or stops.
  const decided = await on((ev) => ev.type === 'dispatch.playback', 60000, started.at);
  const done = await on((ev) => ev.type === 'response.done' && ev.response.id === id, 120000);
  const late = replyAudio(id).filter((e) => e.at > decided.at).length;
  const b = { generating, toStarted: started.at - cut.first, detected: started.ev.audio_ms - started.ev.audio_start_ms, action: decided.ev.action, toDecided: decided.at - cut.first, status: done.ev.response.status, toDone: done.at - cut.first, late };
  barges.push(b);
  log(`talked over it ${cut.first - firstAudio.at} ms into its audio, ${generating ? 'while it was still being made' : 'after it was all made'} (${queued.toFixed(1)} s of audio sent)`);
  log(`   speech_started, where the browser pauses: ${b.toStarted} ms after the user started (the service heard it at ${b.detected} ms of audio)`);
  log(`   dispatch.playback ${b.action}: ${b.toDecided} ms after the user started`);
  log(`   response.done: ${b.status}${b.status === 'cancelled' ? `, ${b.toDone} ms after the user started` : ' before the interruption'}; audio deltas after dispatch.playback: ${late}`);
  // A pause inside the interruption makes two utterances, and the reply to the first is cut off too.
  const afterDone = await on((ev) => ev.type === 'response.done' && ev.response.status === 'completed', 120000, cut.first);
  log(`   then: "${transcriptOf(afterDone.ev.response.id)}"`);
  await sleep(audioSeconds(afterDone.ev.response.id) * 1000 + 800);
}
await bargeIn(STORY, INTERRUPT, 3500);
await bargeIn(PLANETS, INTERRUPT2, 300);

// Talking while a tool runs: the words are steered into the running turn, which answers both.
let steer = null;
{
  const asked = await play(lines[SLOW_TASK]);
  const created = await on((ev) => ev.type === 'response.created', 60000, asked.first);
  const id = created.ev.response.id;
  const working = await on((ev) => ev.type === 'dispatch.activity' && ev.response_id === id, 120000);
  log(`"${SLOW_TASK}": a tool started ${working.at - asked.end} ms after the request; talking now`);
  const said = await play(lines[STEER]);
  const done = await on((ev) => ev.type === 'response.done' && ev.response.id === id, 180000);
  const others = events.filter((e) => e.ev.type === 'response.created' && e.at > said.first).length;
  const answer = transcriptOf(id);
  steer = { status: done.ev.response.status, answered: /forty-two|\b42\b/i.test(answer), others };
  log(`   the turn ${done.ev.response.status} ${done.at - said.end} ms after the user stopped, ${others} other replies started: "${answer}"`);
  await sleep(audioSeconds(id) * 1000 + 800);
}

clearInterval(mic);
ws.close();
const transcript = [];
for (const e of events) {
  if (e.ev.type === 'conversation.item.input_audio_transcription.completed' && e.ev.transcript) transcript.push({ role: 'user', text: e.ev.transcript });
  if (e.ev.type === 'response.output_audio_transcript.done' && e.ev.transcript) transcript.push({ role: 'assistant', text: e.ev.transcript });
}
await api('/api/voice/end', { method: 'POST', body: JSON.stringify({ botId: bot.id, callId: sess.callId, transcript }) });
console.log(`\nend of speech → first audio of the answer, ${latencies.length} turns: ${latencies.join(', ')} ms; median ${median(latencies)} ms`);
if (steer) console.log(`talking during a tool: the turn ${steer.status}, ${steer.answered ? 'answered' : 'did not answer'} the added question, ${steer.others} other replies`);
for (const b of barges) console.log(`barge-in ${b.generating ? 'while generating' : 'while playing'}: ${b.toStarted} ms to speech_started (paused), ${b.toDecided} ms to dispatch.playback ${b.action}${b.status === 'cancelled' ? `, ${b.toDone} ms to response.done (cancelled)` : ''}, ${b.late} late audio deltas`);
