import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, BellDot, ClipboardCopy, Copy, Eye, EyeOff, LogOut, MessagesSquare, PanelLeft, Plus, Repeat2, Search, Settings, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { configApi } from '../lib/configApi';
import { ConfirmDialog } from './modals/ConfirmDialog';
import { ChoosePrimaryDialog } from './modals/ChoosePrimaryDialog';
import { useConfigUI } from '../configStore';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { displayName, useStore } from '../store';
import { trapTabWithin } from '../lib/focus';
import { Menu, type MenuItem } from './Menu';
import { Presence, useExiting } from './Presence';
import { useToast } from './Toast';
import { copyConversation } from '../lib/share';
import { useLongPress } from '../lib/longPress';

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl ';

/** True below the width where the rail turns into a drawer (matches shell.css). */
export function useNarrow(query = '(max-width: 560px)') {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(query).matches,
  );
}

export function previewFor(bot: Bot, running: boolean, caption: string | null) {
  if (running) return caption?.trim() || 'Working…';
  return bot.lastPreview ?? bot.label ?? 'No messages yet';
}

function statusOf(running: boolean, unread: number) {
  if (running) return { cls: 'is-working', label: 'Working' };
  if (unread > 0) return { cls: 'is-unread', label: 'Unread' };
  return null;
}

// ---------------------------------------------------------------------------
// Hover cards: the rail has no labels, so pointing at an icon says what it is.

type Tip = { el: HTMLElement; head: ReactNode; body?: string | null };
const tipListeners = new Set<(t: Tip | null) => void>();
let tipTimer: ReturnType<typeof setTimeout> | undefined;
function showTip(t: Tip | null, delay = 0) {
  clearTimeout(tipTimer);
  if (!t || !delay) { tipListeners.forEach((f) => f(t)); return; }
  tipTimer = setTimeout(() => tipListeners.forEach((f) => f(t)), delay);
}

function RailTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => { tipListeners.add(setTip); return () => { tipListeners.delete(setTip); }; }, []);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('pointerdown', hide, true);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('pointerdown', hide, true); };
  }, [tip]);
  if (!tip || !tip.el.isConnected) return null;
  const r = tip.el.getBoundingClientRect();
  const card = tip.body !== undefined;
  return createPortal(
    <div className={`tip${card ? '' : ' tip--label'}`} style={card ? { left: r.right + 8, top: Math.max(8, r.top - 2) } : { left: r.right + 8, top: r.top + r.height / 2, translate: '0 -50%' }} role="tooltip">
      <div className="tip__head">{tip.head}</div>
      {card && tip.body && <div className="tip__body">{tip.body}</div>}
    </div>,
    document.body,
  );
}

/** Props that show a hover card next to a rail control (and hide it again). */
function tipProps(head: ReactNode, body?: string | null) {
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => { if (e.pointerType === 'mouse') showTip({ el: e.currentTarget, head, body }, 260); },
    onPointerLeave: () => showTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) showTip({ el: e.currentTarget, head, body }); },
    onBlur: () => showTip(null),
  };
}

// ---------------------------------------------------------------------------

const RailBot = memo(function RailBot({ bot, selected, running, caption, born, tips, onSelect, onMenu }: { bot: Bot; selected: boolean; running: boolean; caption: string | null; born: boolean; tips: boolean; onSelect: (id: string) => void; onMenu: (bot: Bot, x: number, y: number) => void }) {
  const status = statusOf(running, bot.unread);
  const preview = previewFor(bot, running, caption);
  // On a touch screen, holding a bot opens the menu a right-click opens with a mouse.
  const hold = useLongPress((x, y) => { showTip(null); onMenu(bot, x, y); });
  return (
    <button
      {...hold}
      type="button"
      className={`rail-bot${selected ? ' is-selected' : ''}${status ? ` has-${status.cls.slice(3)}` : ''}`}
      style={botVars(bot.avatarColor)}
      onClick={() => { showTip(null); onSelect(bot.id); }}
      onContextMenu={(e) => { e.preventDefault(); showTip(null); onMenu(bot, e.clientX, e.clientY); }}
      onKeyDown={(e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); onMenu(bot, r.right - 6, r.bottom - 6); } }}
      aria-current={selected ? 'page' : undefined}
      aria-label={displayName(bot)}
      {...(tips ? tipProps(<><BotAvatarFor bot={bot} size={14} />{displayName(bot)}</>, preview) : {})}
    >
      <span className="rail-bot__tile">
        <BotAvatarFor bot={bot} size={28} star={bot.isPrimary} mood={running ? 'working' : 'idle'} born={born} />
        {status && status.cls !== 'is-working' && <span className={`status-dot ${status.cls}`} />}
      </span>
      <span className="rail-bot__text">
        <span className="rail-bot__name">{bot.name}</span>
        <span className="rail-bot__preview">{preview}</span>
      </span>
      {bot.isPrimary && <span className="sr-only">Primary bot</span>}
      {status && <span className="sr-only">{status.label}</span>}
    </button>
  );
});

/** Bots that appear after the first load hatch in with a pop. */
function useBornIds(bots: Bot[]) {
  const known = useRef<Set<string> | null>(null);
  const [born, setBorn] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!bots.length) return;
    if (!known.current) { known.current = new Set(bots.map((b) => b.id)); return; }
    const fresh = bots.filter((b) => !known.current!.has(b.id)).map((b) => b.id);
    if (!fresh.length) return;
    fresh.forEach((id) => known.current!.add(id));
    setBorn((s) => new Set([...s, ...fresh]));
    const t = setTimeout(() => setBorn((s) => { const n = new Set(s); fresh.forEach((id) => n.delete(id)); return n; }), 900);
    return () => clearTimeout(t);
  }, [bots]);
  return born;
}

/**
 * "Update available" above the account (server/src/updates.ts): an icon in the rail, a pill in the
 * full sidebar. It opens Settings > General, where the Update button is, and spins while updating.
 */
function UpdatePill({ tips }: { tips: boolean }) {
  const update = useStore((s) => s.update);
  const set = useStore((s) => s.set);
  const exiting = useExiting();
  const updating = update?.status === 'updating';
  const label = updating ? 'Updating cbot' : 'Update available';
  return (
    <button
      type="button"
      className={`rail-update${updating ? ' is-updating' : ''}${exiting ? ' is-exiting' : ''}`}
      onClick={() => { showTip(null); set({ drawerOpen: false }); useConfigUI.getState().openAppSettings('general'); }}
      aria-label={label}
      {...(tips ? tipProps(label, updating ? update.step : null) : {})}
    >
      <span className="rail-btn__icon">{updating ? <span className="spinner" aria-hidden /> : <ArrowDownToLine size={16} strokeWidth={1.9} aria-hidden />}</span>
      <span className="rail-update__text">{updating ? 'Updating…' : label}</span>
    </button>
  );
}

function AccountButton({ name, avatarUrl, tips }: { name: string; avatarUrl?: string | null; tips: boolean }) {
  const [open, setOpen] = useState(false);
  const set = useStore((s) => s.set);
  const go = (fn: () => void) => () => { set({ drawerOpen: false }); fn(); };
  // Keyboard shortcuts mean nothing on a phone.
  const touch = useNarrow('(hover: none)');
  const key = (k: string) => (touch ? undefined : `${MOD}${k}`);
  return (
    <div className="rail-account">
      <button
        type="button"
        className="rail-account__btn"
        onClick={() => { showTip(null); setOpen(!open); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account and settings for ${name}`}
        {...(open || !tips ? {} : tipProps(name))}
      >
        {avatarUrl ? <img className="rail-account__photo" src={avatarUrl} alt="" /> : <span className="rail-account__initials">{initials(name)}</span>}
        <span className="rail-bot__text"><span className="rail-bot__name">{name}</span></span>
      </button>
      <Presence show={open} ms={110}>
        <Menu
          placement="above"
          onClose={() => setOpen(false)}
          items={[
            { label: 'Search', hint: key('K'), icon: <Search size={14} strokeWidth={1.75} />, onSelect: go(() => useStore.getState().setModal('search')) },
            { label: 'New group chat', icon: <MessagesSquare size={14} strokeWidth={1.75} />, onSelect: go(() => useStore.getState().setModal('group')) },
            { label: 'Settings', hint: key(','), icon: <Settings size={14} strokeWidth={1.75} />, onSelect: go(() => useConfigUI.getState().openAppSettings()), separatorBefore: true },
            { label: 'Sign out', icon: <LogOut size={14} strokeWidth={1.75} />, onSelect: go(() => { void useStore.getState().signOut(); }) },
          ]}
        >
          <div className="menu__header">{name}</div>
        </Menu>
      </Presence>
    </div>
  );
}

/** Right-click menu for a bot in the rail, at the pointer. */
function BotMenu({ at, onClose, onDialog, onCopied }: { at: { bot: Bot; x: number; y: number }; onClose: () => void; onDialog: (kind: 'delete' | 'primary', bot: Bot) => void; onCopied: (ok: boolean) => void }) {
  const { bot } = at;
  const ic = { size: 14, strokeWidth: 1.75 } as const;
  const isRoom = bot.kind === 'room';
  const flag = (p: { sidebarHidden?: boolean }) => {
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...p } : b)) }));
    api.setFlags(bot.id, p).catch(() => useStore.getState().loadBots());
  };
  const items: MenuItem[] = [
    { label: 'Mark as Unread', icon: <BellDot {...ic} />, onSelect: () => useStore.getState().markUnread(bot.id) },
    { label: 'Copy Conversation', icon: <ClipboardCopy {...ic} />, separatorBefore: true, onSelect: () => { copyConversation(bot).then(() => onCopied(true), () => onCopied(false)); } },
    { label: 'Copy conversation ID', icon: <Copy {...ic} />, onSelect: () => { navigator.clipboard.writeText(bot.id).catch(() => {}); } },
    bot.sidebarHidden
      ? { label: 'Show in sidebar', icon: <Eye {...ic} />, separatorBefore: true, onSelect: () => flag({ sidebarHidden: false }) }
      : { label: 'Hide from sidebar', icon: <EyeOff {...ic} />, separatorBefore: true, onSelect: () => flag({ sidebarHidden: true }) },
    ...(bot.isPrimary
      ? [{ label: 'Replace with different Bot', icon: <Repeat2 {...ic} />, onSelect: () => onDialog('primary', bot) }]
      : [{ label: 'Delete', icon: <Trash2 {...ic} />, danger: true, onSelect: () => onDialog('delete', bot) }]),
  ];
  // Keep the menu on screen.
  const left = Math.min(at.x, window.innerWidth - 230);
  const top = Math.min(at.y, window.innerHeight - 220);
  return createPortal(
    <div className="ctx-anchor" style={{ left, top }}>
      <Menu items={isRoom ? items.filter((i) => i.label !== 'Copy conversation ID') : items} onClose={onClose} />
    </div>,
    document.body,
  );
}

export function Sidebar() {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const user = useStore((s) => s.user);
  const expandedPref = useStore((s) => s.sidebarExpanded);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const update = useStore((s) => s.update);
  const set = useStore((s) => s.set);
  const selectBot = useStore((s) => s.selectBot);
  const born = useBornIds(bots);

  // The primary bot first, then the rest by latest activity. Bots hidden from the sidebar are listed
  // under Hidden Bots in the full sidebar only; the icon rail leaves them out.
  const byActivity = (a: Bot, b: Bot) => b.lastActivityAt - a.lastActivityAt;
  const shown = bots.filter((b) => !b.sidebarHidden);
  const primary = shown.find((b) => b.isPrimary);
  const ordered = [...(primary ? [primary] : []), ...shown.filter((b) => !b.isPrimary).sort(byActivity)];
  const hiddenBots = bots.filter((b) => b.sidebarHidden).sort(byActivity);
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'delete' | 'primary'; bot: Bot } | null>(null);
  const onMenu = useCallback((bot: Bot, x: number, y: number) => setMenu({ bot, x, y }), []);
  const [toast, flash] = useToast();
  const name = user?.username ?? '';
  const narrow = useNarrow();
  // The phone drawer is always the full sidebar.
  const expanded = narrow || expandedPref;
  const asideRef = useRef<HTMLElement>(null);
  // As a drawer, the rail is out of the tab order while closed, and holds focus while open.
  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    const el = asideRef.current;
    const main = document.querySelector<HTMLElement>('.app > main');
    main?.setAttribute('inert', '');
    el?.querySelector<HTMLElement>('[aria-current="page"], .rail-bot')?.focus({ preventScroll: true });
    const untrap = trapTabWithin(el);
    return () => {
      untrap();
      main?.removeAttribute('inert');
      if (!document.querySelector('.modal-root')) document.querySelector<HTMLElement>('.drawer-btn')?.focus({ preventScroll: true });
    };
  }, [narrow, drawerOpen]);
  useEffect(() => { asideRef.current?.toggleAttribute('inert', narrow && !drawerOpen); }, [narrow, drawerOpen]);
  const closeSidebar = () => set(narrow ? { drawerOpen: false } : { sidebarExpanded: false });
  const openModal = (m: 'search' | 'create') => { set({ drawerOpen: false }); useStore.getState().setModal(m); };
  const railBot = (b: Bot) => (
    <RailBot
      key={b.id}
      bot={b}
      selected={selectedBotId === b.id}
      running={!!live[b.id]?.isRunning}
      caption={live[b.id]?.caption ?? null}
      born={born.has(b.id)}
      tips={!expanded}
      onSelect={selectBot}
      onMenu={onMenu}
    />
  );

  return (
    <aside
      ref={asideRef}
      className={`sidebar${expanded ? ' is-expanded' : ''}${drawerOpen ? ' is-drawer-open' : ''}`}
      aria-label="Bots"
      {...(narrow && drawerOpen ? { role: 'dialog', 'aria-modal': true } : {})}
    >
      {/* The full sidebar's top row; the icon rail keeps it folded away (and out of reach) at zero height. */}
      <div className="rail__top" aria-hidden={!expanded}>
        <button type="button" className="rail__toggle" onClick={closeSidebar} aria-label={narrow ? 'Close sidebar' : 'Collapse sidebar'} title={narrow ? 'Close sidebar' : `Collapse sidebar (${MOD}B)`} tabIndex={expanded ? 0 : -1}>
          <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="icon-btn glass rail__top-btn" onClick={() => openModal('search')} aria-label="Search" title={`Search (${MOD}K)`} tabIndex={expanded ? 0 : -1}>
          <Search size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="icon-btn glass rail__top-btn" onClick={() => openModal('create')} aria-label="New bot" title="New bot" tabIndex={expanded ? 0 : -1}>
          <Plus size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div className="rail__scroll">
        <div className="rail__bots">{ordered.map(railBot)}</div>
        {expanded && hiddenBots.length > 0 && (
          <>
            <div className="rail__label">Hidden Bots</div>
            <div className="rail__bots">{hiddenBots.map(railBot)}</div>
          </>
        )}
      </div>

      <div className="rail__foot">
        <Presence show={!!update && (!!update.available || update.status === 'updating')} ms={180}>
          <UpdatePill tips={!expanded} />
        </Presence>
        {!expanded && (
          <button type="button" className="rail-btn" onClick={() => openModal('create')} aria-label="New bot" {...tipProps('New bot')}>
            <span className="rail-btn__icon"><Plus size={18} strokeWidth={1.6} aria-hidden /></span>
          </button>
        )}
        <AccountButton name={name} avatarUrl={user?.avatarUrl} tips={!expanded} />
      </div>
      <RailTip />
      {toast}
      <Presence show={!!menu} ms={110}>
        {menu && <BotMenu at={menu} onClose={() => setMenu(null)} onDialog={(kind, bot) => setDialog({ kind, bot })} onCopied={(ok) => flash(ok ? 'Copied the conversation' : 'Couldn’t copy the conversation', ok)} />}
      </Presence>
      <Presence show={dialog?.kind === 'delete'}>
        {dialog && (
          <ConfirmDialog
            title={`Delete ${dialog.bot.name}?`}
            body={dialog.bot.kind === 'room'
              ? `This deletes the ${dialog.bot.name} group and its conversation. The bots in it stay. It can’t be undone.`
              : `This deletes ${dialog.bot.name}, its conversation, memories, skills, routines and the files on its computer. It can’t be undone.`}
            confirmLabel="Delete"
            danger
            onConfirm={() => configApi.deleteBot(dialog.bot.id)}
            onClose={() => setDialog(null)}
          />
        )}
      </Presence>
      <Presence show={dialog?.kind === 'primary'}>
        <ChoosePrimaryDialog onClose={() => setDialog(null)} />
      </Presence>
    </aside>
  );
}
