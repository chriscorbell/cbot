import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Clock, MessageSquarePlus, Pencil, Settings2 } from 'lucide-react';
import type { AvatarColor, AvatarShape, Bot, Routine } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText } from '../lib/computer';
import { trapTabWithin } from '../lib/focus';
import { useConfigUI } from '../configStore';
import { displayName, useSelectedBot, useStore } from '../store';
import { configApi } from '../lib/configApi';
import { AvatarPicker } from './AvatarPicker';
import { LibraryTab } from './config/LibraryTab';
import { Icon } from './Icon';
import { MembersCard } from './MembersCard';
import { Presence, useExiting } from './Presence';
import { useNarrow } from './Sidebar';
import { emitUi, notifyFailure } from '../lib/uiEvents';
import { image } from '../lib/http';

// Other files import this from here; it lives in lib/computer so the viewer can use it too.
export { computerStatusText };

/** Puts text in the composer and focuses it (the composer listens for this). */
export function compose(text: string) {
  emitUi('compose', { text });
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

function RoutineRow({ r }: { r: Routine }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await api.setRoutine(r.id, v); } catch { setEnabled(!v); }
  };
  return (
    <div className="panel-row panel-row--routine" title={r.prompt}>
      <span className="panel-row__icon"><Icon name="clock" size={15} /></span>
      <span className="panel-row__text">
        <span className="panel-row__title">{r.name}</span>
        <span className="panel-row__sub">{enabled ? r.description || r.schedule : 'Paused'}</span>
      </span>
      <Toggle on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'off'}`} />
    </div>
  );
}

/** A small picture of the bot's screen, refreshed while the panel is open. */
function ScreenThumb({ bot, running }: { bot: Bot; running: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!running) { setSrc(null); return; }
    let alive = true;
    let url: string | null = null;
    const load = async () => {
      try {
        const picture = await image(`/bots/${bot.id}/screenshot`);
        if (!alive) return;
        if (!picture) { setSrc(null); return; }
        const next = URL.createObjectURL(picture);
        if (!alive) { URL.revokeObjectURL(next); return; }
        setSrc(next);
        if (url) URL.revokeObjectURL(url);
        url = next;
      } catch { /* keep the last picture */ }
    };
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 12_000);
    return () => { alive = false; clearInterval(t); if (url) URL.revokeObjectURL(url); };
  }, [bot.id, running]);
  return (
    <span className={`screen-thumb${src ? ' has-picture' : ''}`} aria-hidden>
      {src ? <img key={src} src={src} alt="" /> : <><BotAvatarFor bot={bot} size={16} mood="asleep" /><span className="screen-thumb__z" aria-hidden><i>z</i><i>z</i></span></>}
    </span>
  );
}

type Tab = 'activity' | 'library';
const TABS: { id: Tab; label: string }[] = [{ id: 'activity', label: 'Activity' }, { id: 'library', label: 'Library' }];

const LS_HIDE_SUGGESTED = 'dispatch.hideSuggested';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/** Saves a bot's look straight away; the server's `bot` event confirms, and a failure puts the old look back. */
async function saveLook(botId: string, patch: { avatarShape?: AvatarShape; avatarColor?: AvatarColor }) {
  const prev = useStore.getState().bots.find((b) => b.id === botId);
  useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, ...patch } : b)) }));
  try {
    await configApi.updateBot(botId, patch);
  } catch {
    if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, avatarShape: prev.avatarShape, avatarColor: prev.avatarColor } : b)) }));
    notifyFailure('Couldn’t save the new look. Check the connection and try again.');
  }
}

/** Restyling a bot in place: the shape grid and swatches under its avatar, applied as you pick. Reset puts back the look it had when the editor opened. */
function LookEditor({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const exiting = useExiting();
  const start = useRef({ avatarShape: bot.avatarShape, avatarColor: bot.avatarColor });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (exiting) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('.details__avatar')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose, exiting]);
  const changed = bot.avatarShape !== start.current.avatarShape || bot.avatarColor !== start.current.avatarColor;
  return (
    <div ref={ref} className={`look-editor${exiting ? ' is-exiting' : ''}`} role="group" aria-label={`${bot.name}’s look`}>
      <div className="look-editor__tabs">
        <span className="look-editor__tab is-active">Bot</span>
        <button type="button" className="look-editor__reset" onClick={() => saveLook(bot.id, start.current)} disabled={!changed}>Reset</button>
      </div>
      <AvatarPicker shape={bot.avatarShape} color={bot.avatarColor} onShape={(avatarShape) => saveLook(bot.id, { avatarShape })} onColor={(avatarColor) => saveLook(bot.id, { avatarColor })} size={26} />
    </div>
  );
}

export function DetailsPanel() {
  const bot = useSelectedBot();
  const routines = useStore((s) => (bot ? s.routines[bot.id] : undefined));
  const computer = useStore((s) => s.computer);
  const unreachable = useStore((s) => (bot ? !!s.screenUnreachable[bot.id] : false));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const mood = live?.activity?.kind === 'waiting_for_you' ? 'waiting' as const : live?.isRunning ? 'working' as const : 'idle' as const;
  const set = useStore((s) => s.set);
  const [tab, setTab] = useState<Tab>('activity');
  const [editing, setEditing] = useState(false);
  const [hideSuggested, setHideSuggested] = useState(() => lsGet(LS_HIDE_SUGGESTED) === '1');
  const exiting = useExiting();
  const overlay = useNarrow('(max-width: 700px)');
  const asideRef = useRef<HTMLElement>(null);
  // Frees the chat under the floating panel at once, for an action that closes the panel and then
  // focuses the composer: iOS raises its keyboard only for focus given inside the tap.
  const release = useRef<(() => void) | null>(null);
  useEffect(() => setEditing(false), [bot?.id]);
  // A search result for a file in this bot's Library opens the Library tab (LibraryTab finds the file).
  const fileJump = useConfigUI((s) => (s.jump?.kind === 'file' && s.jump.botId === bot?.id ? s.jump : null));
  useEffect(() => { if (fileJump) { setTab('library'); setEditing(false); } }, [fileJump]);
  useEffect(() => {
    if (!overlay) return;
    const main = document.querySelector<HTMLElement>('.app > main');
    const side = document.querySelector<HTMLElement>('.app > .sidebar');
    main?.setAttribute('inert', ''); side?.setAttribute('inert', '');
    const prev = document.activeElement as HTMLElement | null;
    asideRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root, .viewer')) useStore.getState().set({ detailsOpen: false }); };
    window.addEventListener('keydown', k);
    const untrap = trapTabWithin(asideRef.current);
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      untrap(); window.removeEventListener('keydown', k); main?.removeAttribute('inert');
      if (!window.matchMedia('(max-width: 560px)').matches) side?.removeAttribute('inert');
    };
    release.current = free;
    // Focus goes back where it was, unless an action freed the chat early to put it there itself.
    return () => { const early = freed; free(); release.current = null; if (!early) prev?.focus?.({ preventScroll: true }); };
  }, [overlay]);
  if (!bot) return null;

  const isRoom = bot.kind === 'room';
  const awake = computer?.status === 'running' && computer.screens.some((x) => x.botId === bot.id);
  const openComputer = () => set({ viewerOpen: true, viewerMode: 'watch' });
  const settings = useConfigUI.getState().openBotSettings;
  const status = !computer ? 'Checking…' : unreachable ? 'Not responding' : computer.status === 'error' ? computerStatusText(computer) : awake ? 'Awake' : 'Asleep';
  const showSuggested = !!routines?.length || !hideSuggested;
  const toggleSuggested = () => { const v = !hideSuggested; setHideSuggested(v); lsSet(LS_HIDE_SUGGESTED, v ? '1' : '0'); };

  return (
    <>
    <div className={`details-scrim${exiting ? ' is-exiting' : ''}`} onClick={() => set({ detailsOpen: false })} aria-hidden />
    <aside ref={asideRef} className={`details${exiting ? ' is-exiting' : ''}${editing ? ' is-editing' : ''}`} style={botVars(bot.avatarColor)} aria-label="Details" {...(overlay ? { role: 'dialog', 'aria-modal': true } : {})}>
      <div className="details__inner">
        <button type="button" className="icon-btn glass details__close" onClick={() => set({ detailsOpen: false })} aria-label="Close details" title="Close">
          <Icon name="close" size={16} />
        </button>
        <div className="details__scroll">
          <div className="details__identity" key={bot.id}>
            {isRoom ? (
              <button type="button" className="details__avatar" onClick={() => settings(bot.id, 'general')} aria-label={`Edit ${bot.name}`} title="Group settings">
                <BotAvatarFor bot={bot} size={52} />
                <span className="details__avatar-edit" aria-hidden><Pencil size={15} strokeWidth={2} /></span>
              </button>
            ) : (
              <button type="button" className={`details__avatar${editing ? ' is-editing' : ''}`} onClick={() => setEditing(!editing)} aria-expanded={editing} aria-label={editing ? 'Done changing the look' : `Change ${bot.name}’s look`}>
                <BotAvatarFor bot={bot} size={52} mood={mood} key={`${bot.avatarShape}:${bot.avatarColor}`} />
                <span className="details__avatar-edit" aria-hidden><Pencil size={15} strokeWidth={2} /></span>
              </button>
            )}
            <div className="details__fold">
              <div className="details__name" title={displayName(bot)}>{bot.name}</div>
              <div
                className="details__tabs"
                role="tablist"
                aria-label="Details sections"
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  const i = TABS.findIndex((t) => t.id === tab);
                  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
                  setTab(next);
                  (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
                }}
              >
                {TABS.map((t) => (
                  <button key={t.id} type="button" role="tab" data-tab={t.id} tabIndex={tab === t.id ? 0 : -1} aria-selected={tab === t.id} className={tab === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {editing ? (
            <div className="details__sections" key={`e:${bot.id}`}>
              <Presence show={editing} ms={140}><LookEditor bot={bot} onClose={() => setEditing(false)} /></Presence>
            </div>
          ) : tab === 'activity' ? (
            <div className="details__sections" key={`a:${bot.id}`}>
              {/* A group chat runs no routines; its members have their own. */}
              {showSuggested && !isRoom && (
                <section>
                  <div className="section-label section-label--row">
                    <span>{routines?.length ? 'Upcoming' : 'Suggested'}</span>
                    {routines?.length
                      ? <button type="button" className="link-btn link-btn--small" onClick={() => settings(bot.id, 'routines')}>Manage</button>
                      : <button type="button" className="link-btn link-btn--small" onClick={toggleSuggested}>Hide</button>}
                  </div>
                  <div className="panel-card">
                    {routines?.length ? routines.map((r) => <RoutineRow key={r.id} r={r} />) : (
                      <button type="button" className="panel-row panel-row--action" onClick={() => { if (overlay) { release.current?.(); set({ detailsOpen: false }); } compose('Set up a routine: '); }}>
                        <span className="panel-row__icon"><Clock size={15} strokeWidth={1.75} aria-hidden /></span>
                        <span className="panel-row__title">Create a routine</span>
                        <ChevronRight className="panel-row__chev" size={14} strokeWidth={2} aria-hidden />
                      </button>
                    )}
                  </div>
                </section>
              )}
              {!isRoom && (
                <section>
                  <div className="section-label">Computer</div>
                  <div className="panel-card">
                    <button type="button" className="panel-row panel-row--action panel-row--computer" onClick={openComputer} title={`Open ${bot.name}’s computer`}>
                      <span className="panel-row__text">
                        <span className="panel-row__title">{bot.name}’s computer</span>
                        <span className="panel-row__sub">{status}</span>
                      </span>
                      <ScreenThumb bot={bot} running={awake && !unreachable} />
                    </button>
                  </div>
                </section>
              )}
              {isRoom && (
                <section>
                  <div className="section-label">Members</div>
                  <MembersCard room={bot} />
                </section>
              )}
              <section>
                <div className="section-label">{isRoom ? 'Group' : 'Bot'}</div>
                <div className="panel-card">
                  <button type="button" className="panel-row panel-row--action" onClick={() => settings(bot.id, 'general')}>
                    <span className="panel-row__icon"><Settings2 size={15} strokeWidth={1.75} aria-hidden /></span>
                    <span className="panel-row__title">{isRoom ? 'Group settings' : 'Bot settings'}</span>
                    <ChevronRight className="panel-row__chev" size={14} strokeWidth={2} aria-hidden />
                  </button>
                  <button type="button" className="panel-row panel-row--action" onClick={() => { if (overlay) set({ detailsOpen: false }); emitUi('fresh', null); }}>
                    <span className="panel-row__icon"><MessageSquarePlus size={15} strokeWidth={1.75} aria-hidden /></span>
                    <span className="panel-row__title">New conversation</span>
                  </button>
                </div>
              </section>
            </div>
          ) : <LibraryTab bot={bot} />}
        </div>
      </div>
    </aside>
    </>
  );
}
