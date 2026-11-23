import { useEffect, useRef, useState, type RefObject } from 'react';
import { Maximize2 } from 'lucide-react';
import geistSans from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';
import { PAGE_VARS, type PageCard as PageCardBody, type PageMessage, type PageTheme, type Row } from '@shared/types';
import { Modal } from '../modals/Modal';
import { Icon } from '../Icon';

/**
 * A page a bot wrote and showed in the chat (show_visual): a chart, a table, a diagram. It runs in a
 * sandboxed frame with an origin of its own (server/src/pages.ts), so it can't reach the app. The two
 * talk by messages (PageMessage): the page says how tall it is and the frame fits it; the frame hands
 * the page the app's theme, and again whenever it changes.
 */

const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
/** The most a frame grows to fit its page; a taller page scrolls inside it. */
const MAX_FIT = 6000;
/** The height each page last reported, so a frame shown again (after another chat) opens at it. */
const reported = new Map<string, number>();

/** The app's theme as a page gets it: the tokens' values right now, and the app's fonts. */
function pageTheme(): PageTheme {
  const css = getComputedStyle(document.documentElement);
  return {
    scheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    vars: Object.fromEntries(Object.entries(PAGE_VARS).map(([name, token]) => [name, css.getPropertyValue(token).trim()])),
    fonts: [
      { family: 'Geist Variable', url: new URL(geistSans, location.href).href },
      { family: 'Geist Mono Variable', url: new URL(geistMono, location.href).href },
    ],
  };
}

/** The page's address, with the theme in its fragment so the page has it before it first paints. */
const pageSrc = (botId: string, pageId: string) =>
  `/api/bots/${encodeURIComponent(botId)}/pages/${encodeURIComponent(pageId)}#theme=${encodeURIComponent(JSON.stringify(pageTheme()))}`;

/** The height a page reports, or undefined for any other message. A page is a stranger: nothing else is read. */
function reportedHeight(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, height } = data as { type?: unknown; height?: unknown };
  return type === 'dispatch:height' && typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** Hands the frame's page the app's theme whenever it changes (Settings, or the system's while on System). */
function useTheme(frame: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage({ type: 'dispatch:theme', theme: pageTheme() } satisfies PageMessage, '*');
    const mo = new MutationObserver(send);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [frame]);
}

export function PageCard({ row, body }: { row: Row; body: PageCardBody }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => pageSrc(row.botId, body.pageId));
  const [height, setHeight] = useState(() => reported.get(body.pageId) ?? body.height);
  const [loaded, setLoaded] = useState(false);
  const [full, setFull] = useState(false);
  useTheme(frame);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const h = reportedHeight(e.data);
      if (h === undefined) return;
      const fit = Math.min(MAX_FIT, Math.ceil(h));
      reported.set(body.pageId, fit);
      setHeight(fit);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [body.pageId]);

  return (
    <div className={`page-card${loaded ? ' is-loaded' : ''}`} data-seq={row.seq}>
      <iframe ref={frame} className="page-card__frame" src={src} title={body.title} sandbox={SANDBOX} style={{ height }} onLoad={() => setLoaded(true)} />
      <button type="button" className="page-card__expand" onClick={() => setFull(true)} aria-label={`Open ${body.title} full screen`} title="Full screen">
        <Maximize2 size={14} strokeWidth={2} />
      </button>
      {full && <PageModal botId={row.botId} body={body} onClose={() => setFull(false)} />}
    </div>
  );
}

/** The page full screen: the same page in a frame as big as the window, scrolling inside it. */
function PageModal({ botId, body, onClose }: { botId: string; body: PageCardBody; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => pageSrc(botId, body.pageId));
  const [loaded, setLoaded] = useState(false);
  useTheme(frame);
  return (
    <Modal onClose={onClose} className="page-modal" label={body.title}>
      <div className="modal__header">
        <span className="modal__title page-modal__title" title={body.title}>{body.title}</span>
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="close" size={14} /></button>
      </div>
      <iframe ref={frame} className={`page-modal__frame${loaded ? ' is-loaded' : ''}`} src={src} title={body.title} sandbox={SANDBOX} onLoad={() => setLoaded(true)} />
    </Modal>
  );
}
