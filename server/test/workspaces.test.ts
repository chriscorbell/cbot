// Workspaces: separate teams of bots, each with its own primary bot, task board and check-ins. A bot
// knows of and reaches only the bots of its own workspace.
import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest';
import type { WorkspaceCreated, WorkspaceResponse, WorkspacesResponse, TasksResponse } from '../src/contract.js';
import type { BotRecord } from '../src/db.js';

// A greeting, a check-in or a task given is a turn: record it. Nothing starts a gateway, a screen or a unit.
const enqueued: { botId: string; trigger: { type: string; text?: string } }[] = [];
vi.mock('../src/agent/turns.js', async (orig) => ({
  ...(await orig<typeof import('../src/agent/turns.js')>()),
  enqueue: (botId: string, trigger: { type: string; text?: string }) => { enqueued.push({ botId, trigger }); },
  wake: (botId: string, depth: number) => { enqueued.push({ botId, trigger: { type: 'team', text: String(depth) } }); },
}));
const retooled: string[][] = [];
vi.mock('../src/engine.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine.js')>()),
  provisionEngine: () => {},
  removeEngine: async () => {},
  refreshTools: (ids: string[]) => { retooled.push(ids); },
}));
vi.mock('../src/computer.js', async (orig) => ({ ...(await orig<typeof import('../src/computer.js')>()), releaseScreen: async () => {}, forgetBotFiles: async () => {} }));
vi.mock('../src/units.js', async (orig) => ({ ...(await orig<typeof import('../src/units.js')>()), removeBotUnits: async () => {} }));

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { createWorkspace, defaultWorkspace } = await import('../src/workspaces.js');
const { addTeammate, updatePersona } = await import('../src/bots.js');
const { runTool, toolMap, toolsFor } = await import('../src/agent/tools.js');
const { instructionsFor } = await import('../src/agent/prompt.js');
const team = await import('../src/agent/team.js');
const store = await import('../src/store.js');
const { initProactive } = await import('../src/proactive.js');
const { auth, json, seedBot, seedOwner } = await import('./helpers.js');

const app = createApp();
let userId: string;
let personal: string;
beforeAll(() => {
  userId = seedOwner().id;
  personal = defaultWorkspace(userId).id;
  initProactive((botId, trigger) => { enqueued.push({ botId, trigger: trigger as { type: string; text?: string } }); });
});
afterEach(() => {
  enqueued.length = 0;
  retooled.length = 0;
  // Each test starts with Personal alone, empty.
  db.exec('DELETE FROM tasks; DELETE FROM team_log; DELETE FROM proactivity; DELETE FROM bots;');
  db.prepare('DELETE FROM workspaces WHERE id<>?').run(personal);
  db.prepare('UPDATE workspaces SET name=?, task_board=1 WHERE id=?').run('Personal', personal);
});

const ctx = (botId: string) => ({
  userId, botId, workspaceId: store.requireBot(botId).workspace_id, convo: store.conversation(botId), depth: 0, asking: 0,
  enqueueBotMessage: () => {}, wake: () => {}, addTeammate, updatePersona,
});
const run = (name: string, args: unknown, botId: string) => runTool(toolMap.get(name)!, args, ctx(botId));
const patch = (path: string, body: unknown) => app.request(path, { ...json(body), method: 'PATCH' });

/** Two teams: Ava and Kai in Personal, Max and Zed in Acme. Ava and Max are their workspaces' primary bots. */
function twoTeams() {
  const acme = createWorkspace(userId, 'Acme').id;
  const ava = seedBot(userId, { name: 'Ava', isPrimary: true });
  const kai = seedBot(userId, { name: 'Kai' });
  const max = seedBot(userId, { name: 'Max', isPrimary: true, workspaceId: acme });
  const zed = seedBot(userId, { name: 'Zed', workspaceId: acme });
  // Everyone has heard the news so far.
  db.prepare('UPDATE bots SET team_seen=(SELECT COALESCE(MAX(id),0) FROM team_log)').run();
  return { acme, ava, kai, max, zed };
}

test('an account starts with Personal; a new workspace comes with its primary bot, which says hello and offers check-ins', async () => {
  const list = (await (await app.request('/api/workspaces', { headers: auth() })).json()) as WorkspacesResponse;
  expect(list.workspaces.map((w) => [w.name, w.taskBoard])).toEqual([['Personal', true]]);

  expect((await app.request('/api/workspaces', json({ name: ' ', bot: { name: 'Max' } }))).status).toBe(400);
  expect((await app.request('/api/workspaces', json({ name: 'Acme', bot: { name: '' } }))).status).toBe(400);
  expect(db.prepare('SELECT COUNT(*) n FROM workspaces').get()).toEqual({ n: 1 });

  const r = await app.request('/api/workspaces', json({ name: 'Acme', bot: { name: 'Max', label: 'Product Manager' } }));
  expect(r.status).toBe(200);
  const made = (await r.json()) as WorkspaceCreated;
  expect(made.workspace).toMatchObject({ name: 'Acme', taskBoard: true, checkins: { enabled: false } });
  expect(made.bot).toMatchObject({ name: 'Max', label: 'Product Manager', isPrimary: true, workspaceId: made.workspace.id });
  expect(enqueued.map((e) => e.botId)).toEqual([made.bot.id]);
  expect(enqueued[0].trigger.text).toMatch(/check in with tess at set times each day/);

  // A bot made in Personal later is not primary: Personal's first bot is.
  seedBot(userId, { name: 'Ava', isPrimary: true });
  const more = (await (await app.request('/api/bots', json({ name: 'Kai', workspaceId: personal }))).json()) as { bot: { isPrimary: boolean; workspaceId: string } };
  expect(more.bot).toMatchObject({ isPrimary: false, workspaceId: personal });
  // A bot that isn't a workspace's first greets without the check-ins line.
  expect(enqueued.at(-1)!.trigger.text).not.toMatch(/check in/);
});

test("a bot knows of and reaches only its own workspace's bots", async () => {
  const { ava, kai, max } = twoTeams();
  const text = await instructionsFor(userId, ava.id);
  expect(text).toMatch(/on tess's team of AI agents in their Personal workspace\./);
  expect(text).toMatch(/- Kai\./);
  expect(text).not.toMatch(/Max|Zed/);

  for (const [tool, args] of [['ask_bot', { bot_name: 'Max', question: 'Hi?' }], ['check_on_bot', { bot_name: 'Max' }], ['add_task', { title: 'X', owner: 'Max' }]] as const) {
    expect((await run(tool, args, ava.id)).output).toBe('No agent named "Max". The team: Ava, Kai.');
  }
  expect((await run('send_to_bot', { bot_name: 'Max', message: 'Hi' }, ava.id)).output).toBe('No bot named "Max". Team: Ava, Kai');
  expect((await run('create_group', { name: 'Mixed', bot_names: ['Kai', 'Max'] }, ava.id)).output).toMatch(/at least 2 Bots\. Not found: Max/);
  // A group chat across workspaces can't be made from the app either.
  expect((await app.request('/api/rooms', json({ name: 'Mixed', botIds: [kai.id, max.id], workspaceId: personal }))).status).toBe(400);
});

test('each workspace has its own board and its own news', async () => {
  const { acme, ava, kai, max, zed } = twoTeams();
  await run('add_task', { title: 'Roadmap', owner: 'Zed' }, max.id);
  expect(team.listTasks(personal)).toEqual([]);
  expect(team.listTasks(acme).map((t) => t.title)).toEqual(['Roadmap']);
  expect(team.teamNews(zed.id)?.note).toMatch(/Max gave you a task: "Roadmap"/);
  expect(team.teamNews(kai.id)?.note).toBeNull();

  // The app lists every board, each task with its workspace, and puts a new one on the one it names.
  const all = (await (await app.request('/api/tasks', { headers: auth() })).json()) as TasksResponse;
  expect(all.tasks.map((t) => [t.title, t.workspaceId])).toEqual([['Roadmap', acme]]);
  expect((await app.request('/api/tasks', json({ title: 'Mixed', ownerId: kai.id, workspaceId: acme }))).status).toBe(400);
  const r = await app.request('/api/tasks', json({ title: 'Groceries', ownerId: kai.id, workspaceId: personal }));
  expect(r.status).toBe(200);
  expect(team.listTasks(personal).map((t) => t.title)).toEqual(['Groceries']);
  // Reassigning stays inside the task's workspace too.
  const [roadmap] = team.listTasks(acme);
  expect((await patch(`/api/tasks/${roadmap.id}`, { ownerId: ava.id })).status).toBe(400);
});

test('a workspace that turns its board off gives its bots no task tools, and keeps its tasks for later', async () => {
  const { acme, ava, max, zed } = twoTeams();
  team.addTask(acme, { kind: 'user' }, { title: 'Roadmap', ownerId: zed.id });

  const off = (await (await patch(`/api/workspaces/${acme}`, { taskBoard: false })).json()) as WorkspaceResponse;
  expect(off.workspace.taskBoard).toBe(false);
  // Hermes lists the tools when it connects, so the workspace's gateways restart on the new list.
  expect(retooled).toEqual([[max.id, zed.id]]);
  expect(toolsFor(max.id).map((t) => t.name)).not.toContain('list_tasks');
  expect(toolsFor(ava.id).map((t) => t.name)).toContain('list_tasks');
  expect((await run('list_tasks', {}, max.id)).output).toBe('The task board is turned off in this workspace.');
  const text = await instructionsFor(userId, max.id);
  expect(text).not.toMatch(/list_tasks|add_task|update_task|task board/);
  expect(text).toMatch(/send_to_bot sends a teammate a message/);
  expect((await app.request('/api/tasks', json({ title: 'New', workspaceId: acme }))).status).toBe(409);
  expect(team.listTasks(acme).map((t) => t.title)).toEqual(['Roadmap']);

  // Saving the same setting again restarts nothing.
  await patch(`/api/workspaces/${acme}`, { taskBoard: false });
  expect(retooled).toHaveLength(1);
  await patch(`/api/workspaces/${acme}`, { taskBoard: true });
  expect(toolsFor(max.id).map((t) => t.name)).toContain('list_tasks');
  expect((await run('list_tasks', {}, max.id)).output).toMatch(/Roadmap/);
});

test('a bot moved to another workspace leaves its old team and group chats, and joins the new team caught up', async () => {
  const { acme, ava, kai, max, zed } = twoTeams();
  const room = seedBot(userId, { kind: 'room', name: 'Crew', members: [max.id, zed.id], workspaceId: acme });
  team.addTask(acme, { kind: 'user' }, { title: 'Roadmap', ownerId: zed.id, status: 'doing' });
  team.logTeam(personal, 'Old news in Personal.');

  expect((await app.request(`/api/bots/${max.id}/move`, json({ workspaceId: personal }))).status).toBe(409);
  const r = await app.request(`/api/bots/${zed.id}/move`, json({ workspaceId: personal }));
  expect(r.status).toBe(200);
  expect(((await r.json()) as { bot: { workspaceId: string } }).bot.workspaceId).toBe(personal);

  expect(team.listTasks(acme)).toMatchObject([{ title: 'Roadmap', ownerId: null, previousOwner: 'Zed', status: 'todo' }]);
  expect(JSON.parse(store.requireBot(room.id).members!)).toEqual([max.id]);
  expect(team.teamNews(max.id)?.note).toMatch(/Zed moved to another workspace\. Their open tasks have nobody now: "Roadmap"/);
  expect(team.teamNews(ava.id)?.note).toMatch(/Zed joined the team\./);
  expect(team.teamNews(kai.id)?.note).toMatch(/Zed joined the team\./);
  // Zed starts caught up: it doesn't hear the news from before it came, nor its own arrival.
  expect(team.teamNews(zed.id)?.note).toBeNull();
  expect(await instructionsFor(userId, zed.id)).toMatch(/- Ava \(tess's main point of contact\)\..*\n- Kai\./);
  // Both boards were on: its tools stay the same, so nothing restarts.
  expect(retooled).toEqual([]);
});

test("only the primary bot adds an agent, to its own workspace; the new one says hello, under a free name, while there is room", async () => {
  const { acme, kai, max, zed } = twoTeams();
  const { env } = await import('../src/env.js');
  const limit = env.maxBots;
  env.maxBots = 5;
  onTestFinished(() => { env.maxBots = limit; });
  // Any other bot is told to ask the primary bot, which decides.
  expect((await run('create_bot', { name: 'Scout' }, zed.id)).output).toBe("Only Max, the team's primary bot, can add an agent to the team. If it's needed, ask them with send_to_bot; they decide.");

  // Even when a teammate asked it: the primary bot decides.
  const r = await runTool(toolMap.get('create_bot')!, { name: ' Scout ', label: 'Researcher', about: 'Tracks AI news', instructions: 'Daily digest at 8.' }, { ...ctx(max.id), depth: 1 });
  expect(r.summary).toBe('Added Scout');
  const scout = db.prepare<[], BotRecord>("SELECT * FROM bots WHERE name='Scout'").get()!;
  expect([scout.workspace_id, scout.label, scout.description, scout.instructions, scout.is_primary]).toEqual([acme, 'Researcher', 'Tracks AI news', 'Daily digest at 8.', 0]);
  // It greets the user, saying who added it, and asks nothing: Max hands it its work.
  expect(enqueued.map((e) => e.botId)).toEqual([scout.id]);
  expect(enqueued[0].trigger.text).toContain('Max just added you');
  expect(enqueued[0].trigger.text).not.toContain('ask_user');
  // Acme's team hears it joined; Personal's doesn't.
  expect(team.teamNews(zed.id)?.note).toMatch(/Scout.*joined the team\./);
  expect(team.teamNews(kai.id)?.note).toBeNull();

  // A name already on the team, a group chat's included, is refused, whatever its case.
  seedBot(userId, { name: 'Ops', kind: 'room', workspaceId: acme });
  expect((await run('create_bot', { name: 'scout' }, max.id)).output).toBe('This workspace already has a bot called Scout. Pick another name.');
  expect((await run('create_bot', { name: 'ops' }, max.id)).output).toBe('This workspace already has a group chat called Ops. Pick another name.');
  // The computer has room for so many bots (5 here); the next one is refused with the reason.
  expect((await run('create_bot', { name: 'Echo' }, max.id))).toMatchObject({ output: expect.stringMatching(/^The team is full/), summary: 'Not added' });
  expect(db.prepare("SELECT COUNT(*) n FROM bots WHERE kind<>'room'").get()).toEqual({ n: 5 });
});

test("the primary bot changes a teammate's label, About and instructions; the teammate and the user see it", async () => {
  const { max, zed } = twoTeams();
  db.prepare("UPDATE bots SET label='Ops', instructions='Old.' WHERE id=?").run(zed.id);
  expect((await run('update_bot', { bot_name: 'Max', label: 'Boss' }, zed.id)).output).toMatch(/^Only Max, the team's primary bot, can change/);
  // Its own workspace's bots only, and not itself.
  expect((await run('update_bot', { bot_name: 'Kai', label: 'X' }, max.id)).output).toMatch(/^No agent named "Kai"/);
  expect((await run('update_bot', { bot_name: 'Max', label: 'X' }, max.id)).output).toBe('That is you.');

  const r = await run('update_bot', { bot_name: 'zed', label: 'Ops', about: ' Runs the servers ', instructions: 'Page me at night.' }, max.id);
  expect(r.output).toBe("Changed Zed's About and instructions. They follow it from their next turn.");
  expect(store.requireBot(zed.id)).toMatchObject({ label: 'Ops', description: 'Runs the servers', instructions: 'Page me at night.' });
  // A line in Zed's chat for the user. Zed's agent reads the new ones in its instructions at its next turn.
  expect(store.listRows(zed.id).map((row) => row.body)).toContainEqual({ type: 'event', event: 'bot-message', text: "Max changed Zed's About and instructions" });
  expect(await instructionsFor(userId, zed.id)).toContain('Page me at night.');
  expect((await run('update_bot', { bot_name: 'Zed', label: 'Ops' }, max.id)).output).toBe("Nothing changed: Zed's are already that.");
});

test("the primary bot sets up and changes a teammate's routines; other bots only their own", async () => {
  const { ava, max, zed } = twoTeams();
  const { listRoutines } = store;
  expect((await run('create_routine', { name: 'Digest', prompt: 'p', schedule: '0 8 * * *', bot_name: 'Max' }, zed.id)).output).toMatch(/^Only Max, the team's primary bot, can manage/);
  expect((await run('list_routines', { bot_name: 'Max' }, zed.id)).output).toMatch(/^Only Max/);

  const made = await run('create_routine', { name: 'Digest', prompt: 'Send the AI news.', schedule: '0 8 * * *', bot_name: 'Zed' }, max.id);
  expect(made.summary).toBe('Created routine Digest for Zed');
  const [rt] = listRoutines(zed.id);
  expect(rt).toMatchObject({ name: 'Digest', prompt: 'Send the AI news.' });
  expect(listRoutines(max.id)).toEqual([]);
  expect(store.listRows(zed.id).map((row) => row.body)).toContainEqual({ type: 'event', event: 'routine-created', text: 'Max set up a routine: Digest · Every day at 8:00 AM', ref: rt.id });
  expect(await instructionsFor(userId, zed.id)).toContain('Digest');
  expect(JSON.parse((await run('list_routines', { bot_name: 'Zed' }, max.id)).output)).toHaveLength(1);

  // Zed may change its own; Max may change Zed's; neither reaches another workspace's.
  expect((await run('update_routine', { routine_id: rt.id, enabled: false }, max.id)).output).toContain('"enabled":false');
  expect((await run('update_routine', { routine_id: rt.id, enabled: true }, zed.id)).output).toContain('"enabled":true');
  expect((await run('delete_routine', { routine_id: rt.id }, ava.id)).output).toBe('No such routine.');
  expect((await run('delete_routine', { routine_id: rt.id }, max.id)).output).toBe('Deleted.');
  expect(listRoutines(zed.id)).toEqual([]);
  expect(store.listRows(zed.id).map((row) => (row.body.type === 'event' ? row.body.text : ''))).toEqual(expect.arrayContaining(['Max updated a routine: Digest · Paused', 'Max removed a routine: Digest']));
});

test('a name is used once in a workspace, by a bot or a group chat, whatever its case: bots find each other by name', async () => {
  const { acme, ava, kai } = twoTeams();
  const taken = { error: 'This workspace already has a bot called Kai.' };
  // Renaming to a teammate's name, making a bot or a group chat under it.
  let res = await patch(`/api/bots/${ava.id}`, { name: 'KAI' });
  expect([res.status, await res.json()]).toEqual([409, taken]);
  res = await app.request('/api/bots', json({ name: 'Kai' }));
  expect([res.status, await res.json()]).toEqual([409, taken]);
  res = await app.request('/api/rooms', json({ name: ' kai ', botIds: [ava.id, kai.id] }));
  expect([res.status, await res.json()]).toEqual([409, taken]);
  expect((await app.request('/api/rooms', json({ name: 'Crew', botIds: [ava.id, kai.id] }))).status).toBe(200);
  expect((await run('create_group', { name: 'crew', bot_names: ['Ava', 'Kai'] }, kai.id)).output).toBe('This workspace already has a group chat called Crew. Pick another name.');

  // A name only another workspace uses is free, and a bot keeps its own in another case; but it can't
  // move into the workspace that has it (Acme has a Zed).
  expect((await patch(`/api/bots/${kai.id}`, { name: 'Zed' })).status).toBe(200);
  expect((await patch(`/api/bots/${kai.id}`, { name: 'zed' })).status).toBe(200);
  res = await app.request(`/api/bots/${kai.id}/move`, json({ workspaceId: acme }));
  expect([res.status, await res.json()]).toEqual([409, { error: 'This workspace already has a bot called Zed. Rename one of them first.' }]);
  expect(store.requireBot(kai.id).workspace_id).not.toBe(acme);
});

test('making a bot primary changes only its own workspace', async () => {
  const { ava, kai, max } = twoTeams();
  expect((await app.request(`/api/bots/${kai.id}/primary`, json({}))).status).toBe(200);
  expect([ava, kai, max].map((b) => store.requireBot(b.id).is_primary)).toEqual([0, 1, 1]);
});

test("each workspace has its own check-ins, and its primary bot checks in on its own workspace", async () => {
  const { acme, max, zed } = twoTeams();
  team.addTask(acme, { kind: 'user' }, { title: 'Ship the beta', ownerId: zed.id, status: 'blocked' });

  const set = (await (await patch(`/api/workspaces/${acme}`, { checkins: { enabled: true, times: ['08:00', '25:00', '07:30', '08:00'], timezone: 'Europe/Paris' } })).json()) as WorkspaceResponse;
  expect(set.workspace.checkins).toEqual({ enabled: true, times: ['07:30', '08:00'], timezone: 'Europe/Paris' });
  const list = (await (await app.request('/api/workspaces', { headers: auth() })).json()) as WorkspacesResponse;
  expect(list.workspaces.find((w) => w.id === personal)!.checkins.enabled).toBe(false);
  expect((await patch(`/api/workspaces/${acme}`, { checkins: { timezone: 'Mars/Olympus' } })).status).toBe(400);

  expect((await app.request(`/api/workspaces/${acme}/checkin`, json({}))).status).toBe(200);
  expect(enqueued.map((e) => e.botId)).toEqual([max.id]);
  expect(enqueued[0].trigger.text).toMatch(/\[check-in\]/);
  expect(enqueued[0].trigger.text).toMatch(/Team: Zed/);
  expect(enqueued[0].trigger.text).toMatch(/Blocked: "Ship the beta" \(Zed\)/);
  expect(enqueued[0].trigger.text).not.toMatch(/Ava|Kai/);

  // The set_checkins tool changes the bot's own workspace's.
  await run('set_checkins', { enabled: false }, max.id);
  expect(list.workspaces.length).toBe(2);
  const after = (await (await app.request('/api/workspaces', { headers: auth() })).json()) as WorkspacesResponse;
  expect(after.workspaces.find((w) => w.id === acme)!.checkins).toEqual({ enabled: false, times: ['07:30', '08:00'], timezone: 'Europe/Paris' });
});

test('deleting a workspace deletes its bots, board and check-ins; the last one stays', async () => {
  const { acme, ava, kai } = twoTeams();
  team.addTask(acme, { kind: 'user' }, { title: 'Roadmap' });
  await patch(`/api/workspaces/${acme}`, { checkins: { enabled: true } });

  expect((await app.request(`/api/workspaces/${acme}`, { method: 'DELETE', headers: auth() })).status).toBe(200);
  expect(db.prepare('SELECT name FROM bots ORDER BY name').all()).toEqual([{ name: 'Ava' }, { name: 'Kai' }]);
  expect(db.prepare('SELECT COUNT(*) n FROM tasks').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM proactivity').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT id FROM workspaces').all()).toEqual([{ id: personal }]);
  expect(team.teamNews(ava.id)?.note).toBeNull();
  expect(store.getBotRow(kai.id)).toBeDefined();

  const last = await app.request(`/api/workspaces/${personal}`, { method: 'DELETE', headers: auth() });
  expect(last.status).toBe(409);
  expect(await last.json()).toEqual({ error: 'This is your only workspace.' });
});

test("another user's workspace is not found", async () => {
  db.prepare("INSERT INTO users(id,created_at) VALUES ('usr_other', 0)").run();
  const theirs = createWorkspace('usr_other', 'Theirs').id;
  expect((await patch(`/api/workspaces/${theirs}`, { name: 'Mine' })).status).toBe(404);
  expect((await app.request(`/api/workspaces/${theirs}`, { method: 'DELETE', headers: auth() })).status).toBe(404);
  const ava = seedBot(userId, { name: 'Ava', isPrimary: true });
  const kai = seedBot(userId, { name: 'Kai' });
  expect((await app.request(`/api/bots/${kai.id}/move`, json({ workspaceId: theirs }))).status).toBe(404);
  expect(store.requireBot(ava.id).workspace_id).toBe(personal);
  db.prepare("DELETE FROM users WHERE id='usr_other'").run();
});
