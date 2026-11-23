import { beforeAll, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PageCard } from '../src/types.js';

const { runTool, toolMap } = await import('../src/agent/tools.js');
const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { libraryDir } = await import('../src/machine.js');
const { servePage, viewportHeight } = await import('../src/pages.js');
const { auth, seedBot, seedOwner } = await import('./helpers.js');
const { conversation, listRows, requireBot } = await import('../src/store.js');
const { ACCOUNT } = await import('../src/account.js');

let userId: string;
beforeAll(() => { userId = seedOwner().id; });
const ctx = (botId: string) => ({ userId, botId, workspaceId: requireBot(botId).workspace_id, convo: conversation(botId), depth: 0, asking: 0, enqueueBotMessage: () => {}, wake: () => {}, addTeammate: () => ({ error: 'not in this test' }), updatePersona: () => [], setModel: () => [], modelOffers: async () => ({ offers: [] }) });
const show = (botId: string, args: Record<string, unknown>) => runTool(toolMap.get('show_visual')!, args, ctx(botId));
const write = (file: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const cards = (botId: string) => listRows(botId).flatMap((r) => (r.body.type === 'card' && r.body.card === 'page' ? [r.body] : []));
const stored = (card: PageCard) => db.prepare<[string], { html: string }>('SELECT html FROM pages WHERE id=?').get(card.pageId)?.html;
// The start of a PNG: imageType judges by these bytes, as it would a whole picture.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('show_visual keeps the page and puts a card for it in the chat', async () => {
  const bot = seedBot(userId);
  const html = '<!doctype html><div class="chart">Rent vs. buy</div>';
  const r = await show(bot.id, { title: 'Rent vs. buy', html });
  expect(r.output).toMatch(/^Shown to the user in the chat\./);
  const [card] = cards(bot.id);
  expect(card).toMatchObject({ type: 'card', card: 'page', status: 'shown', title: 'Rent vs. buy', height: 320 });
  expect(stored(card)).toBe(html);
});

test('a page comes from an .html file in the Library, and stays as the file was when it was shown', async () => {
  const bot = seedBot(userId);
  const file = `${libraryDir(bot.id)}/charts/plan.html`;
  write(file, '<p>first</p>');
  expect((await show(bot.id, { title: 'Plan', path: 'charts/plan.html' })).output).toMatch(/^Shown/);
  expect((await show(bot.id, { title: 'Plan', path: file.replace(ACCOUNT.home, '~') })).output).toMatch(/^Shown/);
  write(file, '<p>changed</p>');
  expect(cards(bot.id).map(stored)).toEqual(['<p>first</p>', '<p>first</p>']);
});

test('a path outside the Library, through a link or not to an .html file, is refused', async () => {
  const bot = seedBot(userId);
  const outside = `${process.env.DATA_DIR}/secret.html`;
  write(outside, '<p>not the bot’s</p>');
  write(`${libraryDir(bot.id)}/notes.txt`, 'hello');
  fs.symlinkSync(outside, `${libraryDir(bot.id)}/link.html`);
  for (const p of [outside, '../secret.html', 'link.html', 'notes.txt', 'missing.html']) {
    const r = await show(bot.id, { title: 'X', path: p });
    expect(r.output, p).toMatch(/^Not shown: .* is not an \.html file in your Library/);
  }
  expect(cards(bot.id)).toEqual([]);
});

test('a page takes html or a path, not both or neither', async () => {
  const bot = seedBot(userId);
  expect((await show(bot.id, { title: 'X' })).output).toBe('Give either html or path, not both.');
  expect((await show(bot.id, { title: 'X', html: '<p>a</p>', path: 'a.html' })).output).toBe('Give either html or path, not both.');
});

test('a page that sizes itself by the viewport is refused: the frame would grow without end', async () => {
  const bot = seedBot(userId);
  const r = await show(bot.id, { title: 'X', html: '<style>main{min-height:100vh}</style><main></main>' });
  expect(r.output).toMatch(/viewport height unit \(100vh\)/);
  expect(viewportHeight('<div style="height: 50dvh"></div>')).toBe('50dvh');
  // Only CSS counts: not words on the page, a comment or base64 that happens to spell it.
  expect(viewportHeight('<p>Set it to 100vh</p><!-- <style>a{height:1vh}</style> --><img src="data:image/png;base64,AA1vhB">')).toBeUndefined();
});

test('images on the computer are copied in from the Library; web addresses are left alone', async () => {
  const bot = seedBot(userId);
  const lib = libraryDir(bot.id);
  write(`${lib}/report/chart.png`, PNG);
  write(`${lib}/bg.png`, PNG);
  write(`${lib}/report/page.html`, `<img src="chart.png"><div style="background:url('${lib}/bg.png')"></div><img src="https://example.com/a.png">`);
  expect((await show(bot.id, { title: 'Report', path: 'report/page.html' })).output).toMatch(/^Shown/);
  const uri = `data:image/png;base64,${PNG.toString('base64')}`;
  expect(stored(cards(bot.id)[0])).toBe(`<img src="${uri}"><div style="background:url('${uri}')"></div><img src="https://example.com/a.png">`);
});

test('an image outside the Library, or a file that is not a picture, is not copied in', async () => {
  const bot = seedBot(userId);
  write(`${process.env.DATA_DIR}/private.png`, PNG);
  write(`${libraryDir(bot.id)}/fake.png`, 'not a picture');
  for (const src of [`${process.env.DATA_DIR}/private.png`, 'fake.png', 'missing.png']) {
    const r = await show(bot.id, { title: 'X', html: `<img src="${src}">` });
    expect(r.output, src).toMatch(/^Not shown: These images aren't image files in your Library/);
  }
});

test("the frame's script goes first in the page's head, wherever the page starts it", () => {
  const head = '<style id="dispatch-page">';
  const served = (html: string) => servePage(html);
  expect(served('<!doctype html><html><head><title>A</title></head><body></body></html>')).toMatch(new RegExp(`^<!doctype html><html><head>${head}.*</script><title>A</title>`, 's'));
  expect(served('<html lang="en"><body>x</body></html>')).toMatch(new RegExp(`^<!doctype html><html lang="en"><head>${head}`));
  expect(served('<div>just a fragment</div>')).toMatch(new RegExp(`^<!doctype html><head>${head}.*</head><div>just a fragment</div>$`, 's'));
  // A "<head>" inside a script or a comment isn't the head.
  const tricky = served('<!doctype html><!-- <head> --><script>document.write("<head>")</script><head></head>');
  expect(tricky.indexOf(head)).toBeGreaterThan(tricky.indexOf('</script>'));
});

test('the chat frame gets the page sandboxed, and only from the bot that showed it', async () => {
  const app = createApp();
  const bot = seedBot(userId);
  const other = seedBot(userId, { name: 'Other' });
  await show(bot.id, { title: 'Chart', html: '<p>chart</p>' });
  const { pageId } = cards(bot.id)[0];
  const res = await app.request(`/api/bots/${bot.id}/pages/${pageId}`, { headers: auth() });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const csp = res.headers.get('content-security-policy')!;
  // Its own origin: no allow-same-origin, so it can't read the app or send the session cookie.
  expect(csp).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
  expect(csp).not.toMatch(/allow-same-origin/);
  expect(await res.text()).toMatch(/<style id="dispatch-page">.*<p>chart<\/p>$/s);
  expect((await app.request(`/api/bots/${other.id}/pages/${pageId}`, { headers: auth() })).status).toBe(404);
  expect((await app.request(`/api/bots/${bot.id}/pages/pg_nope`, { headers: auth() })).status).toBe(404);
  expect((await app.request(`/api/bots/${bot.id}/pages/${pageId}`)).status).toBe(401);
});

test("a bot's pages go with it", async () => {
  const bot = seedBot(userId);
  await show(bot.id, { title: 'Chart', html: '<p>chart</p>' });
  db.prepare('DELETE FROM bots WHERE id=?').run(bot.id);
  expect(db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM pages WHERE bot_id=?').get(bot.id)?.n).toBe(0);
});
