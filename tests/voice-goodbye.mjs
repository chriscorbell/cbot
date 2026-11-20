// Goodbye test in headless Chrome: the call must not hang up while the bot's goodbye is still playing.
// The fake microphone says, after nine seconds of silence, a thank-you that asks for a recap before
// the bot says goodbye, so the farewell runs long. Speech arrives far faster than it plays, so the
// whole goodbye is queued in the page when the relay says the bot hung up; the page has to wait for it.
// The user's line is synthesised by the speech service in another voice on each run.
// Usage: CBOT_USER=… CBOT_PASSWORD=… node tests/voice-goodbye.mjs [baseUrl] [botName]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { browserCookie, signIn } from './signin.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8788';
const COOKIE = await signIn(BASE);
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: COOKIE, ...(init.headers ?? {}) } });
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'out', 'voice');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const bots = (await (await api('/api/bots')).json()).bots;
const bot = process.argv[3] ? bots.find((b) => b.name === process.argv[3]) : bots.find((b) => b.isPrimary);
if (!bot) throw new Error('bot not found');

// ---------- the user's line, as a WAV the fake microphone can play ----------
const LINE = 'That is everything I needed, thank you. Give me a quick recap of what you can help me with, say goodbye, and then hang up the call.';
const res = await api('/api/voice/preview', { method: 'POST', body: JSON.stringify({ voice: 'edwin', text: LINE, codec: 'pcm' }) });
if (!res.ok) throw new Error(`could not synthesise the user's line: ${res.status}`);
const pcm = path.join(OUT, 'goodbye.pcm');
const wav = path.join(OUT, 'goodbye.wav');
fs.writeFileSync(pcm, Buffer.from(await res.arrayBuffer()));
// 9 s of silence while the bot greets, the line, then a minute of silence; 48 kHz mono like ask-weather.wav.
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm,
  '-af', 'adelay=9000,apad=pad_dur=60', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);

// ---------- the call ----------
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
await ctx.addCookies([browserCookie(BASE, COOKIE)]);
await ctx.addInitScript((botId) => {
  localStorage.setItem('cbot.selectedBot', botId);
  // When each piece of audio is due to finish, in wall-clock ms, and when the relay socket closed.
  window.__goodbye = { ends: [], closedAt: 0, hangup: 0 };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    const lead = Math.max(0, when - this.context.currentTime);
    // The thinking loop is the one looping source; it is not speech.
    if (!this.loop) window.__goodbye.ends.push(Date.now() + (lead + (this.buffer?.duration ?? 0)) * 1000);
    return start.call(this, when, ...rest);
  };
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(u, p) {
      super(u, p);
      if (!String(u).includes('/api/voice/relay/')) return;
      this.addEventListener('message', (m) => {
        try { const ev = JSON.parse(m.data); if (ev.type === 'cbot.hangup') window.__goodbye.hangup ||= Date.now(); } catch { /* not json */ }
      });
      const close = this.close.bind(this);
      this.close = (...a) => { window.__goodbye.closedAt ||= Date.now(); return close(...a); };
      this.addEventListener('close', () => { window.__goodbye.closedAt ||= Date.now(); });
    }
  };
}, bot.id);
const page = await ctx.newPage();
page.on('pageerror', (e) => log('pageerror', e.message));
await page.goto(BASE);
await page.waitForSelector('.composer__input', { timeout: 20000 });
await page.getByRole('button', { name: /Start voice chat/ }).first().click();
await page.waitForSelector('.vcall.is-live', { timeout: 20000 });
log('live');

let g = null;
for (let i = 0; i < 180; i++) {
  await page.waitForTimeout(500);
  g = await page.evaluate(() => window.__goodbye);
  if (g.closedAt) break;
}
await page.screenshot({ path: path.join(OUT, 'goodbye-ended.png') });
await browser.close();

// ---------- what happened ----------
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
check(!!g.hangup, 'the bot hung up (end_call)');
check(!!g.closedAt, 'the call ended');
if (g.hangup && g.closedAt) {
  const lastEnd = Math.max(...g.ends);
  const queued = (lastEnd - g.hangup) / 1000;
  log(`audio still queued when the bot hung up: ${queued.toFixed(1)} s; the call ended ${((g.closedAt - lastEnd) / 1000).toFixed(1)} s after the last audio finished`);
  // A quarter second of slack for timer and audio clock jitter.
  check(g.closedAt >= lastEnd - 250, 'the call ended only after the goodbye finished playing');
}
console.log(`\n${failures.length ? `${failures.length} failed: ${failures.join('; ')}` : 'all passed'}`);
process.exitCode = failures.length ? 1 : 0;
