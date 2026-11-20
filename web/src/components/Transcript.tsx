import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Ellipsis, FileText, Reply, SmilePlus } from 'lucide-react';
import type { Attachment, Bot, LiveState, MessageBody, Row } from '@shared/types';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { isWaitingForYou } from '../lib/phrases';
import { dividerLabel } from '../lib/time';
import { useStore } from '../store';
import { Menu } from './Menu';
import { Presence } from './Presence';
import { ThinkingBlock } from './ActivityLine';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { emitUi } from '../lib/uiEvents';
import { useConfigUI } from '../configStore';
import { glow } from '../lib/glow';
import { fileUrl } from '../lib/files';
import { FilePreview } from './FilePreview';

type Item =
  | { kind: 'divider'; key: string; ts: number }
  | { kind: 'group'; key: string; side: 'left' | 'right'; from?: MessageBody['from']; rows: Row[] }
  | { kind: 'steps'; key: string; rows: Row[]; /** Row timestamps just before and just after the run of steps. */ startTs: number | null; endTs: number | null }
  | { kind: 'row'; key: string; row: Row };

const DIVIDER_GAP = 60 * 60 * 1000;
const GROUP_GAP = 5 * 60 * 1000;

/** Turns rows into render items: date dividers, grouped bubbles, collapsed tool-call steps, cards, events. */
function buildItems(rows: Row[]): Item[] {
  const items: Item[] = [];
  let prevTs = 0;
  // A finished call's row says everything its "started" row did, so the pair shows as one line.
  const endedCalls = new Set(rows.flatMap((r) => (r.body.type === 'event' && r.body.call?.phase === 'ended' && r.body.ref ? [r.body.ref] : [])));
  for (const row of rows) {
    if (row.body.type === 'event' && row.body.call?.phase === 'started' && row.body.ref && endedCalls.has(row.body.ref)) continue;
    // Older chats have a line for every routine run; frequent routines buried the conversation under them.
    if (row.body.type === 'event' && row.body.event === 'routine-run') continue;
    if (!prevTs || row.createdAt - prevTs > DIVIDER_GAP) items.push({ kind: 'divider', key: `d${row.seq}`, ts: row.createdAt });
    const before = prevTs;
    prevTs = row.createdAt;
    const last = items[items.length - 1];
    const b = row.body;
    if (b.type === 'tool-call') {
      if (last?.kind === 'steps') last.rows.push(row);
      else items.push({ kind: 'steps', key: `s${row.seq}`, rows: [row], startTs: before || null, endTs: null });
      continue;
    }
    if (last?.kind === 'steps' && last.endTs === null) last.endTs = row.createdAt;
    if (b.type === 'message') {
      if ((!b.text && !b.streaming && !b.attachments?.length) || b.note) continue; // notes are the bot thinking aloud
      const side = b.role === 'user' && (!b.from || b.from.kind === 'voice') ? 'right' : 'left';
      const sender = b.from ? `${b.from.kind}:${b.from.id}` : b.role;
      const lastRow = last?.kind === 'group' ? last.rows[last.rows.length - 1] : null;
      const lastBody = lastRow?.body as MessageBody | undefined;
      const lastSender = lastBody ? (lastBody.from ? `${lastBody.from.kind}:${lastBody.from.id}` : lastBody.role) : null;
      if (last?.kind === 'group' && lastSender === sender && row.createdAt - lastRow!.createdAt < GROUP_GAP) last.rows.push(row);
      else items.push({ kind: 'group', key: `g${row.seq}`, side, from: b.from, rows: [row] });
      continue;
    }
    items.push({ kind: 'row', key: `r${row.seq}`, row });
  }
  return items;
}

function cornerClass(i: number, n: number) {
  if (n < 2) return '';
  if (i === 0) return ' is-first';
  if (i === n - 1) return ' is-last';
  return ' is-mid';
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '🎉'];

/** Asks the composer to reply to a message: it shows the quote above the field. */
export function replyTo(text: string, row: Row) {
  emitUi('reply', { text, seq: row.seq, generation: row.generation });
}

/** "> quote" lines at the start of a message the user sent as a reply. */
function splitQuote(text: string): { quote: string | null; rest: string } {
  const m = text.match(/^((?:>[^\n]*\n?)+)\n*/);
  if (!m) return { quote: null, rest: text };
  return { quote: m[1].split('\n').map((l) => l.replace(/^>\s?/, '')).join(' ').trim(), rest: text.slice(m[0].length) };
}

const plain = (md: string) => md.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

/** Reacting, replying and more, beside a message while the pointer is on it. */
function MessageActions({ row, side }: { row: Row; side: 'left' | 'right' }) {
  const b = row.body as MessageBody;
  const [pop, setPop] = useState<'react' | 'more' | null>(null);
  const react = (emoji: string | null) => {
    setPop(null);
    useStore.getState().patchRow(row.botId, row.seq, { reaction: emoji }).catch(() => {});
  };
  return (
    <div className={`msg-actions is-${side}${pop ? ' is-open' : ''}`}>
      <span className="msg-actions__anchor">
        <button type="button" className="msg-actions__btn" onClick={() => setPop(pop === 'react' ? null : 'react')} aria-label="React" aria-expanded={pop === 'react'} title="React">
          <SmilePlus size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <Presence show={pop === 'react'} ms={110}>
          <ReactionPicker current={b.reaction ?? null} onPick={react} onClose={() => setPop(null)} />
        </Presence>
      </span>
      <button type="button" className="msg-actions__btn" onClick={() => replyTo(plain(splitQuote(b.text).rest), row)} aria-label="Reply" title="Reply">
        <Reply size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <span className="msg-actions__anchor">
        <button type="button" className="msg-actions__btn" onClick={() => setPop(pop === 'more' ? null : 'more')} aria-label="More" aria-haspopup="menu" aria-expanded={pop === 'more'} title="More">
          <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <Presence show={pop === 'more'} ms={110}>
          <Menu
            align={side === 'right' ? 'right' : 'left'}
            onClose={() => setPop(null)}
            items={[
              { label: 'Copy text', icon: <Copy size={14} strokeWidth={1.75} />, onSelect: () => { navigator.clipboard.writeText(splitQuote(b.text).rest).catch(() => {}); } },
            ]}
          />
        </Presence>
      </span>
    </div>
  );
}

function ReactionPicker({ current, onPick, onClose }: { current: string | null; onPick: (e: string | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.msg-actions__anchor')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return (
    <div ref={ref} className="reaction-picker" role="menu" aria-label="Reactions">
      {REACTIONS.map((e) => (
        <button key={e} type="button" role="menuitemradio" aria-checked={current === e} className={`reaction-picker__item${current === e ? ' is-on' : ''}`} onClick={() => onPick(current === e ? null : e)}>{e}</button>
      ))}
    </div>
  );
}

/** While a reply streams in, each new word fades up out of a blur. */
function StreamingText({ text }: { text: string }) {
  const words = useMemo(() => plain(text).split(' '), [text]);
  return <div className="bubble__stream">{words.map((w, i) => <span key={i} className="word">{w} </span>)}</div>;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files sent with a message: pictures as thumbnails, everything else as a chip; both open the file's preview. */
function Attachments({ botId, files }: { botId: string; files: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  return (
    <div className="bubble__files">
      {files.map((f) => IMAGE.test(f.name) ? (
        <button key={f.path} type="button" className="bubble__thumb" onClick={() => setOpen(f)} title={f.name}>
          <img src={fileUrl(botId, f.path, true)} alt={f.name} loading="lazy" />
        </button>
      ) : (
        <button key={f.path} type="button" className="bubble__file" onClick={() => setOpen(f)} title={`Open ${f.name}`}>
          <FileText size={14} strokeWidth={1.75} aria-hidden />
          <span className="bubble__file-name">{f.name}</span>
          <span className="bubble__file-size">{size(f.size)}</span>
        </button>
      ))}
      {open && <FilePreview file={{ botId, path: open.path, name: open.name, size: open.size }} onClose={() => setOpen(null)} />}
    </div>
  );
}

const Bubble = memo(function Bubble({ row, side, pos }: { row: Row; side: 'left' | 'right'; pos: string }) {
  const b = row.body as MessageBody;
  const { quote, rest } = side === 'right' ? splitQuote(b.text) : { quote: null, rest: b.text };
  return (
    <div className={`bubble-wrap is-${side}`} data-seq={row.seq}>
      <div className={`bubble is-${side === 'right' ? 'user' : 'agent'}${pos}${b.streaming ? ' is-streaming' : ''}${b.reaction ? ' has-reaction' : ''}`}>
        {quote && <div className="bubble__quote">{quote}</div>}
        {side === 'right' ? (rest || !b.attachments?.length) && <div className="bubble__plain">{rest}</div> : b.streaming ? <StreamingText text={b.text || ' '} /> : <Markdown text={b.text || ' '} />}
        {b.attachments && b.attachments.length > 0 && <Attachments botId={row.botId} files={b.attachments} />}
        {b.citations && b.citations.length > 0 && (
          <div className="bubble__cites">
            {b.citations.slice(0, 6).map((c, i) => {
              let host = c.url;
              try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
              return <a key={i} className="cite-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={c.title ?? c.url}>{host}</a>;
            })}
          </div>
        )}
        {b.reaction && (
          <button type="button" className="bubble__reaction" onClick={() => useStore.getState().patchRow(row.botId, row.seq, { reaction: null }).catch(() => {})} title="Remove reaction" aria-label={`Reacted ${b.reaction}. Remove`}>{b.reaction}</button>
        )}
      </div>
      {!b.streaming && <MessageActions row={row} side={side} />}
    </div>
  );
});

function SenderLabel({ from }: { from: NonNullable<MessageBody['from']> }) {
  const bot = useStore((s) => (from.kind === 'bot' ? s.bots.find((b) => b.id === from.id) : undefined));
  return (
    <div className="sender-label">
      {bot ? <BotAvatarFor bot={bot} size={16} /> : from.kind === 'routine' ? <Icon name="clock" size={14} /> : from.kind === 'voice' ? <Icon name="voice_a" size={14} /> : <BotAvatar shape="blob" color="gray" size={16} />}
      <span>{from.kind === 'routine' ? `Routine · ${from.name}` : from.kind === 'voice' ? 'Asked on a voice call' : `From ${from.name}`}</span>
    </div>
  );
}

const callClock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function VoiceCallRow({ row }: { row: Row }) {
  const b = row.body as Extract<Row['body'], { type: 'event' }>;
  const call = b.call!;
  const [open, setOpen] = useState(false);
  const text = b.text;
  const head = call.title ?? (call.durationMs ? 'Voice chat' : text.split('.')[0].replace('Voice call ended', 'Voice chat'));
  const rest = call.summary ?? (text.includes('. ') ? text.slice(text.indexOf('. ') + 2) : '');
  return (
    <div className={`call-row${open ? ' is-open' : ''}`}>
      <div className="call-row__head">
        <button type="button" className="call-row__title" onClick={() => rest && setOpen(!open)} aria-expanded={rest ? open : undefined} disabled={!rest} title={rest ? (open ? 'Hide summary' : 'Show summary') : undefined}>
          <Icon name="voice_a" size={13} />
          <span>{head}{call.durationMs ? ` · ${callClock(call.durationMs)}` : ''}</span>
        </button>
      </div>
      {open && rest && <div className="call-row__summary">{rest}</div>}
    </div>
  );
}

function SystemRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type === 'event' && b.call?.phase === 'ended') return <VoiceCallRow row={row} />;
  if (b.type === 'event') return <div className="system-event">{b.text}</div>;
  if (b.type === 'notice') return <div className={`notice is-${b.tone ?? 'info'}`}>{b.text}</div>;
  if (b.type === 'card') return <CardRow row={row} />;
  return null;
}

/**
 * Images and cards above a message can finish loading after the chat scrolled to it and push it
 * down. For a moment the view follows the message as the content above grows, and stops as soon as
 * the person scrolls, taps or types.
 */
function keepCentred(el: HTMLElement, centre: () => void, ms = 2000) {
  const col = el.firstElementChild;
  if (!col) return;
  const ro = new ResizeObserver(centre);
  ro.observe(col);
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const stop = () => { ro.disconnect(); clearTimeout(t); events.forEach((e) => el.removeEventListener(e, stop)); };
  const t = setTimeout(stop, ms);
  events.forEach((e) => el.addEventListener(e, stop, { passive: true }));
}

interface Props { bot: Bot; rows: Row[]; live: LiveState | undefined; loaded: boolean }

export function Transcript({ bot, rows, live, loaded }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const items = useMemo(() => buildItems(rows), [rows]);

  const running = !!live?.isRunning;
  const waiting = isWaitingForYou(live);
  const last = rows[rows.length - 1];
  const streamingNow = last?.body.type === 'message' && last.body.role === 'assistant' && !!last.body.streaming;
  const showActivity = (running && !streamingNow) || waiting;

  // Keep pinned to the bottom while new content arrives, unless the user scrolled up. A reply taller
  // than the view stops with its first line under the header, so it reads from the top.
  const lastSeq = last?.seq ?? 0;
  const seenSeq = useRef(lastSeq);
  const readFrom = useRef<number | null>(null);
  const wasLoaded = useRef(loaded);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Rows that arrive with the first load are history, not a new reply.
    if (!loaded || !wasLoaded.current) seenSeq.current = lastSeq;
    wasLoaded.current = loaded;
    if (lastSeq > seenSeq.current && last?.body.type === 'message' && last.body.role === 'assistant') readFrom.current = lastSeq;
    else if (readFrom.current !== lastSeq) readFrom.current = null;
    seenSeq.current = Math.max(seenSeq.current, lastSeq);
    if (!stick.current) return;
    const bottom = el.scrollHeight - el.clientHeight;
    const node = readFrom.current !== null ? el.querySelector<HTMLElement>(`[data-seq="${readFrom.current}"]`) : null;
    if (node) {
      const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 64;
      if (top < bottom) { el.scrollTop = top; stick.current = false; readFrom.current = null; return; }
    }
    el.scrollTop = bottom;
  });
  // Jump to bottom when switching bots.
  useLayoutEffect(() => {
    stick.current = true;
    readFrom.current = null;
    seenSeq.current = lastSeq;
    wasLoaded.current = loaded;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  // A search result asked for one of this chat's messages: centre it and make it glow. The view then
  // stops following new messages, as if the person had scrolled there. A message that isn't in this
  // chat (cleared since) just drops the request.
  const pending = useConfigUI((s) => (s.jump?.kind === 'row' && s.jump.botId === bot.id ? s.jump : null));
  useEffect(() => {
    if (pending?.kind !== 'row' || !loaded) return;
    const el = scrollRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-seq="${pending.seq}"]`);
    if (el && node && rows.some((r) => r.seq === pending.seq && r.generation === pending.generation)) {
      stick.current = false;
      const centre = () => {
        el.scrollTop = Math.max(0, node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - (el.clientHeight - node.offsetHeight) / 2);
        setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
      };
      centre();
      keepCentred(el, centre);
      glow(node.querySelector<HTMLElement>('.bubble') ?? node);
    }
    useConfigUI.getState().clearJump(pending);
  }, [pending, loaded, rows]);

  const onScroll = () => {
    const el = scrollRef.current!;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 40;
    setShowJump(dist > 200);
  };

  const jump = () => {
    const el = scrollRef.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className={`transcript-wrap${showJump ? ' is-scrolled-up' : ''}`}>
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript__col">
        {loaded && rows.length === 0 && <EmptyChat bot={bot} />}
        {items.map((it) => {
          switch (it.kind) {
            case 'divider':
              return <div key={it.key} className="divider">{dividerLabel(it.ts)}</div>;
            case 'steps':
              // Steps don't show in the chat; the one in progress lives in the status line below.
              return null;
            case 'row':
              return <SystemRow key={it.key} row={it.row} />;
            case 'group':
              return (
                <div key={it.key} className={`group is-${it.side}`}>
                  {it.from && <SenderLabel from={it.from} />}
                  {it.rows.map((r, i) => (
                    <Fragment key={r.seq}><Bubble row={r} side={it.side} pos={cornerClass(i, it.rows.length)} /></Fragment>
                  ))}
                </div>
              );
          }
        })}
        {showActivity && live && (
          <ThinkingBlock bot={bot} live={live} rows={rows} />
        )}
      </div>
    </div>
      {showJump && (
        <button type="button" className="jump-btn glass" onClick={jump} aria-label="Scroll to bottom">
          <Icon name="arrow_down" size={16} />
        </button>
      )}
    </div>
  );
}

function EmptyChat({ bot }: { bot: Bot }) {
  return (
    <div className="empty-chat">
      <BotAvatarFor bot={bot} size={56} />
      <div className="empty-chat__title">{bot.name}</div>
      <div className="empty-chat__sub">{bot.description || (bot.kind === 'room' ? 'A group chat. Everyone here sees each message.' : 'Hand it a task and it will see it through on its own computer.')}</div>
    </div>
  );
}
