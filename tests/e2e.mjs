// End-to-end smoke test (real server, real Hermes engines, the bots' real screens in the container).
// Usage: CBOT_USER=… CBOT_PASSWORD=… node tests/e2e.mjs [baseUrl]   (default http://localhost:8787)
// Signs in with tests/signin.mjs (creating the account on a server with none). Creates a
// throwaway "QA" bot, which gets its own Hermes engine and screen, exercises the core flows, then deletes it.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { browserCookie, signIn } from './signin.mjs';

const BASE = process.argv[2] ?? 'http://localhost:8787';
const OUT = path.resolve(new URL('.', import.meta.url).pathname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    try { await page.screenshot({ path: path.join(OUT, `FAIL-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) }); } catch {}
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).split('\n')[0] });
    console.log(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`);
  }
};

const COOKIE = await signIn(BASE);
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: COOKIE, ...(init.headers ?? {}) } });
// The main bot is the primary bot; its name comes from the server.
const MAIN = (await (await api('/api/bots')).json()).bots.find((b) => b.isPrimary)?.name;
if (!MAIN) throw new Error('no primary bot: finish the setup wizard first');

// The fake microphone plays tests/ask-weather.wav once the voice call opens it: nine seconds of
// silence, then "Hey, can you look up the current weather in Tokyo for me?".
const WAV = path.resolve(new URL('.', import.meta.url).pathname, 'ask-weather.wav');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
// The page carries the script's session cookie; the screen viewer's WebSocket relies on it too.
const ctx = await browser.newContext({ viewport: { width: 1512, height: 864 }, permissions: ['microphone'] });
await ctx.addCookies([browserCookie(BASE, COOKIE)]);
// Seconds of audio the page plays (the voice call's speech).
await ctx.addInitScript(() => {
  window.__audioSeconds = 0;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) { window.__audioSeconds += this.buffer?.duration ?? 0; return start.apply(this, a); };
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const botName = `QA ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
let botId = null;

await step('app loads with the rail', async () => {
  await page.goto(BASE);
  // The rail shows bots as icons; each is a button named after its bot.
  await page.getByRole('button', { name: new RegExp(`^${MAIN}`) }).first().waitFor({ timeout: 15000 });
  await shot('01-loaded');
});

await step('create bot via modal', async () => {
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Create New Bot' });
  await modal.getByLabel('Name', { exact: true }).fill(botName);
  await modal.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByLabel(`Message ${botName}`, { exact: true }).first().waitFor({ timeout: 15000 });
  const bots = await (await api('/api/bots')).json();
  botId = bots.bots.find((b) => b.name === botName)?.id;
  if (!botId) throw new Error('bot not found via API');
  await shot('02-created');
});

const send = async (text) => {
  // The composer keeps its label; its placeholder changes while a question waits for an answer.
  const box = page.getByLabel(`Message ${botName}`, { exact: true }).first();
  await box.fill(text);
  await box.press('Enter');
};
const waitReply = async (re, timeout) => {
  await page.waitForFunction(
    ([src]) => [...document.querySelectorAll('body *')].some((el) => el.childElementCount === 0 && new RegExp(src, 'i').test(el.textContent ?? '')),
    [re.source],
    { timeout },
  );
};

await step('chat reply streams', async () => {
  await send('What is 17 times 3? Reply with only the number immediately followed by -e2e (no spaces).');
  await waitReply(/\b51-e2e/, 90000);
  await shot('03-chat');
});

await step('bot uses its own computer (shell on its screen)', async () => {
  await send('Use your shell tool to run `echo cbot-$((40+2))-e2e` and reply with only the output.');
  await waitReply(/cbot-42-e2e/, 240000);
  const comp = await (await api('/api/computer')).json();
  if (!comp.computer.screens.some((s) => s.botId === botId)) throw new Error('no screen leased for QA bot');
  await shot('04-computer-tool');
});

await step('computer viewer: watch, take control, stop', async () => {
  // "Bot's computer" in the details panel.
  await page.locator('.panel-row--computer').click();
  const viewer = page.getByRole('dialog', { name: /computer$/ });
  await viewer.locator('canvas').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot('05-viewer-watch');
  // Watching · Take control under the screen; in control it reads You're in control · Stop.
  await viewer.getByRole('button', { name: 'Take control' }).click();
  await viewer.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot('06-viewer-control');
  await viewer.getByRole('button', { name: 'Stop', exact: true }).click();
  await viewer.getByRole('button', { name: 'Take control' }).waitFor({ timeout: 15000 });
  await page.keyboard.press('Escape');
});

await step('search palette opens the main bot', async () => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Search bots/i).fill(MAIN);
  await page.keyboard.press('Enter');
  await page.getByPlaceholder(new RegExp(`Message ${MAIN}`)).first().waitFor({ timeout: 10000 });
  await shot('07-search');
});

await step('voice: a call greets, hears the question, and is recorded', async () => {
  // The QA bot's chat, then the composer's call button. The call ends once the question is heard,
  // before the bot hands it off.
  await page.getByRole('button', { name: new RegExp(`^${botName}`) }).first().click();
  await page.getByRole('button', { name: `Start voice chat with ${botName}` }).click();
  await page.locator('.vcall.is-live').waitFor({ timeout: 20000 });
  // The transcript opens from the call bar.
  await page.getByRole('button', { name: 'Show transcript' }).click();
  await page.locator('.vcall-log__line.is-assistant').first().waitFor({ timeout: 20000 });
  const heard = await page.waitForFunction(
    () => [...document.querySelectorAll('.vcall-log__line.is-user:not(.is-partial)')].map((e) => e.textContent).find((t) => /tokyo/i.test(t ?? '')),
    null, { timeout: 40000, polling: 50 },
  );
  await page.getByRole('button', { name: 'Hang up' }).click();
  const said = await heard.jsonValue();
  const seconds = await page.evaluate(() => window.__audioSeconds);
  console.log(`   heard "${said}"; the greeting played ${seconds.toFixed(1)} s of audio`);
  if (seconds < 0.5) throw new Error('no audio from the call');
  // The chat records the call as a "Voice chat · <duration>" row.
  await page.locator('.call-row__head', { hasText: /^Voice chat/ }).first().waitFor({ timeout: 10000 });
  await shot('08-voice-call');
});

await step('group chat: members reply via @mention', async () => {
  // Throwaway group: the QA bot plus the primary bot; @mention the QA bot.
  const bots = (await (await api('/api/bots')).json()).bots;
  const qa = bots.find((b) => b.id === botId);
  const primary = bots.find((b) => b.isPrimary);
  const created = await (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: `E2E group ${Date.now() % 100000}`, botIds: [botId, primary.id] }) })).json();
  if (!created.id) throw new Error('could not create group: ' + JSON.stringify(created));
  try {
    await api(`/api/bots/${created.id}/messages`, { method: 'POST', body: JSON.stringify({ text: `@${qa.name} reply with exactly: group-e2e-ok` }) });
    const t0 = Date.now();
    for (;;) {
      const rows = (await (await api(`/api/bots/${created.id}/rows`)).json()).rows;
      if (rows.some((r) => r.body?.from?.id === botId && /group-e2e-ok/i.test(r.body.text ?? ''))) break;
      if (Date.now() - t0 > 120000) throw new Error('QA bot did not reply in the group');
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await api(`/api/bots/${created.id}`, { method: 'DELETE' });
  }
});

await step('bot settings: general, skills, memories, routines', async () => {
  await page.getByRole('button', { name: new RegExp(`^${MAIN}`) }).first().click();
  // "Bot settings" in the details panel.
  await page.getByRole('button', { name: 'Bot settings', exact: true }).click();
  const nav = page.getByLabel('Bot settings sections');
  await nav.waitFor({ timeout: 10000 });
  for (const t of ['Skills', 'Memories', 'Routines']) { await nav.getByText(t, { exact: true }).click(); await page.waitForTimeout(400); }
  await nav.getByText('Memories', { exact: true }).click();
  // The memory search box only shows with more than 6 memories, so wait for the page title instead.
  await page.locator('.cfg-page__title', { hasText: 'Memories' }).waitFor({ timeout: 10000 });
  await shot('09-bot-settings-memories');
  await page.keyboard.press('Escape');
});

await step('details tabs: library', async () => {
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
});

await step('app settings: computer screens + permissions', async () => {
  await page.locator('.rail-account__btn').click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await page.locator('.cfg-nav__item', { hasText: 'Computer' }).click();
  await page.getByText(/screens in use/i).first().waitFor({ timeout: 10000 });
  await shot('10-settings-computer');
  await page.locator('.cfg-nav__item', { hasText: 'Permissions' }).click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
});

if (botId) await api(`/api/bots/${botId}`, { method: 'DELETE' });
await browser.close();

const summary = { base: BASE, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, consoleErrors: consoleErrors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed. Console errors: ${consoleErrors.length}. Screenshots in ${OUT}`);
process.exit(summary.failed ? 1 : 0);
