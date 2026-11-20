// Composer dictation: hold the mic to talk (or tap to start, tap again to stop). Records with MediaRecorder,
// transcribes it through the server (the speech service's Parakeet model), and hands the text back to the composer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceApi } from './api';
import { micErrorMessage, openMic } from './audio';

/**
 * idle ──press──► (asking for the mic) ──► recording ──release / tap / 2 min──► transcribing ──► idle
 * Esc or unmount while recording cancels; the transcript then never reaches the composer.
 */
export type DictationState = 'idle' | 'recording' | 'transcribing';

const HOLD_MS = 350;
const MAX_MS = 120_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
}

/**
 * `owner` names what the dictation is for (the composer passes its bot id); it is handed back with the
 * transcript, which can arrive after the composer moved on to another bot.
 */
export function useDictation(owner: string, onText: (text: string, owner: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; downAt: number; cancelled: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const starting = useRef(false);
  /** The composer went away: a mic granted after that is closed at once. */
  const disposed = useRef(false);
  const toggleMode = useRef(false);
  const cb = useRef({ onText, onError, owner });
  cb.current = { onText, onError, owner };

  const finish = useCallback((cancel = false) => {
    const r = rec.current;
    if (!r) return;
    r.cancelled = cancel;
    clearTimeout(r.timer);
    if (r.mr.state !== 'inactive') r.mr.stop();
    else r.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    if (typeof MediaRecorder === 'undefined') { cb.current.onError('Dictation isn’t supported in this browser.'); return; }
    starting.current = true;
    const downAt = Date.now();
    const forOwner = cb.current.owner;
    try {
      const stream = await openMic();
      if (disposed.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const r = { mr, stream, chunks: [] as Blob[], downAt, cancelled: false, timer: setTimeout(() => finish(), MAX_MS) };
      rec.current = r;
      mr.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        toggleMode.current = false;
        if (r.cancelled || !r.chunks.length || Date.now() - r.downAt < 250) { setState('idle'); return; }
        setState('transcribing');
        try {
          const text = await voiceApi.transcribe(new Blob(r.chunks, { type: mr.mimeType || mime || 'audio/webm' }));
          if (text) cb.current.onText(text, forOwner);
        } catch (e) {
          cb.current.onError((e as Error).message || 'Transcription failed');
        } finally {
          setState('idle');
        }
      };
      mr.start(250);
      setState('recording');
    } catch (e) {
      cb.current.onError(micErrorMessage(e));
      setState('idle');
    } finally {
      starting.current = false;
    }
  }, [finish]);

  // Pointer handlers: press-and-hold records until release; a quick tap toggles recording on, tap again stops.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (rec.current && toggleMode.current) { finish(); return; }
    void begin();
  }, [begin, finish]);

  const onPointerUp = useCallback(() => {
    const r = rec.current;
    if (!r) {
      // Still waiting on the permission prompt: treat as a tap.
      if (starting.current) toggleMode.current = true;
      return;
    }
    if (toggleMode.current) return;
    if (Date.now() - r.downAt < HOLD_MS) toggleMode.current = true; // tap: keep recording
    else finish();
  }, [finish]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (rec.current) finish();
    else { toggleMode.current = true; void begin(); }
  }, [begin, finish]);

  // Esc cancels; unmount stops.
  useEffect(() => {
    if (state !== 'recording') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [state, finish]);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; finish(true); };
  }, [finish]);

  return { state, onPointerDown, onPointerUp, onKeyDown, cancel: () => finish(true) };
}
