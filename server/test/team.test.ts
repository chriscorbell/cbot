// The team: its task board, what each agent hears about the team and when it is woken for it, the
// org chart in each bot's instructions, and one bot asking another a question.
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { EventBody } from '../src/types.js';
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

const team = await import('../src/agent/team.js');
const turns = await import('../src/agent/turns.js');
const { runTool, toolMap } = await import('../src/agent/tools.js');
const { instructionsFor } = await import('../src/agent/prompt.js');
const { sideNews } = await import('../src/agent/catchup.js');
const store = await import('../src/store.js');
const { db } = await import('../src/db.js');
const { seedBot, seedOwner } = await import('./helpers.js');
const { defaultWorkspace } = await import('../src/workspaces.js');

let userId: string;
beforeAll(() => { userId = seedOwner().id; });
/** The user's first workspace, where seedBot puts every bot. */
const ws = () => defaultWorkspace(userId).id;
afterEach(() => {
  vi.unstubAllGlobals();
  // Each test starts with a team of its own: no bots, an empty board and no news.
  db.exec('DELETE FROM tasks; DELETE FROM team_log; DELETE FROM bots;');
});

const woken: [string, number][] = [];
const ctx = (botId: string, o: { depth?: number; asking?: number } = {}) => ({
  userId, botId, workspaceId: store.requireBot(botId).workspace_id, convo: store.conversation(botId), depth: o.depth ?? 0, asking: o.asking ?? 0,
  enqueueBotMessage: () => {}, wake: (id: string, depth: number) => { woken.push([id, depth]); }, addTeammate: () => ({ error: 'not in this test' }), updatePersona: () => [],
});
const run = (name: string, args: unknown, c: ReturnType<typeof ctx>) => runTool(toolMap.get(name)!, args, c);

/** A team of agents with roles, each caught up on the team's news. */
function crew(...names: string[]) {
  return names.map((name) => {
    const b = seedBot(userId, { name });
    db.prepare('UPDATE bots SET label=?, team_seen=(SELECT COALESCE(MAX(id),0) FROM team_log) WHERE id=?').run(`${name} role`, b.id);
    return store.requireBot(b.id);
  });
}

const news = (botId: string) => team.teamNews(botId)?.note ?? null;
const events = (botId: string) => store.listRows(botId).filter((r) => r.kind === 'event').map((r) => r.body as EventBody);

describe('the task board', () => {
  test('a task given to a teammate is theirs, they hear it, it shows in their chat, and they are woken', async () => {
    woken.length = 0;
    const [pm, eng] = crew('Pam', 'Eli');
    const r = await run('add_task', { title: 'Build the login API', notes: 'OAuth only', owner: 'eli' }, ctx(pm.id, { depth: 1 }));
    expect(r.output).toMatch(/^Added task_.*Eli was told and starts on it\.$/);
    const [task] = team.listTasks(ws());
    expect(task).toMatchObject({ title: 'Build the login API', notes: 'OAuth only', status: 'todo', ownerId: eng.id, createdBy: { id: pm.id, name: 'Pam' } });
    expect(woken).toEqual([[eng.id, 2]]);
    expect(news(eng.id)).toMatch(/Pam gave you a task: "Build the login API" \(task_.+\)\. Notes: OAuth only/);
    expect(news(pm.id)).toBeNull();
    expect(events(eng.id).map((e) => [e.event, e.text])).toEqual([['task', 'Pam gave Eli a task: Build the login API']]);
  });

  test('a task of your own, or of nobody yet, wakes nobody and tells nobody', async () => {
    woken.length = 0;
    const [pm, eng] = crew('Pam', 'Eli');
    await run('add_task', { title: 'Write the roadmap' }, ctx(pm.id));
    await run('add_task', { title: 'Pick a logo', owner: 'nobody' }, ctx(pm.id));
    expect(team.listTasks(ws()).map((t) => [t.title, t.ownerId]).sort()).toEqual([['Pick a logo', null], ['Write the roadmap', pm.id]]);
    expect(woken).toEqual([]);
    expect(news(eng.id)).toBeNull();
  });

  test('a long enough chain of hops gives the task without waking its owner', async () => {
    woken.length = 0;
    const [pm] = crew('Pam', 'Eli');
    const r = await run('add_task', { title: 'Later', owner: 'Eli' }, ctx(pm.id, { depth: team.MAX_HOPS }));
    expect(r.output).toMatch(/Eli will see it at their next turn/);
    expect(woken).toEqual([]);
  });

  test('the owner hears what a teammate changed, and whoever asked for it hears it got done and is woken', async () => {
    woken.length = 0;
    const [pm, eng, des] = crew('Pam', 'Eli', 'Dee');
    const { task } = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Login page', ownerId: eng.id });
    team.markTeamSeen(eng.id, team.teamNews(eng.id)!.upTo);
    await run('update_task', { task_id: task.id, note: 'Use the new colours' }, ctx(des.id));
    expect(news(eng.id)).toMatch(/Dee changed your task "Login page" \(task_.+\): noted: Use the new colours\./);
    expect(team.listTasks(ws())[0].notes).toBe('Dee: Use the new colours');
    expect(woken).toEqual([]);
    const r = await run('update_task', { task_id: task.id, status: 'done', note: 'Live at /login, screenshots in ~/shots' }, ctx(eng.id, { depth: 1 }));
    expect(r.output).toMatch(/Pam, who created it, was told\.$/);
    expect(woken).toEqual([[pm.id, 2]]);
    expect(news(pm.id)).toMatch(/Eli finished "Login page" \(task_.+\), a task you created\. Note: Live at \/login, screenshots in ~\/shots/);
    expect(news(des.id)).toBeNull();
    // Done is told once: another change to the finished task wakes nobody.
    woken.length = 0;
    await run('update_task', { task_id: task.id, note: 'Also on staging' }, ctx(eng.id));
    expect(woken).toEqual([]);
  });

  test('a task getting stuck wakes whoever asked for it, with why', async () => {
    woken.length = 0;
    const [pm, eng] = crew('Pam', 'Eli');
    const { task } = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Deploy', ownerId: eng.id });
    const r = await run('update_task', { task_id: task.id, status: 'blocked', note: 'Need the API key' }, ctx(eng.id));
    expect(r.output).toMatch(/Pam, who created it, was told\.$/);
    expect(woken).toEqual([[pm.id, 1]]);
    expect(news(pm.id)).toMatch(/Eli marked "Deploy" \(task_.+\), a task you created, blocked\. Note: Need the API key/);
  });

  test("finishing a task you created yourself, or your own, wakes nobody", async () => {
    woken.length = 0;
    const [pm, eng] = crew('Pam', 'Eli');
    const mine = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Roadmap', ownerId: pm.id }).task;
    const given = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Icons', ownerId: eng.id }).task;
    await run('update_task', { task_id: mine.id, status: 'done' }, ctx(pm.id));
    await run('update_task', { task_id: given.id, status: 'done' }, ctx(pm.id));
    // Eli's own task, which Eli made, finished by Pam: Eli hears it as its owner, and isn't woken.
    const theirs = team.addTask(ws(), { kind: 'bot', id: eng.id, name: 'Eli' }, { title: 'Tests', ownerId: eng.id }).task;
    await run('update_task', { task_id: theirs.id, status: 'done' }, ctx(pm.id));
    expect(woken).toEqual([]);
  });

  test('a long enough chain of hops tells the creator without waking it', async () => {
    woken.length = 0;
    const [pm, eng] = crew('Pam', 'Eli');
    const { task } = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Later', ownerId: eng.id });
    const r = await run('update_task', { task_id: task.id, status: 'done' }, ctx(eng.id, { depth: team.MAX_HOPS }));
    expect(r.output).toMatch(/Pam, who created it, will see it at their next turn/);
    expect(woken).toEqual([]);
    expect(news(pm.id)).toMatch(/Eli finished "Later"/);
  });

  test('moving a task gives it to the new owner and tells the old one', async () => {
    woken.length = 0;
    const [pm, eng, des] = crew('Pam', 'Eli', 'Dee');
    const { task } = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Icons', ownerId: eng.id });
    team.markTeamSeen(eng.id, team.teamNews(eng.id)!.upTo);
    await run('update_task', { task_id: task.id, owner: 'Dee' }, ctx(pm.id));
    expect(woken).toEqual([[des.id, 1]]);
    expect(news(des.id)).toMatch(/Pam gave you a task: "Icons"/);
    expect(news(eng.id)).toMatch(/Pam moved your task "Icons" \(task_.+\) to Dee\./);
  });

  test('list_tasks shows the board by owner, open tasks first', async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    team.addTask(ws(), { kind: 'user' }, { title: 'Ship it', ownerId: eng.id, status: 'doing' });
    team.addTask(ws(), { kind: 'user' }, { title: 'Old', ownerId: eng.id, status: 'done' });
    team.addTask(ws(), { kind: 'user' }, { title: 'Spare' });
    const mine = await run('list_tasks', { owner: 'Eli' }, ctx(pm.id));
    expect(mine.output).toMatch(/^- \[doing\] Ship it \(task_.+\) · owner: Eli · from tess$/);
    expect((await run('list_tasks', { owner: 'nobody' }, ctx(pm.id))).output).toMatch(/Spare/);
    expect((await run('list_tasks', { owner: 'Eli', include_done: true }, ctx(pm.id))).output.split('\n')).toHaveLength(2);
    expect((await run('list_tasks', { owner: 'Zed' }, ctx(pm.id))).output).toMatch(/No agent named "Zed"/);
  });
});

describe('the team changing', () => {
  test('a new bot starts caught up, and the others hear it joined', () => {
    const [pm] = crew('Pam');
    team.logTeam(ws(), 'Something from before.');
    team.markTeamSeen(pm.id, team.teamNews(pm.id)!.upTo);
    const nova = seedBot(userId, { name: 'Nova' });
    db.prepare("UPDATE bots SET label='Engineer' WHERE id=?").run(nova.id);
    team.teamJoined(store.requireBot(nova.id));
    expect(news(nova.id)).toBeNull();
    expect(news(pm.id)).toMatch(/Nova \(Engineer\) joined the team\./);
  });

  test("a bot that leaves hands its open tasks back, saying whose they were, and the others hear which", () => {
    const [pm, eng] = crew('Pam', 'Eli');
    const doing = team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Login API', ownerId: eng.id, status: 'doing' }).task;
    const done = team.addTask(ws(), { kind: 'user' }, { title: 'Spec', ownerId: eng.id, status: 'done' }).task;
    team.markTeamSeen(pm.id, team.teamNews(pm.id)!.upTo);
    team.teamLeft(eng);
    const byId = new Map(team.listTasks(ws()).map((t) => [t.id, t]));
    expect(byId.get(doing.id)).toMatchObject({ ownerId: null, previousOwner: 'Eli', status: 'todo' });
    expect(byId.get(done.id)).toMatchObject({ ownerId: null, previousOwner: 'Eli', status: 'done' });
    expect(news(pm.id)).toMatch(/Eli \(Eli role\) was removed from the team\. Their open tasks have nobody now: "Login API" \(task_.+\)\./);
    expect(db.prepare('SELECT COUNT(*) n FROM team_log WHERE audience=?').get(eng.id)).toEqual({ n: 0 });
  });

  test('news is told once, and a note says how much was left out', () => {
    const [pm] = crew('Pam');
    for (let i = 0; i < 20; i++) team.logTeam(ws(), `Entry ${i}.`);
    const n = team.teamNews(pm.id)!;
    expect(n.note).toMatch(/\(5 earlier left out\)/);
    expect(n.note).toMatch(/Entry 19\./);
    team.markTeamSeen(pm.id, n.upTo);
    expect(news(pm.id)).toBeNull();
  });
});

describe('a wake-up', () => {
  test('runs with the team news and marks it told', async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Fix the build', ownerId: eng.id });
    const h = fakeHermes([ev.completed('On it.')]);
    turns.wake(eng.id, 1);
    await turns.whenIdle(eng.id);
    expect(String(h[0].input)).toMatch(/^\[Team news since your last turn, oldest first:\n- Pam gave you a task: "Fix the build"[^]*\]\n\n\[The team news above is why you are running now\./);
    expect(news(eng.id)).toBeNull();
  });

  test('is skipped once an earlier turn has told its news', async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    team.addTask(ws(), { kind: 'bot', id: pm.id, name: 'Pam' }, { title: 'Fix the build', ownerId: eng.id });
    const h = fakeHermes([ev.completed('Sure.')]);
    turns.enqueue(eng.id, { type: 'user', text: 'hi' });
    turns.wake(eng.id, 1);
    await turns.whenIdle(eng.id);
    expect(h).toHaveLength(1);
    expect(String(h[0].input)).toMatch(/Pam gave you a task[^]*\]\n\nhi$/);
  });

  test('waits in the queue once however often the bot is given tasks', async () => {
    const [, eng] = crew('Pam', 'Eli');
    const hold = gate();
    fakeHermes([hold.opened, ev.completed('First.')], [ev.completed('Second.')]);
    turns.enqueue(eng.id, { type: 'user', text: 'hi' });
    turns.wake(eng.id, 1);
    turns.wake(eng.id, 1);
    expect(db.prepare("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND trigger LIKE '%\"team\"%'").get(eng.id)).toEqual({ n: 1 });
    hold.open();
    await turns.whenIdle(eng.id);
  });
});

describe('the org chart', () => {
  test("each bot's instructions list its teammates' roles and how the team works", async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    db.prepare("UPDATE bots SET description='Owns the backend and the API.' WHERE id=?").run(eng.id);
    const text = await instructionsFor(userId, pm.id);
    expect(text).toContain(`- Eli, Eli role: Owns the backend and the API. Library: ~/dispatch/files/${eng.id}/`);
    expect(text).toMatch(/ask_bot asks them and gives you their answer in this turn/);
    expect(text).not.toContain('- Pam,');
    // Nothing in it moves as the team works, so the prompt cache holds.
    team.addTask(ws(), { kind: 'user' }, { title: 'Anything', ownerId: pm.id });
    expect(await instructionsFor(userId, pm.id)).toBe(text);
  });

  test('a bot alone is told so, with no teamwork section', async () => {
    db.prepare("INSERT OR IGNORE INTO users(id,username,created_at) VALUES ('usr_alone','ann',0)").run();
    const only = seedBot('usr_alone', { name: 'Solo' });
    const text = await instructionsFor('usr_alone', only.id);
    expect(text).toMatch(/You are the only agent on the team so far\./);
    expect(text).not.toMatch(/## Your team/);
  });

  test('check_on_bot shows where a teammate stands', async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    db.prepare("UPDATE bots SET instructions='Always write tests.' WHERE id=?").run(eng.id);
    team.addTask(ws(), { kind: 'user' }, { title: 'Login API', ownerId: eng.id, status: 'doing' });
    store.appendRow(eng.id, 'message', { type: 'message', role: 'user', text: 'How is login going?' });
    const r = await run('check_on_bot', { bot_name: 'Eli' }, ctx(pm.id));
    expect(r.output).toMatch(/^# Eli, Eli role/);
    expect(r.output).toMatch(/## Instructions from tess\nAlways write tests\./);
    expect(r.output).toMatch(/## Tasks\n- \[doing\] Login API/);
    expect(r.output).toMatch(/## Right now\nIdle/);
    expect(r.output).toMatch(/tess: How is login going\?/);
    expect((await run('check_on_bot', { bot_name: 'Pam' }, ctx(pm.id))).output).toBe('That is you.');
  });
});

describe('ask_bot', () => {
  test("gets the teammate's answer from a side conversation, and records both sides in both chats", async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    const h = fakeHermes([ev.text('About half done.'), ev.completed('About half done.')]);
    const r = await run('ask_bot', { bot_name: 'Eli', question: 'How far along is login?' }, ctx(pm.id));
    expect(r.output).toBe('Eli answered:\nAbout half done.');
    expect(h[0].session_id).toBe(`dispatch-${eng.id}-ask-${pm.id}-g1`);
    expect(String(h[0].instructions)).toMatch(/# A teammate is asking you something\nPam, Pam role, is another agent on tess's team\./);
    expect(String(h[0].input)).toMatch(/\n\nHow far along is login\?$/);
    for (const id of [pm.id, eng.id]) {
      expect(events(id).map((e) => e.ask)).toEqual([{ from: { id: pm.id, name: 'Pam' }, to: { id: eng.id, name: 'Eli' }, question: 'How far along is login?', status: 'answered', answer: 'About half done.' }]);
    }
    // Eli's chat hears what it answered at its next turn; Pam's turn already has it.
    expect(sideNews(eng.id, 1)?.note).toMatch(/Pam asked you, just now: How far along is login\?\nYou answered: About half done\./);
    expect(sideNews(pm.id, 1)?.note).toBeNull();
  });

  test("a question still being answered isn't told to the chat until it has its answer", async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    const hold = gate();
    fakeHermes([hold.opened, ev.completed('Yes.')]);
    const asked = run('ask_bot', { bot_name: 'Eli', question: 'Ready?' }, ctx(pm.id));
    await vi.waitFor(() => expect(events(eng.id)).toHaveLength(1));
    expect(sideNews(eng.id, 1)).toEqual({ note: null, upTo: 0 });
    hold.open();
    await asked;
    expect(sideNews(eng.id, 1)?.note).toMatch(/You answered: Yes\./);
  });

  test('a failed run is a failed question, said to the asker', async () => {
    const [pm, eng] = crew('Pam', 'Eli');
    fakeHermes([ev.failed('model overloaded')]);
    const r = await run('ask_bot', { bot_name: 'Eli', question: 'Ready?' }, ctx(pm.id));
    expect(r.output).toBe("Eli didn't answer: model overloaded.");
    expect(events(eng.id)[0].ask).toMatchObject({ status: 'failed', answer: 'model overloaded' });
  });

  test('a stopped turn calls its question off', async () => {
    const [pm] = crew('Pam', 'Eli');
    fakeHermes([gate().opened]);
    const stop = new AbortController();
    const asked = run('ask_bot', { bot_name: 'Eli', question: 'Ready?' }, { ...ctx(pm.id), signal: stop.signal } as ReturnType<typeof ctx>);
    await vi.waitFor(() => expect(events(pm.id)).toHaveLength(1));
    stop.abort();
    expect((await asked).output).toBe("Eli didn't answer: the question was called off.");
  });

  test('chains of questions stop two deep', async () => {
    const [pm] = crew('Pam', 'Eli');
    const r = await run('ask_bot', { bot_name: 'Eli', question: 'Ready?' }, ctx(pm.id, { asking: 2 }));
    expect(r.output).toMatch(/answer with what you know instead of asking Eli/);
  });
});
