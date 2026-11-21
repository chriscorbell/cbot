// machine.ts and the box scripts read the same server/box/machine.json (server/box/test_dispatchlib.py
// checks the Python side reads it the same way).
import { expect, test } from 'vitest';
import fs from 'node:fs';
import {
  BOX_ROOT, BOTS_ROOT, cdpPortFor, displayFor, displayNumber, ENGINE_PORT_BASE, FIRST_BOT_DISPLAY, HERMES_ROOT, HOME_PORT,
  LIBRARY_ROOT, LOGS_ROOT, MACHINE_FILE, PROFILES_ROOT, RUN_ROOT, vncPortFor,
} from '../src/machine.js';

const machine = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8'));

test('the folders and ports come from machine.json', () => {
  expect(BOTS_ROOT).toBe(machine.botsRoot);
  expect(PROFILES_ROOT).toBe(`${machine.botsRoot}/profiles`);
  expect(LIBRARY_ROOT).toBe(`${machine.botsRoot}/files`);
  expect(BOX_ROOT).toBe(machine.boxRoot);
  expect(HERMES_ROOT).toBe(machine.hermesRoot);
  expect(LOGS_ROOT).toBe(machine.logs);
  expect(RUN_ROOT).toBe(machine.run);
  expect(HOME_PORT).toBe(machine.homePort);
  expect(ENGINE_PORT_BASE).toBe(machine.enginePortBase);
  expect(FIRST_BOT_DISPLAY).toBe(machine.firstBotDisplay);
});

test('screen ids name displays, and displays name ports', () => {
  expect(displayFor('default')).toBe(`:${machine.primaryDisplay}`);
  expect(displayFor(null)).toBe(':99');
  expect(displayNumber('screen-100')).toBe(100);
  expect(cdpPortFor('default')).toBe(9299);
  expect(cdpPortFor('screen-101')).toBe(machine.cdpPortBase + 101);
  expect(vncPortFor(101)).toBe(machine.vncPortBase + 101);
});

test('the box scripts get machine.json with them', () => {
  expect(fs.readFileSync(new URL('../src/desk.ts', import.meta.url), 'utf8')).toMatch(/'machine\.json': 'machine\.json'/);
});

test('the unit files name the same run folder the server writes their environment to', () => {
  for (const name of ['dispatch-xvnc@.service', 'dispatch-bus@.service', 'dispatch-wm@.service', 'dispatch-gateway@.service']) {
    expect(fs.readFileSync(new URL(`../../deploy/${name}`, import.meta.url), 'utf8')).toContain(`${machine.run}/`);
  }
});
