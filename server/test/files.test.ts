// What deleting a bot or resetting Dispatch removes from the bots' folders (computer.ts), and that a
// folder that couldn't be removed is an error that names it instead of passing unnoticed.
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { forgetAllBotFiles, forgetBotFiles } from '../src/computer.js';
import { libraryDir, LIBRARY_ROOT, profileDir, PROFILES_ROOT } from '../src/machine.js';

const make = (file: string) => { fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true }); fs.writeFileSync(file, 'x'); };

test("deleting a bot removes its Chrome profile and Library, and no one else's", async () => {
  make(`${profileDir('bot_a')}/Default/Preferences`);
  make(`${libraryDir('bot_a')}/uploads/notes.txt`);
  make(`${libraryDir('bot_b')}/report.pdf`);
  await forgetBotFiles('bot_a');
  expect(fs.existsSync(profileDir('bot_a'))).toBe(false);
  expect(fs.existsSync(libraryDir('bot_a'))).toBe(false);
  expect(fs.existsSync(`${libraryDir('bot_b')}/report.pdf`)).toBe(true);
  // Already gone is fine; an id that isn't a bot's names no folder at all.
  await forgetBotFiles('bot_a');
  await forgetBotFiles('../bot_b');
  expect(fs.existsSync(libraryDir('bot_b'))).toBe(true);
});

test('a folder that cannot be removed fails the cleanup, naming it, after trying the rest', async () => {
  // Root may delete anything, so only an ordinary account can see this fail.
  if (process.getuid?.() === 0) return;
  make(`${profileDir('bot_c')}/Default/Preferences`);
  make(`${libraryDir('bot_c')}/locked/file.txt`);
  fs.chmodSync(`${libraryDir('bot_c')}/locked`, 0o500);
  try {
    await expect(forgetBotFiles('bot_c')).rejects.toThrow(`could not delete ${libraryDir('bot_c')}`);
    expect(fs.existsSync(profileDir('bot_c'))).toBe(false);
  } finally {
    fs.chmodSync(`${libraryDir('bot_c')}/locked`, 0o700);
  }
});

test('a reset empties the profile and Library folders, whatever bot left them', async () => {
  make(`${profileDir('bot_gone')}/Default/Preferences`);
  make(`${libraryDir('room_x')}/a.txt`);
  await forgetAllBotFiles();
  expect(fs.readdirSync(PROFILES_ROOT)).toEqual([]);
  expect(fs.readdirSync(LIBRARY_ROOT)).toEqual([]);
});
