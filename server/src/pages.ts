import fs from 'node:fs/promises';
import path from 'node:path';
import { db, now, type PageRecord } from './db.js';
import { newId } from './lib/ids.js';
import { ACCOUNT } from './account.js';
import { libraryDir } from './machine.js';
import { inLibrary } from './library.js';

/**
 * Pages bots show in their chats (the show_visual tool): a chart, a table, a diagram or a small tool,
 * written as one HTML page. A page is checked and kept here as it was shown. The page route serves it
 * to the chat's frame with the frame's script added (servePage) and a sandbox (PAGE_CSP), so its
 * scripts run as a page of no site: they can't reach the app, the user's session or anything the
 * browser keeps for the app. A bot writes it from whatever it read, so it is treated as a stranger's.
 */

const KB = 1024;
const MB = KB * KB;
/** The page as the bot wrote it. */
export const MAX_HTML = 512 * KB;
/** Each image copied in, and the page with them all. */
const MAX_IMAGE = 4 * MB;
const MAX_PAGE = 12 * MB;
/** The frame's height before the page reports its own: what the bot guessed, within these. */
export const MIN_HEIGHT = 40;
export const MAX_HEIGHT = 4000;
export const DEFAULT_HEIGHT = 320;

const size = (bytes: number) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.ceil(bytes / KB)} KB`);

export type PageSource = { html: string } | { path: string };

/**
 * The page ready to keep, or what is wrong with it in words the bot can act on. A path is a file in
 * the bot's Library, absolute or relative to it. Images the page names on the computer are copied in.
 */
export async function preparePage(botId: string, src: PageSource): Promise<{ html: string } | { error: string }> {
  const lib = libraryDir(botId);
  let html: string;
  // Relative image paths are read from beside the page's file, or from the Library for inline HTML.
  let base = lib;
  if ('path' in src) {
    const file = await pageFile(lib, src.path);
    if ('error' in file) return file;
    ({ html } = file);
    base = path.dirname(file.real);
  } else {
    html = src.html;
  }
  if (!html.trim()) return { error: 'The page is empty.' };
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_HTML) return { error: `The page is ${size(bytes)}; it can be at most ${size(MAX_HTML)}. Shrink its data or move pictures into image files.` };
  const vh = viewportHeight(html);
  if (vh) return { error: `The page uses a viewport height unit (${vh}). The frame grows to fit the page, so a height that follows the frame would grow it again and again. Let the content set the height, or use fixed pixel heights.` };
  return copyImagesIn(html, lib, base);
}

async function pageFile(lib: string, given: string): Promise<{ html: string; real: string } | { error: string }> {
  // A bot often names its home ~, which is the bots' account's.
  const wanted = path.resolve(lib, given.trim().replace(/^~(?=\/|$)/, ACCOUNT.home));
  const real = await inLibrary(lib, path.relative(lib, wanted));
  const missing = { error: `${given} is not an .html file in your Library (${lib}/).` };
  if (!real || !/\.html?$/i.test(real)) return missing;
  const st = await fs.stat(real).catch(() => null);
  if (!st?.isFile()) return missing;
  if (st.size > MAX_HTML) return { error: `${given} is ${size(st.size)}; a page can be at most ${size(MAX_HTML)}.` };
  return { html: await fs.readFile(real, 'utf8'), real };
}

// Only stylesheets and style attributes, even inside scripts; comments are skipped whole. An unclosed
// comment, tag or quote runs to the end, which keeps both patterns linear.
const CSS_SOURCE = /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/** The first viewport height unit in the page's CSS, if any. */
export function viewportHeight(html: string): string | undefined {
  for (const [, sheet, double, single, bare] of html.matchAll(CSS_SOURCE)) {
    const found = VIEWPORT_HEIGHT.exec(sheet ?? double ?? single ?? bare ?? '')?.[0];
    if (found) return found;
  }
  return undefined;
}

const EXT = 'png|jpe?g|gif|webp|avif|svg';
const NOT_URL = String.raw`(?![a-z][a-z0-9+.-]*:|//|#)`;
/**
 * Images a page names on the computer: an absolute path in quotes anywhere (an attribute, a style, a
 * script), or any path in a src attribute or a CSS url(). Web addresses and data: URLs are left alone.
 */
const LOCAL_IMAGE = new RegExp(
  String.raw`(["'\x60])(/(?!/)[^"'\x60\r\n<>]{0,1024}?\.(?:${EXT}))\1` +
    String.raw`|\ssrc\s*=\s*(["'])(${NOT_URL}[^"'\r\n<>]{1,1024}?\.(?:${EXT}))\3` +
    String.raw`|url\(\s*(["']?)(${NOT_URL}[^"'()\r\n<>]{1,1024}?\.(?:${EXT}))\5\s*\)`,
  'gid',
);

/** The image type the bytes are, judged by the bytes: a file renamed .png is not a picture. */
export function imageType(bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (/^ftyp(?:avif|avis)$/.test(head.slice(4, 12))) return 'image/avif';
  const text = bytes.subarray(0, 4096).toString('utf8');
  if (/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!doctype[^>]*>\s*)*<svg[\s/>]/i.test(text)) return 'image/svg+xml';
  return undefined;
}

async function copyImagesIn(html: string, lib: string, base: string): Promise<{ html: string } | { error: string }> {
  const refs = [...html.matchAll(LOCAL_IMAGE)].map((m) => {
    const g = [2, 4, 6].find((i) => m[i] !== undefined)!;
    const [start, end] = m.indices![g]!;
    return { start, end, path: m[g] };
  });
  if (!refs.length) return { html };
  const uris = new Map<string, string>();
  const missing: string[] = [];
  let total = Buffer.byteLength(html);
  for (const p of new Set(refs.map((r) => r.path))) {
    const real = await inLibrary(lib, path.relative(lib, path.resolve(base, p)));
    const st = real ? await fs.stat(real).catch(() => null) : null;
    if (!real || !st?.isFile()) { missing.push(p); continue; }
    if (st.size > MAX_IMAGE) return { error: `${p} is ${size(st.size)}; an image can be at most ${size(MAX_IMAGE)}.` };
    const bytes = await fs.readFile(real);
    const type = imageType(bytes);
    if (!type) { missing.push(p); continue; }
    const uri = `data:${type};base64,${bytes.toString('base64')}`;
    total += uri.length - p.length;
    if (total > MAX_PAGE) return { error: `With its images the page is over ${size(MAX_PAGE)}. Use smaller images.` };
    uris.set(p, uri);
  }
  if (missing.length) return { error: `These images aren't image files in your Library: ${missing.join(', ')}. Save them there, or give web addresses.` };
  let out = '';
  let at = 0;
  for (const r of refs) {
    out += html.slice(at, r.start) + uris.get(r.path)!;
    at = r.end;
  }
  return { html: out + html.slice(at) };
}

export function savePage(botId: string, title: string, html: string): string {
  const id = newId('pg');
  db.prepare('INSERT INTO pages(id,bot_id,title,html,created_at) VALUES (?,?,?,?,?)').run(id, botId, title, html, now());
  return id;
}

export const deletePage = (id: string) => db.prepare('DELETE FROM pages WHERE id=?').run(id);

export const getPage = (botId: string, id: string) => db.prepare<[string, string], PageRecord>('SELECT * FROM pages WHERE id=? AND bot_id=?').get(id, botId);

/**
 * The page's own rules, which the app's (app.ts) would otherwise replace. The sandbox gives it an
 * origin of its own, so it reads nothing of the app's and the session cookie stays off its requests;
 * it may run scripts and open links in a new tab, unsandboxed. Anything else may load from anywhere:
 * chart libraries from a CDN, fonts, pictures. It can't submit forms or be framed by another site.
 */
export const PAGE_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

// The theme until the chat sends the app's (the frame always does, before the page paints): only for
// the page opened on its own, so system colors and plain picks do.
const FALLBACK_CSS =
  ':root{color-scheme:light dark;--background:Canvas;--foreground:CanvasText;--muted-foreground:GrayText;' +
  '--surface:color-mix(in srgb,CanvasText 6%,Canvas);--border:color-mix(in srgb,CanvasText 12%,Canvas);' +
  '--primary:CanvasText;--primary-foreground:Canvas;--ring:#3A78F2;--destructive:#D93A43;--success:#2FB36A;--warning:#E8962E;' +
  '--chart-1:#3A78F2;--chart-2:#2FB36A;--chart-3:#E8962E;--chart-4:#A361E8;--chart-5:#E0474F;--chart-6:#1FB5B5;' +
  '--radius:10px;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace}';

// What every page starts from: the chat's background, text and font. A page's own CSS comes after it.
const BASE_CSS =
  'html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;' +
  '-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}' +
  // Inside the element, so the frame's edge never cuts a focus ring off.
  ':focus-visible{outline:2px solid var(--ring);outline-offset:-2px}';

/**
 * The frame's script, first in the page's head. It applies the theme the chat sends (types.ts
 * PageMessage): in the address's fragment before the page paints, then in a message on every change.
 * A change fires 'themechange' on the window, for scripts that drew with the old colors (show_visual
 * tells the bots). It reports the page's height so the frame fits it with no scrollbar of its own,
 * and opens links in a new tab. It trusts nothing it is sent: variable names and values are checked,
 * and fonts must come from the app's own address.
 */
const BOOTSTRAP = String.raw`(() => {
  const style = document.getElementById('dispatch-page');
  if (!style) return;
  const apply = (t) => {
    if (!t || typeof t !== 'object' || !t.vars || typeof t.vars !== 'object') return;
    let css = ':root{color-scheme:' + (t.scheme === 'light' ? 'light' : 'dark') + ';';
    for (const k of Object.keys(t.vars)) if (/^--[a-z0-9-]+$/.test(k)) css += k + ':' + String(t.vars[k]).replace(/[;{}<>\\]/g, '') + ';';
    css += '}';
    for (const f of Array.isArray(t.fonts) ? t.fonts : []) {
      if (f && typeof f.family === 'string' && /^[\w -]+$/.test(f.family) && typeof f.url === 'string' && f.url.startsWith(location.origin + '/') && !/["\\]/.test(f.url))
        css += '@font-face{font-family:"' + f.family + '";src:url("' + f.url + '") format("woff2");font-weight:100 900;font-display:swap}';
    }
    style.textContent = css + ${JSON.stringify(BASE_CSS)};
  };
  try {
    const m = /[#&]theme=([^&]*)/.exec(location.hash);
    if (m) {
      apply(JSON.parse(decodeURIComponent(m[1])));
      history.replaceState(history.state, '', location.pathname + location.search);
    }
  } catch {}
  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== parent || !d || d.type !== 'dispatch:theme') return;
    apply(d.theme);
    // For a script that drew with the old colors, such as a canvas chart.
    dispatchEvent(new Event('themechange'));
  });
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a) return;
    let u;
    try { u = new URL(a.getAttribute('href'), document.baseURI); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || u.href.split('#')[0] === location.href.split('#')[0]) return;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }, true);
  if (parent === window) return;
  const root = document.documentElement;
  let last = -1;
  const report = () => {
    const h = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
    if (h === last) return;
    last = h;
    parent.postMessage({ type: 'dispatch:height', height: h }, '*');
  };
  const ro = new ResizeObserver(report);
  ro.observe(root);
  document.addEventListener('DOMContentLoaded', () => { if (document.body) ro.observe(document.body); report(); });
  addEventListener('load', report);
})();`;

const HEAD = `<style id="dispatch-page">${FALLBACK_CSS}${BASE_CSS}</style><script>${BOOTSTRAP}</script>`;

/** Blank out what isn't markup (comments, scripts, styles), keeping offsets, so no tag is found in it. */
function markupOnly(html: string): string {
  const blank = (s: string) => ' '.repeat(s.length);
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi, blank);
}

/**
 * The page as the frame gets it: the theme and the frame's script first in its head, and a doctype if
 * it had none, since a page without one is laid out in the browser's old quirks mode.
 */
export function servePage(html: string): string {
  return /^\s*<!doctype/i.test(html) ? withHead(html) : `<!doctype html>${withHead(html)}`;
}

function withHead(html: string): string {
  const scan = markupOnly(html);
  const head = /<head(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/i.exec(scan);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + HEAD + html.slice(at);
  }
  const root = /<html(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/i.exec(scan);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${HEAD}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}<head>${HEAD}</head>${html.slice(doctype[0].length)}`;
  return `<head>${HEAD}</head>${html}`;
}
