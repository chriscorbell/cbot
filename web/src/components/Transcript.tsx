import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Ellipsis, FileText, MessagesSquare, Reply, SmilePlus } from 'lucide-react';
import type { Attachment, Bot, BotQuestion, LiveState, MessageBody, Row } from '@shared/types';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { isWaitingForYou } from '../lib/phrases';
import { dividerLabel } from '../lib/time';
import { useStore } from '../store';
import { Menu } from './Menu';
import { Presence, useExiting } from './Presence';
import { ThinkingBlock } from './ActivityLine';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { emitUi, notifyFailure } from '../lib/uiEvents';
import { useConfigUI } from '../configStore';
import { glow } from '../lib/glow';
import { fileUrl } from '../lib/files';
import { FilePreview } from './FilePreview';
import { useLongPress } from '../lib/longPress';

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

/** A reaction the server didn't take: patchRow has put the old one back, and this says so. */
const reactionFailed = () => notifyFailure('Couldn’t save the reaction. Check the connection and try again.');

/** Reacting, replying and more, beside a message while the pointer is on it. */
function MessageActions({ row, side }: { row: Row; side: 'left' | 'right' }) {
  const b = row.body as MessageBody;
  const [pop, setPop] = useState<'react' | 'more' | null>(null);
  const react = (emoji: string | null) => {
    setPop(null);
    useStore.getState().patchRow(row.botId, row.seq, { reaction: emoji }).catch(reactionFailed);
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

/**
 * The same actions on a touch screen, where nothing hovers: holding a message lifts it, with the
 * reactions above it and Reply and Copy below. Any other tap puts it back and does nothing else.
 */
function TouchActions({ row, side, onClose }: { row: Row; side: 'left' | 'right'; onClose: () => void }) {
  const b = row.body as MessageBody;
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useExiting();
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      const swallow = (ev: MouseEvent) => { ev.preventDefault(); ev.stopPropagation(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 500);
      onClose();
    };
    document.addEventListener('pointerdown', down, true);
    // A message at the edge of the view scrolls in far enough for the reactions above it and the menu
    // below it to show; if all three can't fit, the reactions and the message win.
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>('.transcript');
    const above = el?.querySelector<HTMLElement>('.reaction-picker');
    const below = el?.querySelector<HTMLElement>('.menu');
    if (scroller && above && below) {
      const view = scroller.getBoundingClientRect();
      const top = view.top + parseFloat(getComputedStyle(scroller).paddingTop);
      const bottom = view.bottom - 12;
      let dy = Math.max(0, below.offsetTop + below.offsetHeight + el!.getBoundingClientRect().top - bottom);
      const pickerTop = el!.getBoundingClientRect().top - above.offsetHeight - 8;
      if (pickerTop - dy < top) dy = pickerTop - top;
      if (Math.abs(dy) > 1) scroller.scrollBy({ top: dy, behavior: 'smooth' });
    }
    return () => document.removeEventListener('pointerdown', down, true);
  }, [onClose]);
  const react = (emoji: string | null) => {
    onClose();
    useStore.getState().patchRow(row.botId, row.seq, { reaction: emoji }).catch(reactionFailed);
  };
  const current = b.reaction ?? null;
  const ic = { size: 15, strokeWidth: 1.75 } as const;
  return (
    <div ref={ref} className={`touch-actions is-${side}${exiting ? ' is-exiting' : ''}`}>
      <div className="reaction-picker" role="menu" aria-label="Reactions">
        {REACTIONS.map((e) => (
          <button key={e} type="button" role="menuitemradio" aria-checked={current === e} className={`reaction-picker__item${current === e ? ' is-on' : ''}`} onClick={() => react(current === e ? null : e)}>{e}</button>
        ))}
      </div>
      <div className="menu" role="menu">
        <button type="button" role="menuitem" className="menu__item" onClick={() => { onClose(); replyTo(plain(splitQuote(b.text).rest), row); }}>
          <span className="menu__item-main"><Reply {...ic} aria-hidden /><span>Reply</span></span>
        </button>
        <button type="button" role="menuitem" className="menu__item" onClick={() => { onClose(); navigator.clipboard.writeText(splitQuote(b.text).rest).catch(() => {}); }}>
          <span className="menu__item-main"><Copy {...ic} aria-hidden /><span>Copy text</span></span>
        </button>
      </div>
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
  const [held, setHeld] = useState(false);
  const press = useLongPress(() => { if (!b.streaming) setHeld(true); });
  const release = useCallback(() => setHeld(false), []);
  return (
    <div className={`bubble-wrap is-${side}${held ? ' is-held' : ''}`} data-seq={row.seq} {...press}>
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
          <button type="button" className="bubble__reaction" onClick={() => useStore.getState().patchRow(row.botId, row.seq, { reaction: null }).catch(reactionFailed)} title="Remove reaction" aria-label={`Reacted ${b.reaction}. Remove`}>{b.reaction}</button>
        )}
      </div>
      {!b.streaming && <MessageActions row={row} side={side} />}
      <Presence show={held} ms={140}><TouchActions row={row} side={side} onClose={release} /></Presence>
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

/**
 * One bot's question to another (ask_bot), in both their chats: a quiet line that opens to the question
 * and the answer. The asker's chat says whom it asked; the answerer's chat says who asked.
 */
function BotQuestionRow({ row, ask }: { row: Row; ask: BotQuestion }) {
  const [open, setOpen] = useState(false);
  const asker = row.botId === ask.from.id;
  const asking = ask.status === 'asking';
  const head = asker ? (asking ? `Asking ${ask.to.name}…` : `Asked ${ask.to.name}`) : (asking ? `${ask.from.name} is asking…` : `${ask.from.name} asked`);
  const question = ask.question.replace(/\s+/g, ' ').trim();
  return (
    <div className={`call-row ask-row is-${ask.status}${open ? ' is-open' : ''}`}>
      <div className="call-row__head">
        <button type="button" className="call-row__title ask-row__title" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the question' : 'Show the question and answer'}>
          <MessagesSquare className="ask-row__icon" size={13} strokeWidth={1.9} aria-hidden />
          <span className="ask-row__head">{head}</span>
          <span className="ask-row__question">{question}</span>
        </button>
      </div>
      {open && (
        <div className="call-row__summary ask-row__body">
          <div className="ask-row__part">
            <div className="ask-row__who">{ask.from.name}</div>
            <div className="ask-row__text">{ask.question}</div>
          </div>
          {ask.answer && (
            <div className={`ask-row__part${ask.status === 'failed' ? ' is-failed' : ''}`}>
              <div className="ask-row__who">{ask.status === 'failed' ? 'No answer' : ask.to.name}</div>
              {ask.status === 'failed' ? <div className="ask-row__text">{ask.answer}</div> : <Markdown text={ask.answer} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type === 'event' && b.call?.phase === 'ended') return <VoiceCallRow row={row} />;
  if (b.type === 'event' && b.event === 'bot-question' && b.ask) return <BotQuestionRow row={row} ask={b.ask} />;
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
  // The view shrinks when a phone keyboard comes up, and grows back when it goes: a chat that was at
  // its latest message stays there instead of leaving it under the keyboard.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
