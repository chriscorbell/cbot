// Voice call test in headless Chrome. The fake microphone plays tests/ask-weather.wav once: nine
// seconds of silence while the bot greets, then "Hey, can you look up the current weather in Tokyo
// for me?", then silence. Checks the voice options and preview, the call over Dispatch's relay, the
// thinking loop while the bot's agent works, the spoken answer, dictation, and the call record's
// summary.
// Usage: DISPATCH_USER=… DISPATCH_PASSWORD=… node tests/voice-call.mjs [baseUrl] [botName]
//   (default http://127.0.0.1:8788 and the primary bot; the call record stays in its chat)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { browserCookie, signIn } from './signin.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8788';
const COOKIE = await signIn(BASE);
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: COOKIE, ...(init.headers ?? {}) } });
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, 'out', 'voice');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const bots = (await (await api('/api/bots')).json()).bots;
const bot = process.argv[3] ? bots.find((b) => b.name === process.argv[3]) : bots.find((b) => b.isPrimary);
if (!bot) throw new Error('bot not found');

// ---------- settings: stored voices and speeds map onto Phonon's ----------
const opts = await (await api('/api/voice/options')).json();
log(`options: ${opts.voices.length} voices (default ${opts.defaultVoice}), speeds ${opts.speeds.join(', ')}`);
check(opts.voices.length > 0 && opts.speeds.every((s) => s >= 0.86 && s <= 1.27), 'voice options come from the speech service');
const patch = async (p) => (await (await api(`/api/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify(p) })).json()).bot;
const mapped = await patch({ voice: 'not-a-phonon-voice', voiceSpeed: 1.5 });
log(`saved an unknown voice at 1.5x, read back ${mapped.voice} at ${mapped.voiceSpeed}x`);
check(mapped.voice === opts.defaultVoice && mapped.voiceSpeed === 1.27, 'unknown voices fall back to the default and speeds clamp');
await patch({ voice: bot.voice, voiceSpeed: bot.voiceSpeed });

// ---------- the browser ----------
// Each launch plays the recording from its start.
const launch = () => chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(HERE, 'ask-weather.wav')}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const contextOptions = { viewport: { width: 1440, height: 900 }, permissions: ['microphone'] };
const browser = await launch();
const ctx = await browser.newContext(contextOptions);
await ctx.addCookies([browserCookie(BASE, COOKIE)]);
await ctx.addInitScript((botId) => {
  localStorage.setItem('dispatch.selectedBot', botId);
  localStorage.setItem('dispatch.detailsOpen', '1');
  // Audio the page plays, in seconds, and when the thinking loop (the one looping source) started.
  window.__audio = { starts: 0, seconds: 0, loops: [] };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    if (this.loop) window.__audio.loops.push(Date.now());
    else { window.__audio.starts++; window.__audio.seconds += this.buffer?.duration ?? 0; }
    return start.apply(this, a);
  };
  // The relay's events both ways, without the audio itself.
  window.__relay = { recv: [], sent: [], appends: 0 };
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(u, p) {
      super(u, p);
      if (!String(u).includes('/api/voice/relay/')) return;
      this.addEventListener('message', (m) => {
        try {
          const ev = JSON.parse(m.data);
          const rec = { t: Date.now(), type: ev.type };
          for (const k of ['item_id', 'response_id', 'transcript', 'label', 'audio_ms', 'audio_end_ms', 'audio_start_ms']) if (ev[k] !== undefined) rec[k] = ev[k];
          if (ev.type === 'response.output_audio.delta') rec.bytes = Math.floor((ev.delta.length * 3) / 4);
          else if (ev.delta !== undefined) rec.delta = ev.delta;
          if (ev.response) rec.response = { id: ev.response.id, status: ev.response.status };
          if (ev.error) rec.error = ev.error;
          window.__relay.recv.push(rec);
        } catch { /* not json */ }
      });
      const send = this.send.bind(this);
      this.send = (d) => {
        try {
          const ev = JSON.parse(d);
          if (ev.type === 'input_audio_buffer.append') window.__relay.appends++;
          else window.__relay.sent.push({ t: Date.now(), type: ev.type, item: ev.item });
        } catch { /* not json */ }
        return send(d);
      };
    }
  };
}, bot.id);
const page = await ctx.newPage();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) log(`console.${m.type()}`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => log('pageerror', e.message));
await page.goto(BASE);
await page.waitForSelector('.composer__input', { timeout: 20000 });

// ---------- preview, in the bot's settings under "Model & voice" ----------
// "Bot settings" in the details panel, which opens from the bot's name in the header if it is closed.
if (!(await page.getByRole('button', { name: 'Bot settings', exact: true }).isVisible())) await page.locator('.chat__chip').click();
await page.getByRole('button', { name: 'Bot settings', exact: true }).click();
await page.getByLabel('Bot settings sections').getByText('Model & voice', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: /settings$/ });
// The Voice row opens the picker; the chosen voice's card has a play button.
await dialog.locator('.voice-card__toggle').click();
const play = dialog.locator('.voice-cell.is-selected .voice-cell__play');
await play.waitFor({ timeout: 20000 });
await play.click();
await page.waitForFunction(() => (window.__audio?.seconds ?? 0) > 1, null, { timeout: 30000, polling: 200 }).catch(() => log('no preview audio seen'));
const preview = await page.evaluate(() => window.__audio);
log(`preview played ${preview.seconds.toFixed(2)} s of audio`);
check(preview.seconds > 1, 'voice preview plays');
// The picker heads its cards by group; count the cards under each heading.
const groups = await page.locator('.vcall-settings .voice-group').evaluateAll((gs) => gs.map((g) => {
  let n = 0;
  for (let e = g.nextElementSibling; e && !e.classList.contains('voice-group'); e = e.nextElementSibling) n++;
  return `${g.textContent} (${n})`;
}));
log(`voice picker: ${groups.join(', ')}`);
// The first Escape closes the picker, the second the settings.
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.getByRole('dialog', { name: /settings$/ }).waitFor({ state: 'detached', timeout: 5000 });

// ---------- the call ----------
const before = await page.evaluate(() => window.__audio.seconds);
await page.getByRole('button', { name: /Start voice chat/ }).first().click();
await page.waitForSelector('.vcall.is-live', { timeout: 20000 });
log('live');
const relay = () => page.evaluate(() => window.__relay);
const isQuestion = (e) => e.type === 'conversation.item.input_audio_transcription.completed' && /tokyo/i.test(e.transcript ?? '');
let lastStatus = '';
let shot = false;
let answer = null;
for (let i = 0; i < 480 && !answer; i++) {
  await page.waitForTimeout(500);
  const cls = (await page.locator('.vcall').getAttribute('class').catch(() => '')) ?? '';
  const st = /is-speaking/.test(cls) ? 'speaking' : /is-listening/.test(cls) ? 'listening' : /is-working/.test(cls) ? 'thinking' : /is-connecting/.test(cls) ? 'connecting' : 'idle';
  if (st !== lastStatus) { log(`status: ${st}`); lastStatus = st; }
  if (st === 'thinking' && !shot) { shot = true; await page.screenshot({ path: path.join(OUT, 'thinking.png') }); }
  const r = await relay();
  const q = r.recv.find(isQuestion);
  if (!q) continue;
  const created = r.recv.find((e) => e.type === 'response.created' && e.t >= q.t);
  const done = created && r.recv.find((e) => e.type === 'response.done' && e.response?.id === created.response.id);
  if (done) answer = { created, done };
}
if (answer) {
  // Let the answer finish playing.
  const r = await relay();
  const secs = r.recv.filter((e) => e.type === 'response.output_audio.delta' && e.response_id === answer.created.response.id).reduce((s, e) => s + e.bytes / 2 / 24000, 0);
  await page.waitForTimeout(Math.max(0, secs * 1000 - (Date.now() - answer.done.t)) + 1500);
}
await page.screenshot({ path: path.join(OUT, 'after-answer.png') });
await page.getByRole('button', { name: 'Show transcript' }).click().catch(() => {});
await page.waitForTimeout(300);
const callLog = await page.locator('.vcall-log').innerText().catch(() => '(none)');
const audio = await page.evaluate(() => window.__audio);
const played = audio.seconds - before;
await page.getByRole('button', { name: 'Hang up' }).click();
const r = await relay();
await page.waitForTimeout(1500);
await browser.close();

// ---------- what happened ----------
console.log(`\nCall transcript as the page shows it:\n${callLog.replace(/\nHide transcript$/, '')}\n`);
const recv = r.recv;
const userFinals = recv.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed' && e.transcript);
log(`microphone frames sent: ${r.appends}; recognised: ${userFinals.map((e) => `"${e.transcript}"`).join(', ') || 'nothing'}`);
const question = recv.find(isQuestion);
check(!!question && /weather/i.test(question.transcript), 'the question was recognised');
const greeting = recv.find((e) => e.type === 'response.output_audio_transcript.done');
log(`greeting: "${greeting?.transcript ?? ''}"`);
check(!!greeting?.transcript, 'the bot answered the call with a greeting');
const id = answer?.created.response.id;
const words = recv.filter((e) => e.type === 'response.output_audio.delta' && e.response_id === id);
const activity = recv.filter((e) => e.type === 'dispatch.activity' && e.response_id === id).map((e) => e.label);
const said = recv.filter((e) => e.type === 'response.output_audio_transcript.done' && e.response_id === id).map((e) => e.transcript).join(' ');
log(`while working: ${activity.join(', ') || 'no tools'}; thinking loop started ${audio.loops.length} times`);
log(`the answer: "${said}" (${words.length} audio deltas, ${(words.reduce((s, e) => s + e.bytes, 0) / 48000).toFixed(1)} s), ${answer?.done.response.status ?? 'not finished'}`);
check(audio.loops.length > 0, 'the thinking loop played while the bot worked');
check(words.length > 0 && said.length > 0 && answer?.done.response.status === 'completed', 'the answer was spoken');
log(`audio played in the page during the call: ${played.toFixed(1)} s`);
const errors = recv.filter((e) => e.type === 'error');
if (errors.length) log(`relay errors: ${JSON.stringify(errors.map((e) => e.error))}`);

// End of the user's speech to the first audio of the answer, at the page.
const stopped = question && recv.find((e) => e.type === 'input_audio_buffer.speech_stopped' && e.item_id === question.item_id);
if (stopped) {
  const endOfSpeech = stopped.t - (stopped.audio_ms - stopped.audio_end_ms);
  const loop = audio.loops.find((t) => t > stopped.t);
  log(`end of speech → thinking loop ${loop ? loop - endOfSpeech : '?'} ms, → first audio of the answer ${words[0] ? words[0].t - endOfSpeech : '?'} ms`);
}

// ---------- dictation in the composer: tap the microphone, let the recording play, tap again ----------
{
  const b = await launch();
  const c = await b.newContext(contextOptions);
  await c.addCookies([browserCookie(BASE, COOKIE)]);
  await c.addInitScript((botId) => localStorage.setItem('dispatch.selectedBot', botId), bot.id);
  const p = await c.newPage();
  await p.goto(BASE);
  const input = p.locator('.composer__input');
  await input.waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: 'Dictate' }).click();
  await p.getByRole('button', { name: 'Stop dictation' }).waitFor({ timeout: 5000 });
  await p.waitForTimeout(13500); // the question ends 12.5 s into the recording
  const stoppedAt = Date.now();
  await p.getByRole('button', { name: 'Stop dictation' }).click();
  await p.waitForFunction(() => document.querySelector('.composer__input')?.value.trim(), null, { timeout: 15000 }).catch(() => {});
  const text = await input.inputValue();
  log(`dictation: "${text}", ${Date.now() - stoppedAt} ms after the tap that stopped it`);
  check(/tokyo/i.test(text), 'dictation fills the composer');
  await input.fill('');
  await b.close();
}

// The call record; the summary is written a moment after the call ends.
let record = null;
for (let i = 0; i < 30 && !record?.body.call?.summary; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  const rs = (await (await api(`/api/bots/${bot.id}/rows`)).json()).rows;
  record = [...rs].reverse().find((x) => x.body?.event === 'voice-call' && x.body.call?.phase === 'ended');
}
log(`call record: "${record?.body.text}"`);
check(!!record?.body.call?.summary, 'the call record has a summary');
console.log(`\n${failures.length ? `${failures.length} failed: ${failures.join('; ')}` : 'all passed'}`);
process.exitCode = failures.length ? 1 : 0;
