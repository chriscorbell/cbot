import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { mkdirOwnedAsync, ownAsync } from './account.js';
import { libraryDir } from './machine.js';

/**
 * Files the person attaches in a chat. They land in the Library's uploads/ folder, which is inside
 * the bot's working folder, so the bot finds them where it works. A group chat has a folder of its
 * own under the same root, which its chat shows the files from; members get copies (agent/rooms.ts).
 */

export const uploadsDir = (botId: string) => `${libraryDir(botId)}/uploads`;

/** A file name safe on disk, kept readable. */
export const safeName = (raw: string) => (raw || 'file').replace(/[/\\\0\n\r]/g, '_').replace(/^\.+/, '').slice(0, 140) || 'file';

/** The name to try when `name` is taken, counting from 2: "report (2).pdf". */
export function numbered(name: string, n: number) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return `${stem} (${n})${ext}`;
}

/**
 * Copy a file into a bot's uploads/, numbered if that name is taken there, and return where it went.
 * The copy fails rather than overwrite, so two copies of the same name at once both land.
 */
export async function copyToUploads(src: string, botId: string): Promise<string> {
  const dir = uploadsDir(botId);
  await mkdirOwnedAsync(dir);
  const name = safeName(path.basename(src));
  for (let n = 1; ; n++) {
    const dest = `${dir}/${n === 1 ? name : numbered(name, n)}`;
    try {
      // A clone where the disk supports it, so a large file costs no space until someone changes it.
      await fs.copyFile(src, dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      // The bots' account owns everything in their Libraries, so any bot can change the copy.
      await ownAsync(dest);
      return dest;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/**
 * `rel` inside the Library at `root`, with links followed first, so a link inside the Library can't
 * reach outside it. Null when it isn't there or is outside.
 */
export async function inLibrary(root: string, rel: string): Promise<string | null> {
  try {
    const [real, top] = await Promise.all([fs.realpath(rel ? `${root}/${rel}` : root), fs.realpath(root)]);
    return real === top || real.startsWith(`${top}/`) ? real : null;
  } catch {
    return null;
  }
}

/** What a bot is told about attached files: where they are on its computer. */
export function filesNote(files: { file: string; type: string; size: number }[]) {
  if (!files.length) return '';
  const head = files.length === 1 ? 'A file is' : `${files.length} files are`;
  return `\n\n[${head} attached, saved on your computer:\n${files.map((f) => `- ${f.file} (${f.type || 'file'}, ${f.size} bytes)`).join('\n')}]`;
}
