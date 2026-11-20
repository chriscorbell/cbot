import { beforeAll, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Removing a memory holds Hermes' lock through util-linux flock, a child process tests can't start:
// record which lock was asked for and run the change straight away.
const locks: string[] = [];
vi.mock('../src/lib/flock.js', () => ({
  withFileLock: async (lockPath: string, _wait: number, fn: () => unknown) => { locks.push(lockPath); return fn(); },
}));

// The Skills and Memories tabs: what the bot is given from a skill, and how its Hermes memory reads.
const { db, now } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hub } = await import('../src/lib/hub.js');
const { instructionsFor } = await import('../src/agent/prompt.js');
const { checkMemories, deleteMemory, listMemories } = await import('../src/engine-memory.js');
const { seedBot, seedOwner } = await import('./helpers.js');

let user: ReturnType<typeof seedOwner>;
let bot: ReturnType<typeof seedBot>;

beforeAll(() => {
  user = seedOwner();
  bot = seedBot(user.id, { name: 'Ada' });
});

const skill = (name: string, description: string, body: string) =>
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(`sk_${name}`, bot.id, name, body, description, now(), now());

test('the bot is told when to use a skill, not only its steps', async () => {
  skill('Weekly report', 'Fridays, or when asked for a recap', '1. Read the week\n2. Write three bullets');
  skill('Inbox sweep', '  ', 'Archive newsletters');
  const text = await instructionsFor(user.id, bot.id);
  expect(text).toContain('### Weekly report\nUse it: Fridays, or when asked for a recap\n1. Read the week\n2. Write three bullets');
  // No "when" line for a skill without one (blank counts as none).
  expect(text).toContain('### Inbox sweep\nArchive newsletters');
});

test("a group's About and Instructions reach its bots, and only its bots", async () => {
  const other = seedBot(user.id, { name: 'Bea' });
  const standup = seedBot(user.id, { name: 'Standup', kind: 'room', members: [bot.id, other.id] });
  seedBot(user.id, { name: 'Quiet', kind: 'room', members: [bot.id] });
  seedBot(user.id, { name: 'Elsewhere', kind: 'room', members: [other.id] });
  db.prepare("UPDATE bots SET description=?, instructions=? WHERE id=?").run('Morning check-in', 'One line each.', standup.id);
  db.prepare("UPDATE bots SET instructions=? WHERE name='Elsewhere'").run('Only Bea posts here.');

  const text = await instructionsFor(user.id, bot.id);
  expect(text).toContain('- Group chats you are in: Standup, Quiet');
  expect(text).toContain("## Group chats\nWhat tess set for the groups you are in. Follow a group's instructions when you post there.\n### Standup\nAbout: Morning check-in\nInstructions: One line each.\n");
  // A group with nothing set gets no entry, and another group's rules stay with its own bots.
  expect(text).not.toContain('### Quiet');
  expect(text).not.toContain('Only Bea posts here.');
});

const memoryDir = (botId: string) => {
  db.prepare("UPDATE bots SET engine='managed' WHERE id=?").run(botId);
  const dir = path.join(env.enginesDir, botId, 'memories');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

test("memories read as what the bot knows about the user, then its own notes, with no dates", async () => {
  const dir = memoryDir(bot.id);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'The repo is at ~/code\n§\nUse pnpm\n');
  fs.writeFileSync(path.join(dir, 'USER.md'), 'Name is Tess\n');

  const list = listMemories(bot.id);
  expect(list.map((m) => [m.source, m.text])).toEqual([['user', 'Name is Tess'], ['notes', 'The repo is at ~/code'], ['notes', 'Use pnpm']]);
  expect(list[0]).not.toHaveProperty('createdAt');

  expect(await deleteMemory(list[1].id)).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe('Use pnpm');
  expect(listMemories(bot.id).map((m) => m.text)).toEqual(['Name is Tess', 'Use pnpm']);
});

test('forgetting a memory holds the lock Hermes writes under and replaces the file whole', async () => {
  const b = seedBot(user.id, { name: 'Lock' });
  const dir = memoryDir(b.id);
  const file = path.join(dir, 'USER.md');
  // A repeat (Hermes drops them too) and a byte-order mark from a hand edit.
  fs.writeFileSync(file, '\uFEFFLikes tea\n§\nLives in Leeds\n§\nLikes tea', { mode: 0o600 });
  const ino = fs.statSync(file).ino;
  const [tea] = listMemories(b.id);
  expect(listMemories(b.id).map((m) => m.text)).toEqual(['Likes tea', 'Lives in Leeds']);

  locks.length = 0;
  expect(await deleteMemory(tea.id)).toBe(true);
  expect(locks).toEqual([`${file}.lock`]);
  expect(fs.readFileSync(file, 'utf8')).toBe('Lives in Leeds');
  // Renamed over, keeping its mode, with no temporary file left behind.
  expect(fs.statSync(file).ino).not.toBe(ino);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(dir).sort()).toEqual(['USER.md']);
  // Gone already: nothing to remove.
  expect(await deleteMemory(tea.id)).toBe(false);
});

test('a memory file that is not UTF-8 is left alone', async () => {
  const b = seedBot(user.id, { name: 'Bytes' });
  const file = path.join(memoryDir(b.id), 'MEMORY.md');
  const raw = Buffer.concat([Buffer.from('Use pnpm\n§\n'), Buffer.from([0xff, 0xfe]), Buffer.from(' broken')]);
  fs.writeFileSync(file, raw);
  const [first] = listMemories(b.id);
  await expect(deleteMemory(first.id)).rejects.toThrow(/can’t be read safely/);
  expect(fs.readFileSync(file).equals(raw)).toBe(true);
});

test('a change to a bot’s memory files tells the app, once', () => {
  const b = seedBot(user.id, { name: 'Watch' });
  const dir = memoryDir(b.id);
  const events: unknown[] = [];
  const off = hub.subscribe(user.id, (ev) => { if (ev.type === 'memories') events.push(ev); });
  checkMemories(); // the first look only records
  expect(events).toEqual([]);
  fs.writeFileSync(path.join(dir, 'USER.md'), 'Name is Tess');
  checkMemories();
  checkMemories();
  expect(events).toEqual([{ type: 'memories', botId: b.id }]);
  off();
});
