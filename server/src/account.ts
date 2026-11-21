import fs from 'node:fs';
import path from 'node:path';

/**
 * The account the bots run as. Every bot shares one ordinary account on the machine: the one that ran
 * the installer, which writes its name to /etc/dispatch/env as DISPATCH_USER. Each bot's gateway,
 * screen, Chrome and apps run as it, so a file one bot makes is a file every other bot can open and
 * change, and none of them has a root shell (the account can sudo; scripts/install-units.sh says so).
 * The server itself stays root and keeps its own data (DATA_DIR: the database, the secret) where the
 * account can't read it without sudo.
 *
 * The rule, which server/box/dispatchlib.py follows too:
 *   the account is DISPATCH_USER, or root when it is unset (unit tests, a machine set up by hand);
 *   its home is the one /etc/passwd gives it, or DISPATCH_HOME when that is set (the tests point it
 *   at a temporary folder); the bots' files are under <home>/<botsDir> (server/box/machine.json).
 */
export interface Account { name: string; uid: number; gid: number; home: string }

/** The account named `name` in a passwd file's text, or null. */
export function fromPasswd(text: string, name: string): Account | null {
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length < 7 || f[0] !== name) continue;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || !f[5]) return null;
    return { name, uid, gid, home: f[5] };
  }
  return null;
}

/** The bots' account by the rule above. Throws a sentence when DISPATCH_USER names nobody on this machine. */
export function lookupAccount(vars: NodeJS.ProcessEnv = process.env, passwdFile = '/etc/passwd'): Account {
  const name = vars.DISPATCH_USER?.trim() || 'root';
  const found = fromPasswd(fs.readFileSync(passwdFile, 'utf8'), name);
  if (!found) throw new Error(`DISPATCH_USER is ${name}, and this machine has no account by that name (/etc/dispatch/env sets it)`);
  const home = vars.DISPATCH_HOME?.trim();
  return home ? { ...found, home: path.resolve(home) } : found;
}

export const ACCOUNT = lookupAccount();

/**
 * Whether what this process makes for the bots has to be handed to their account: only when the
 * server runs as root (as it does on a machine) and the account isn't root. In tests and on a machine
 * where the bots are root, files stay as they are made.
 */
export const handsOver = (): boolean => process.getuid?.() === 0 && ACCOUNT.uid !== 0;

/** Give a file, folder or link the server made in the account's folders to the account. */
export function own(file: string): void {
  if (handsOver()) fs.lchownSync(file, ACCOUNT.uid, ACCOUNT.gid);
}

/** The same, for code that already awaits. */
export async function ownAsync(file: string): Promise<void> {
  if (handsOver()) await fs.promises.lchown(file, ACCOUNT.uid, ACCOUNT.gid);
}

/** The folders between `first` (the first one mkdir made) and `dir`, from the outside in. */
function made(first: string | undefined, dir: string): string[] {
  if (!first) return [];
  const out: string[] = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.unshift(d);
    if (d === path.resolve(first) || d === path.dirname(d)) break;
  }
  return out;
}

/** mkdir -p, with every folder it makes given to the account. */
export function mkdirOwned(dir: string, mode?: number): void {
  for (const d of made(fs.mkdirSync(dir, { recursive: true, mode }), dir)) own(d);
}

export async function mkdirOwnedAsync(dir: string): Promise<void> {
  for (const d of made(await fs.promises.mkdir(dir, { recursive: true }), dir)) await ownAsync(d);
}

/**
 * A command line that runs as the account: what the root server starts in a bot's home (a Hermes
 * sign-in, say) must leave files the bot's own gateway can read. setpriv keeps the environment the
 * caller gives it, so HOME and USER come from there (hermesEnv).
 */
export function asAccount(argv: string[]): string[] {
  if (!handsOver()) return argv;
  return ['setpriv', `--reuid=${ACCOUNT.uid}`, `--regid=${ACCOUNT.gid}`, '--init-groups', '--', ...argv];
}
