// Fixtures for tests. They write straight to the test database and never start a gateway, a display or
// a turn: code that would (createBot, enqueue, engineFor, screenFor) has to be mocked with vi.mock.
import { db, now } from '../src/db.js';
import { newId } from '../src/lib/ids.js';
import { initAuth, startSession, toUser } from '../src/lib/auth.js';
import { requireBot } from '../src/store.js';
import { defaultWorkspace } from '../src/workspaces.js';
import type { UserRecord } from '../src/db.js';

/** The owner, made once per test file without an account (auth.test.ts creates one) and past the setup wizard (setup.test.ts goes through it). */
export function seedOwner() {
  const existing = db.prepare<[], UserRecord>('SELECT * FROM users LIMIT 1').get();
  if (existing) return toUser(existing);
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,username,created_at,setup_at) VALUES (?,?,?,?)').run(id, 'tess', now(), now());
  const user = toUser(db.prepare<[string], UserRecord>('SELECT * FROM users WHERE id=?').get(id)!);
  defaultWorkspace(id);
  initAuth(user);
  return user;
}

/** A bot row with no engine or screen behind it, in the user's first workspace unless another is named. */
export function seedBot(userId: string, p: { name?: string; kind?: 'agent' | 'room'; isPrimary?: boolean; members?: string[]; workspaceId?: string } = {}) {
  const id = newId(p.kind === 'room' ? 'room' : 'bot');
  db.prepare('INSERT INTO bots(id,user_id,workspace_id,name,is_primary,kind,members,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, userId, p.workspaceId ?? defaultWorkspace(userId).id, p.name ?? 'Ada', p.isPrimary ? 1 : 0, p.kind ?? 'agent', p.members ? JSON.stringify(p.members) : null, now(), now());
  return requireBot(id);
}

let session: string | null = null;

/** Request headers that sign in as the owner: a session cookie made straight in the database. */
export const auth = () => {
  session ??= startSession(seedOwner().id);
  return { cookie: `dispatch_session=${session}` };
};

export const json = (body: unknown) => ({ method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
