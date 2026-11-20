import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { FileText, Image as ImageIcon, MicOff, Plus, X } from 'lucide-react';
import type { Attachment, Bot, Row } from '@shared/types';
import { api } from '../lib/api';
import { useConfigUI } from '../configStore';
import { Icon } from './Icon';
import { isCallActive, startCall, toggleMute, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { onUi } from '../lib/uiEvents';
import { replyAction, type ReplyRef } from '../lib/reply';
import { useStore } from '../store';

const MAX_H = 200;
const drafts = new Map<string, string>();

/** True when the bot's latest question card is still waiting for an answer. */
/**
 * The placeholder cut to the empty box's width, ending in …: a textarea's placeholder can't be told to
 * stop at one line with CSS, and the empty box is one line tall (a long bot name on a phone would
 * otherwise wrap out of sight). Measured with the box's own font, again when it resizes or fonts load.
 */
function useFittedPlaceholder(ref: RefObject<HTMLTextAreaElement>, text: string) {
  const [fitted, setFitted] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!el || !ctx) { setFitted(text); return; }
    const fit = () => {
      const cs = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const fits = (s: string) => ctx.measureText(s).width <= room;
      if (room <= 0 || fits(text)) { setFitted(text); return; }
      let lo = 0, hi = text.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(`${text.slice(0, mid).trimEnd()}…`)) lo = mid; else hi = mid - 1; }
      setFitted(`${text.slice(0, lo).trimEnd()}…`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) fit(); }, () => {});
    return () => { alive = false; ro.disconnect(); };
  }, [ref, text]);
  return fitted;
}

function hasOpenQuestion(rows: Row[]) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = rows[i].body;
    if (b.type === 'card' && b.card === 'question') return b.status === 'pending';
    if (b.type === 'message' && b.role === 'user') return false;
  }
  return false;
}

type Pending = { id: string; file: File; status: 'uploading' | 'done' | 'error'; att?: Attachment; error?: string };

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);

export function Composer({ bot, running, rows }: { bot: Bot; running: boolean; rows: Row[] }) {
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A group has no voice calls (its members each have their own voice), so its button is always Send.
  const canCall = bot.kind !== 'room';
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyRef | null>(null);
  const [wrapped, setWrapped] = useState(false);
  const spellcheck = useConfigUI((s) => s.spellcheck);
  const sendWithMod = useConfigUI((s) => s.sendWithMod);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The composer is reused across bots; a send that finishes after a switch must not clear the next bot's draft.
  const shownBot = useRef(bot.id);
  shownBot.current = bot.id;

  // Per-bot drafts.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); setReply(null); setFiles([]); ref.current?.focus(); }, [bot.id]);

  // Replying to a message, or answering a question in your own words.
  // A reply quotes a row of one chat; after "New chat" it has nothing left to point at.
  const generation = useStore((s) => s.transcripts[bot.id]?.generation);
  useEffect(() => { setReply((r) => (r && generation !== undefined && r.generation !== generation ? null : r)); }, [generation]);
  useEffect(() => onUi('reply', (d) => {
    setReply(d);
    requestAnimationFrame(() => ref.current?.focus());
  }), []);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Other parts of the app can hand the composer a starting line (e.g. "Create a routine").
  useEffect(() => onUi('compose', ({ text: t }) => {
    setText(t);
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length); } });
  }), []);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
    // scrollHeight counts the padding, so take it off before comparing with one line.
    const cs = getComputedStyle(el);
    setWrapped(el.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) > parseFloat(cs.lineHeight) * 1.5);
  }, [text]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Files upload as soon as they are picked, so sending is instant.
  const attach = (list: FileList | File[]) => {
    const picked = Array.from(list).slice(0, 20);
    if (!picked.length) return;
    const items: Pending[] = picked.map((file) => ({ id: `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`, file, status: 'uploading' }));
    setFiles((cur) => [...cur, ...items]);
    for (const it of items) {
      api.upload(bot.id, it.file)
        .then((att) => setFiles((cur) => cur.map((x) => (x.id === it.id ? { ...x, status: 'done', att } : x))))
        .catch((e) => setFiles((cur) => cur.map((x) => (x.id === it.id ? { ...x, status: 'error', error: (e as Error).message } : x))));
    }
    ref.current?.focus();
  };
  const uploading = files.some((f) => f.status === 'uploading');
  const ready = files.flatMap((f) => (f.status === 'done' && f.att ? [f.att] : []));

  const send = async () => {
    const t = text.trim();
    if ((!t && !ready.length) || sending || uploading) return;
    setSending(true); setError(null);
    const to = bot.id;
    try {
      const action = reply ? replyAction(reply, rows, ready.length > 0) : null;
      if (action?.kind === 'answer') await api.answer(to, action.seq, action.generation, t);
      else if (action) await api.send(to, action.message(t), ready);
      else await api.send(to, t, ready);
      // Clear what was sent, not what was typed while it was sending.
      if (shownBot.current === to) {
        setText((cur) => (cur.trim() === t ? '' : cur));
        setReply(null);
        setFiles([]);
      }
      if (drafts.get(to)?.trim() === t) drafts.delete(to);
    } catch (e) {
      if (shownBot.current === to) setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  // A transcript for a bot no longer shown goes to that bot's draft instead.
  const dictated = (t: string, forBot: string) => {
    if (forBot === shownBot.current) return insertText(t);
    const draft = drafts.get(forBot) ?? '';
    drafts.set(forBot, draft ? `${draft} ${t}` : t);
  };
  const dictation = useDictation(bot.id, dictated, setError);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  const muted = useVoice((s) => s.muted);

  const hasText = text.trim().length > 0 || ready.length > 0;
  const fullPlaceholder = reply ? 'Reply…' : hasOpenQuestion(rows) ? 'Type your answer…' : `Message ${bot.name}`;
  const placeholder = useFittedPlaceholder(ref, fullPlaceholder);
  const multiline = text.includes('\n') || wrapped;

  return (
    <div
      className={`composer-area${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}
    >
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className={`composer${multiline || reply || files.length ? ' is-multiline' : ''}${reply || files.length ? ' has-reply' : ''}`}>
        {files.length > 0 && (
          <div className="composer__files">
            {files.map((f) => (
              <span key={f.id} className={`file-chip is-${f.status}`} title={f.error ?? f.file.name}>
                {f.status === 'uploading' ? <span className="file-chip__spin" aria-hidden /> : f.file.type.startsWith('image/') ? <ImageIcon size={13} strokeWidth={1.75} aria-hidden /> : <FileText size={13} strokeWidth={1.75} aria-hidden />}
                <span className="file-chip__name">{f.file.name}</span>
                <span className="file-chip__size">{f.status === 'error' ? 'Failed' : kb(f.file.size)}</span>
                <button type="button" className="file-chip__remove" onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.file.name}`}>
                  <X size={11} strokeWidth={2.25} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        {reply && (
          <div className="composer__reply">
            <span className="composer__reply-text">{reply.text}</span>
            <button type="button" className="composer__reply-close" onClick={() => { setReply(null); ref.current?.focus(); }} aria-label="Cancel reply" title="Cancel reply">
              <X size={13} strokeWidth={2} aria-hidden />
            </button>
          </div>
        )}
        <div className="composer__plus-anchor">
          <button type="button" className="composer__btn composer__plus" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files">
            <Plus size={18} strokeWidth={1.6} aria-hidden />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) attach(e.target.files); e.target.value = ''; }} />
        </div>
        <div className="composer__left">
          <textarea
            ref={ref}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); attach(e.clipboardData.files); } }}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (sendWithMod ? mod : !mod)) { e.preventDefault(); send(); }
              else if (e.key === 'Escape' && reply) { e.preventDefault(); setReply(null); }
              else if (e.key === 'Backspace' && reply && !text) setReply(null);
            }}
            aria-label={`Message ${bot.name}`}
            spellCheck={spellcheck}
          />
        </div>
        <div className="composer__right">
          {!inCall && <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" size={16} />
          </button>}
          {inCall && !hasText ? (
            <button type="button" className={`composer__cta is-in-call${muted ? ' is-muted' : ''}`} onClick={toggleMute} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
              {muted ? <MicOff size={15} strokeWidth={2} aria-hidden /> : <Icon name="mic" size={15} strokeWidth={2} />}
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasText || !canCall ? send : () => startCall(bot.id)}
              disabled={(hasText || !canCall) && (!hasText || sending || uploading)}
              aria-label={hasText || !canCall ? 'Send' : `Start voice chat with ${bot.name}`}
              title={hasText || !canCall ? 'Send (Enter)' : 'Start voice chat'}
            >
              <Icon name={hasText || !canCall ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
