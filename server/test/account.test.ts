// The account the bots run as (src/account.ts). server/box/test_dispatchlib.py checks the box scripts
// find it by the same rule, from the same passwd lines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ACCOUNT, asAccount, fromPasswd, handsOver, lookupAccount, mkdirOwned } from '../src/account.js';

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'ada:x:1000:1000:Ada,,,:/home/ada:/bin/bash',
  '',
].join('\n');

function passwdFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-passwd-')), 'passwd');
  fs.writeFileSync(file, PASSWD);
  return file;
}

test('the account is DISPATCH_USER, with its home from passwd, and root only when it says so', () => {
  const file = passwdFile();
  expect(lookupAccount({ DISPATCH_USER: 'ada' }, file)).toEqual({ name: 'ada', uid: 1000, gid: 1000, home: '/home/ada' });
  expect(lookupAccount({ DISPATCH_USER: 'root' }, file)).toEqual({ name: 'root', uid: 0, gid: 0, home: '/root' });
  // Never root for want of a name: root's bots run Chrome without its sandbox.
  expect(() => lookupAccount({}, file)).toThrow(/DISPATCH_USER isn’t set/);
  expect(() => lookupAccount({ DISPATCH_USER: '  ' }, file)).toThrow(/DISPATCH_USER isn’t set/);
});

test('DISPATCH_HOME stands in for the home, and an account the machine lacks stops the server', () => {
  const file = passwdFile();
  expect(lookupAccount({ DISPATCH_USER: 'ada', DISPATCH_HOME: '/tmp/x/../home' }, file).home).toBe('/tmp/home');
  expect(() => lookupAccount({ DISPATCH_USER: 'nobody-here' }, file)).toThrow(/no account by that name/);
  expect(fromPasswd('broken:x:nope:1::/h:/bin/sh', 'broken')).toBeNull();
});

test("a server that isn't root hands nothing over and runs commands as itself", () => {
  // The tests don't run as root, so nothing is chowned and no setpriv wraps a command.
  expect(handsOver()).toBe(false);
  expect(asAccount(['hermes', 'auth', 'add', 'x'])).toEqual(['hermes', 'auth', 'add', 'x']);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-own-')), 'a', 'b');
  mkdirOwned(dir);
  expect(fs.statSync(dir).isDirectory()).toBe(true);
  // test/env.ts points the bots' home at a temporary folder.
  expect(ACCOUNT.home).toBe(process.env.DISPATCH_HOME);
});
