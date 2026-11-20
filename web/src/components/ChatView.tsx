import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, PanelLeft } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { isWaitingForYou } from '../lib/phrases';
import { sortedRows, useSelectedBot, useStore } from '../store';
import { Composer } from './Composer';
import { ConfirmDialog } from './modals/ConfirmDialog';
import { Presence, useExiting } from './Presence';
import { MOD } from './Sidebar';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';
import { isCallActive, useVoice } from '../voice/call';
import { onUi } from '../lib/uiEvents';
import { useToast } from './Toast';

/** Opens the sidebar drawer on narrow screens, with the same icon as the wide screen's toggle; hidden on wide ones. */
export function DrawerButton() {
  const set = useStore((s) => s.set);
  return (
    <button type="button" className="icon-btn glass drawer-btn" onClick={() => set({ drawerOpen: true })} aria-label="Open sidebar">
      <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** Opens the rail into the full sidebar on wide screens. While it is open, its own top row has the button that closes it. */
export function RailToggle() {
  const expanded = useStore((s) => s.sidebarExpanded);
  return (
    <Presence show={!expanded} ms={140}>
      <ExpandButton />
    </Presence>
  );
}

function ExpandButton() {
  const exiting = useExiting();
  return (
    <button type="button" className={`icon-btn glass rail-toggle header-pop${exiting ? ' is-exiting' : ''}`} onClick={() => useStore.getState().set({ sidebarExpanded: true })} aria-label="Expand sidebar" title={`Expand sidebar (${MOD}B)`}>
      <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const inCall = useVoice((s) => !!bot && isCallActive(s) && s.botId === bot.id);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [toast, flash] = useToast();
  // The details panel asks for a fresh conversation; the confirmation lives here, with the chat.
  useEffect(() => onUi('fresh', () => setConfirmFresh(true)), []);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <header className="chat__header"><div className="chat__side"><DrawerButton /><RailToggle /></div></header>
        <div className="empty-chat"><div className="empty-chat__sub">Pick a bot, or make a new one with +.</div></div>
      </main>
    );
  }

  const waiting = isWaitingForYou(live);
  // "Needs you" takes the person to the first open question, wherever it is in the chat.
  const jumpToPending = () => {
    const el = document.querySelector<HTMLElement>('.transcript .card:not(.is-resolved)') ?? document.querySelector<HTMLElement>('.transcript .thinking');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash');
    el.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  const toggleDetails = () => set({ detailsOpen: !detailsOpen });

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <header className="chat__header">
        <div className="chat__side">
          <DrawerButton />
          <RailToggle />
        </div>
        <div className="chat__center">
          <button
            type="button"
            className={`chat__chip glass is-hoverable${inCall ? ' is-in-call' : ''}`}
            onClick={toggleDetails}
            aria-pressed={detailsOpen}
            aria-label={`${bot.name}: ${detailsOpen ? 'hide' : 'show'} details`}
            title={`${detailsOpen ? 'Hide' : 'Show'} details (${MOD}⇧,)`}
          >
            <span className="chat__chip-avatar"><BotAvatarFor bot={bot} size={18} mood={waiting ? 'waiting' : live?.isRunning ? 'working' : 'idle'} /></span>
            <span className="chat__chip-name">{bot.name}</span>
            <span className="chat__chip-chev" aria-hidden><ChevronRight size={12} strokeWidth={2} /></span>
          </button>
          {waiting && (
            <button type="button" className="chat__status glass" onClick={jumpToPending} title="Show what needs you"><i aria-hidden />Needs you</button>
          )}
        </div>
        {/* Empty, so the bot's chip stays centred between the two sides. */}
        <div className="chat__side is-right" />
      </header>
      <VoiceCallBar />
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <Composer bot={bot} running={!!live?.isRunning} rows={rows} />
      {toast}
      <Presence show={confirmFresh}>
        <ConfirmDialog
          title="Start a new conversation?"
          body={bot.kind === 'room' ? `This clears the ${bot.name} group chat. The bots’ own chats stay.` : `This clears the chat with ${bot.name}. Memories, skills and routines stay.`}
          confirmLabel="Start new"
          onConfirm={() => api.fresh(bot.id).then(() => flash('Started a new conversation'))}
          onClose={() => setConfirmFresh(false)}
        />
      </Presence>
    </main>
  );
}
