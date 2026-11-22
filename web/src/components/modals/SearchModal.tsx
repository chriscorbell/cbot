import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Bot } from '@shared/types';
import type { SearchFileHit, SearchMessageHit, SearchResponse } from '@shared/contract';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { currentWorkspaceId, displayName, useStore } from '../../store';
import { notifyFailure } from '../../lib/uiEvents';
import { useConfigUI } from '../../configStore';
import { Icon } from '../Icon';
import { Glyph } from '../config/glyphs';
import { formatBytes } from '../config/ui';
import { Modal } from './Modal';
import { previewFor } from '../Sidebar';
import { api } from '../../lib/api';
import { relativeShort } from '../../lib/time';

/** The server searches messages and files from two letters on (routes.ts); bot names match from the first. */
const MIN_SERVER = 2;
const DEBOUNCE_MS = 140;

type Item =
  | { kind: 'bot'; key: string; bot: Bot }
  | { kind: 'message'; key: string; bot: Bot; hit: SearchMessageHit }
  | { kind: 'file'; key: string; bot: Bot; hit: SearchFileHit };

const SECTION: Record<Item['kind'], string> = { bot: 'Bots', message: 'Messages', file: 'Files' };

/** `text` with every case-insensitive occurrence of `q` marked. */
function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

const ago = (t: number) => { const r = relativeShort(t); return r === 'now' ? 'just now' : r; };

/** ⌘K: the shown workspace's bots by name, and from two letters on, messages in their open chats and files in their Libraries. */
export function SearchModal() {
  const allBots = useStore((s) => s.bots);
  const workspaceId = useStore(currentWorkspaceId);
  // Results from other workspaces' bots are left out with them.
  const bots = useMemo(() => allBots.filter((b) => b.workspaceId === workspaceId), [allBots, workspaceId]);
  const live = useStore((s) => s.live);
  const setModal = useStore((s) => s.setModal);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; data: SearchResponse | null } | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const term = q.trim();

  // Ask the server once typing pauses; an answer for an older query is dropped.
  useEffect(() => {
    if (term.length < MIN_SERVER) { setFound(null); return; }
    let current = true;
    const t = setTimeout(() => {
      api.search(term).then((data) => { if (current) setFound({ q: term, data }); }, () => { if (current) setFound({ q: term, data: null }); });
    }, DEBOUNCE_MS);
    return () => { current = false; clearTimeout(t); };
  }, [term]);
  const settled = found?.q === term ? found : null;
  const searching = term.length >= MIN_SERVER && !settled;

  const items = useMemo<Item[]>(() => {
    const byId = new Map(bots.map((b) => [b.id, b]));
    const ordered = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
    const needle = term.toLowerCase();
    const matched = needle ? ordered.filter((b) => `${b.name} ${b.label} ${b.description}`.toLowerCase().includes(needle)) : ordered;
    const out: Item[] = matched.map((bot) => ({ kind: 'bot', key: `b:${bot.id}`, bot }));
    for (const hit of settled?.data?.messages ?? []) {
      const bot = byId.get(hit.botId);
      if (bot) out.push({ kind: 'message', key: `m:${hit.botId}:${hit.generation}:${hit.seq}`, bot, hit });
    }
    for (const hit of settled?.data?.files ?? []) {
      const bot = byId.get(hit.botId);
      if (bot) out.push({ kind: 'file', key: `f:${hit.botId}:${hit.path}`, bot, hit });
    }
    return out;
  }, [bots, term, settled]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => { if (active >= items.length) setActive(Math.max(0, items.length - 1)); }, [items.length, active]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = (it: Item) => {
    const st = useStore.getState();
    // Opening a bot hidden from the rail puts it back there.
    if (it.bot.sidebarHidden) {
      const unhide = (hidden: boolean) => useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === it.bot.id ? { ...b, sidebarHidden: hidden } : b)) }));
      unhide(false);
      api.setFlags(it.bot.id, { sidebarHidden: false }).catch(() => {
        unhide(true);
        notifyFailure(`Couldn’t put ${it.bot.name} back in the sidebar. Check the connection and try again.`);
      });
    }
    st.selectBot(it.bot.id);
    const { jumpTo } = useConfigUI.getState();
    if (it.kind === 'message') jumpTo({ kind: 'row', botId: it.bot.id, generation: it.hit.generation, seq: it.hit.seq });
    if (it.kind === 'file') { st.set({ detailsOpen: true }); jumpTo({ kind: 'file', botId: it.bot.id, path: it.hit.path }); }
    close();
  };

  const row = (it: Item, i: number) => {
    const common = {
      type: 'button' as const, role: 'option', 'aria-selected': i === active, 'data-idx': i,
      className: `search-row is-${it.kind}${i === active ? ' is-active' : ''}`,
      onMouseMove: () => setActive(i), onClick: () => open(it),
    };
    const enter = i === active && <span className="kbd search-row__enter" aria-hidden>↵</span>;
    if (it.kind === 'bot') {
      return (
        <button key={it.key} {...common}>
          <BotAvatarFor bot={it.bot} size={28} life="lite" />
          <span className="search-row__text">
            <span className="search-row__name"><Highlight text={displayName(it.bot)} q={term} /></span>
            <span className="search-row__sub">{previewFor(it.bot, !!live[it.bot.id]?.isRunning, live[it.bot.id]?.caption ?? null)}</span>
          </span>
          {enter}
        </button>
      );
    }
    if (it.kind === 'message') {
      const who = it.hit.role === 'user' ? 'You' : it.hit.from ?? it.bot.name;
      return (
        <button key={it.key} {...common}>
          <BotAvatarFor bot={it.bot} size={28} life="off" />
          <span className="search-row__text">
            <span className="search-row__name">{it.bot.name}<span className="search-row__when"> · {ago(it.hit.createdAt)}</span></span>
            <span className="search-row__snippet"><span className="search-row__who">{who}: </span><Highlight text={it.hit.text} q={term} /></span>
          </span>
          {enter}
        </button>
      );
    }
    const folder = it.hit.path.includes('/') ? it.hit.path.slice(0, it.hit.path.lastIndexOf('/')) : '';
    return (
      <button key={it.key} {...common}>
        <span className="search-row__icon"><Glyph name={it.hit.isDir ? 'folder' : 'doc'} size={16} /></span>
        <span className="search-row__text">
          <span className="search-row__name"><Highlight text={it.hit.name} q={term} /></span>
          <span className="search-row__sub">{it.bot.name} · {folder ? `Library/${folder}` : 'Library'}{it.hit.isDir ? '' : ` · ${formatBytes(it.hit.size)}`}</span>
        </span>
        {enter}
      </button>
    );
  };

  return (
    <Modal onClose={close} className="search-modal" label="Search">
      <div className="search-modal__field">
        <span className="search-modal__icon">{searching ? <span className="spinner" aria-hidden /> : <Icon name="search" size={18} />}</span>
        <input
          autoFocus
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search bots, messages and files"
          aria-label="Search bots, messages and files"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && items[active]) { e.preventDefault(); open(items[active]); }
          }}
        />
        <button type="button" className="search-modal__close" onClick={close}>Cancel</button>
      </div>
      <div className="search-modal__results" ref={listRef} role="listbox" aria-busy={searching}>
        {items.map((it, i) => (
          <Fragment key={it.key}>
            {(i === 0 || items[i - 1].kind !== it.kind) && <div className="search-modal__section">{SECTION[it.kind]}</div>}
            {row(it, i)}
          </Fragment>
        ))}
        {items.length === 0 && (
          <div className="search-modal__empty">
            {searching ? 'Searching…' : settled && !settled.data ? 'Couldn’t search messages and files. Try again.' : `Nothing matches “${term}”`}
          </div>
        )}
      </div>
      <div className="search-modal__foot" aria-hidden>
        <span><span className="kbd">↑</span><span className="kbd">↓</span> to move</span>
        <span><span className="kbd">↵</span> to open</span>
        <span><span className="kbd">esc</span> to close</span>
      </div>
    </Modal>
  );
}
