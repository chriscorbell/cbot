import { inlineType } from '@shared/types';

/** A Library file's address on the server. `inline` asks for the types the app shows in place. */
export const fileUrl = (botId: string, path: string, inline = false) =>
  `/api/bots/${botId}/files/raw?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`;

export type PreviewKind = 'image' | 'svg' | 'pdf' | 'audio' | 'video' | 'markdown' | 'text';

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
// Formats a browser can't show and that aren't text. Other unknown files are read as text, and
// shown only if they turn out to be text (TEXT_LIMIT, isBinary).
const BINARY = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'whl', 'deb', 'rpm', 'dmg', 'iso', 'img', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'wasm',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub',
  'heic', 'heif', 'tif', 'tiff', 'bmp', 'ico', 'psd', 'raw', 'cr2', 'nef', 'dng', 'avi', 'mkv', 'wmv', 'flv', 'mpg', 'mpeg', 'aiff', 'wma',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'sqlite', 'sqlite3', 'db', 'parquet', 'pkl', 'npy', 'npz', 'pt', 'onnx', 'safetensors', 'gguf',
]);

/** How the preview shows a file, from its name; null for one it can only offer to download. */
export function previewKind(name: string): PreviewKind | null {
  const type = inlineType(name);
  if (type) return type === 'application/pdf' ? 'pdf' : (type.split('/')[0] as 'image' | 'audio' | 'video');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'svg') return 'svg';
  if (MARKDOWN.has(ext)) return 'markdown';
  return BINARY.has(ext) ? null : 'text';
}

/** How much of a text file the preview reads. A longer one shows its start and says so. */
export const TEXT_LIMIT = 512 * 1024;

/** A NUL byte near the start means the file isn't text, whatever its name says. */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

