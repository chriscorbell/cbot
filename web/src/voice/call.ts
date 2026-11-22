// Voice calls in the browser. A call is the bot itself on the phone: every utterance becomes a turn of
// the bot's own agent. The call runs over Dispatch's relay (server/src/voice-relay.ts), which speaks a subset
// of the OpenAI Realtime events: microphone audio goes up; recognised speech, the bot's speech, what it
// is doing and when it hangs up come down. While the bot works on a reply and nothing is playing, a
// quiet loop says it is still thinking.
import { create } from 'zustand';
import { voiceApi, type VoiceSession } from './api';
import { EchoCanceller, loadAec3 } from './aec';
import { CallOutput, MicCapture, PcmPlayer, ThinkingLoop, base64ToPcm, createAudioContext, micErrorMessage, openMic, pcmToBase64 } from './audio';
import { EchoGate } from './echo';
import { keepScreenOn, letScreenSleep } from './wakeLock';
import { isAppleMobile } from '../lib/platform';
import type { VoiceEcho } from '@shared/contract';
import type { ClientEvent, RelayEvent } from '@shared/voice-protocol';

export interface Caption { id: string; role: 'user' | 'assistant'; text: string; final: boolean }

/**
 * A call, as the call bar sees it:
 *   idle ──start──► connecting ──session.created──► live ──hang up / goodbye played──► idle
 *                       └──────────── failure ─────────────┴──► error ──6 s──► idle
 * One call at a time; VoiceCall below owns the socket, the microphone and the player.
 */
export type CallStatus = 'idle' | 'connecting' | 'live' | 'error';

interface VoiceState {
  status: CallStatus;
  botId: string | null;
  callId: string | null;
  muted: boolean;
  /** Bot audio is playing. */
  speaking: boolean;
  /** Server VAD hears the user. */
  listening: boolean;
  /** The bot is working on a reply. */
  thinking: boolean;
  /** What the bot is doing for the reply, such as "Searching the web", while a tool runs. */
  activity: string | null;
  captions: Caption[];
  error: string | null;
  startedAt: number | null;
  /**
   * An iPhone's or iPad's call on the loudspeaker (the call bar's Speaker button). Otherwise it plays
   * from the earpiece there; other devices have no choice and play as they always do.
   */
  speaker: boolean;
}

export const useVoice = create<VoiceState>(() => ({
  status: 'idle', botId: null, callId: null, muted: false, speaking: false, listening: false, thinking: false,
  activity: null, captions: [], error: null, startedAt: null, speaker: false,
}));
// Dev builds expose the call state so a call's UI can be checked without a microphone.
if (import.meta.env.DEV) (globalThis as { __dispatchVoice?: unknown }).__dispatchVoice = useVoice;

const setV = (p: Partial<VoiceState>) => useVoice.setState(p);

let current: VoiceCall | null = null;

/** Start a call with a bot. Must be called from a user gesture (click) so audio can start. */
export function startCall(botId: string) {
  if (current && !current.ended) {
    if (current.botId === botId) return;
    current.end();
  }
  current = new VoiceCall(botId);
  void current.start();
}

export function endCall() { current?.end(); }
/** The Speaker button: moves the live call between the loudspeaker and the earpiece (iPhone and iPad). */
export function setSpeaker(on: boolean) {
  const call = current;
  if (!call) return;
  call.setSpeaker(on).catch((e: unknown) => call.end(micErrorMessage(e)));
}
/** Whether this device offers the Speaker button: an iPhone or iPad, where the choice is the microphone's echo cancelling. */
export const hasSpeakerChoice = isAppleMobile;
/** The Speaker button's last choice on this device (configStore's `callSpeaker`), for the next call. */
function savedSpeaker(): boolean {
  try { return !!(JSON.parse(localStorage.getItem('dispatch.prefs') ?? '{}') as { callSpeaker?: unknown }).callSpeaker; } catch { return false; }
}
export function toggleMute() { current?.setMuted(!useVoice.getState().muted); }
/** Moves the live call to the microphone now chosen in the settings (`micId`). Throws if it won't open. */
export async function switchMic() { await current?.switchMic(); }
export function callLevels(): { out: number; mic: number } {
  return current && !current.ended ? { out: current.player.level(), mic: current.micLevel() } : { out: 0, mic: 0 };
}
export const isCallActive = (s: VoiceState = useVoice.getState()) => s.status === 'connecting' || s.status === 'live';


/** How long the bot must be quiet, while it works on a reply, before the thinking loop starts. */
const LOOP_AFTER_MS = 350;

class VoiceCall {
  ended = false;
  /** The context the call plays in, and captures in when it cancels its own echo. */
  private ctx: AudioContext;
  player!: PcmPlayer;
  /**
   * The call's speaker. With the call's own echo canceller (aec.ts) it plays straight from the
   * context; with the browser's, through WebRTC, which is what the browser's knows to remove.
   */
  private output!: CallOutput;
  private loop!: ThinkingLoop;
  /** AEC3, loading from the moment the call button is pressed; null if it can't run here. */
  private aec: Promise<Awaited<ReturnType<typeof loadAec3>> | null>;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private mic: MicCapture | null = null;
  /** Keeps the bot's voice, heard back from the speakers, out of what the relay hears. */
  private gate = new EchoGate();
  private ws: WebSocket | null = null;
  private sess: VoiceSession | null = null;
  private ready = false;
  private responseActive = false;
  /** The item whose audio is playing, and the one the user talked over (its late audio is dropped). */
  private audioItem: string | null = null;
  private interruptedItem: string | null = null;
  private userSpeaking = false;
  private hangingUp = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private onUnload = () => { if (this.sess && !this.ended) voiceApi.endBeacon(this.botId, this.sess.callId, this.transcript(), this.echoStats()); };

  /**
   * On the loudspeaker (iPhone and iPad). There iOS picks where a call plays by the microphone's echo
   * cancelling: with the call's own (AEC3, the browser's off) it plays from the earpiece, clean but
   * too quiet to hear held away; with the browser's, Apple's voice processing, from the loudspeaker
   * through WebRTC, which iOS 26.2 to 27 makes crackle (WebKit bug 326286). So the user chooses, as
   * with a phone call. Elsewhere it is always false.
   */
  private speaker: boolean;

  constructor(readonly botId: string) {
    // Created synchronously inside the click so autoplay policy lets it run.
    this.ctx = createAudioContext();
    this.speakers(this.ctx);
    this.speaker = isAppleMobile() && savedSpeaker();
    this.aec = loadAec3().catch((e: unknown) => {
      console.warn('[voice] AEC3 can’t run here; the browser cancels echo instead:', e);
      return null;
    });
  }

  /** The call's player and thinking loop, playing in `ctx`. */
  private speakers(ctx: AudioContext) {
    this.output = new CallOutput(ctx);
    this.player = new PcmPlayer(ctx, this.output.bus);
    this.loop = new ThinkingLoop(ctx, this.output.bus);
    this.player.onStart = () => { setV({ speaking: true }); this.updateLoop(); };
    this.player.onIdle = () => { setV({ speaking: false }); this.updateLoop(); };
  }

  /**
   * A capture of `stream`. With AEC3 it cancels what the call plays, which has to be in the
   * context the microphone is captured in: before the call connects, the call moves to the
   * microphone's context if it needs one of its own (Firefox, at another rate); after, it can't.
   */
  private capture(stream: MediaStream, aec: Awaited<ReturnType<typeof loadAec3>> | null): MicCapture {
    return new MicCapture(this.ctx, stream, (pcm) => this.sendAudio(pcm), aec ? {
      reference: (ctx) => {
        if (ctx !== this.ctx) {
          if (this.ws) return null;
          this.loop.dispose();
          this.player.dispose();
          this.output.dispose();
          void this.ctx.close().catch(() => {});
          this.ctx = ctx;
          this.speakers(ctx);
        }
        return this.output.bus;
      },
      canceller: (rate) => new EchoCanceller(aec, rate),
    } : undefined);
  }

  micLevel() { return useVoice.getState().muted ? 0 : this.mic?.level ?? 0; }

  /**
   * Another microphone mid-call. The new one starts before the old one stops, so the call keeps
   * hearing throughout; of two quick switches, the later one wins.
   */
  private micSwitch = 0;
  async switchMic() {
    if (this.ended || !this.mic) return;
    const n = ++this.micSwitch;
    const aec = this.mic.cancels ? await this.aec : null;
    let next = this.capture(await openMic({ strict: true, raw: !!aec }), aec);
    if (this.ended || n !== this.micSwitch) { next.stop(); return; }
    try { await next.start(); } catch (e) { next.stop(); throw e; }
    if (aec && !next.cancels) {
      // It can't be captured where the call plays: let the browser cancel echo on it instead.
      next.stop();
      next = this.capture(await openMic({ strict: true }), null);
      try { await next.start(); } catch (e) { next.stop(); throw e; }
    }
    if (this.ended || n !== this.micSwitch) { next.stop(); return; }
    const old = this.mic;
    this.mic = next;
    next.muted = useVoice.getState().muted;
    old?.stop();
  }

  /**
   * The Speaker button, mid-call: a microphone with the other echo cancelling, and the call's sound on
   * the route that goes with it. iOS sets the route when the microphone opens and keeps it for a live
   * track, so the old microphone stops before the new one opens, and the call hears nothing for the
   * half second or so that takes. Shares the microphone switch's count: the latest change wins.
   */
  async setSpeaker(on: boolean) {
    if (this.ended || !this.mic || on === this.speaker) return;
    const n = ++this.micSwitch;
    this.speaker = on;
    setV({ speaker: on });
    const aec = on ? null : await this.aec;
    if (this.ended || n !== this.micSwitch) return;
    const old = this.mic;
    this.mic = null;
    old?.stop();
    let next = this.capture(await openMic({ raw: !!aec }), aec);
    if (this.ended || n !== this.micSwitch) { next.stop(); return; }
    try { await next.start(); } catch (e) { next.stop(); throw e; }
    if (aec && !next.cancels) {
      next.stop();
      next = this.capture(await openMic(), null);
      try { await next.start(); } catch (e) { next.stop(); throw e; }
    }
    if (this.ended || n !== this.micSwitch) { next.stop(); return; }
    this.mic = next;
    next.muted = useVoice.getState().muted;
    if (next.cancels) this.output.playDirect(); else await this.output.start();
  }

  async start() {
    setV({ status: 'connecting', botId: this.botId, callId: null, muted: false, speaking: false, listening: false, thinking: false, activity: null, captions: [], error: null, startedAt: null, speaker: this.speaker });
    window.addEventListener('pagehide', this.onUnload);
    keepScreenOn();
    const aec = this.speaker ? null : await this.aec;
    let stream: MediaStream;
    try {
      stream = await openMic({ raw: !!aec });
    } catch (e) {
      this.end(micErrorMessage(e));
      return;
    }
    if (this.ended) { stream.getTracks().forEach((t) => t.stop()); return; }
    try {
      this.mic = this.capture(stream, aec);
      try {
        await this.mic.start();
      } catch (e) {
        if (!aec) throw e;
        // The call's own canceller couldn't start here: the browser's cancels echo instead.
        console.warn('[voice] capturing for AEC3 failed; the browser cancels echo instead:', e);
        this.mic.stop();
        if (this.ended) return;
        this.mic = this.capture(await openMic(), null);
        await this.mic.start();
      }
      // With the browser's canceller, the speaker moves onto WebRTC while the session is made, so
      // the greeting already plays through it.
      [this.sess] = await Promise.all([voiceApi.session(this.botId), this.mic.cancels ? null : this.output.start()]);
      if (this.ended) { void voiceApi.end(this.botId, this.sess.callId, [], 'Cancelled'); return; }
      setV({ callId: this.sess.callId });
      this.connect(this.sess);
    } catch (e) {
      this.end((e as Error).message || 'Could not start the call');
    }
  }

  private connect(sess: VoiceSession) {
    // The relay is on this origin: ws: on http pages, wss: on https.
    const url = new URL(sess.websocketUrl, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    this.connectTimer = setTimeout(() => { if (!this.ready) this.end('Couldn’t connect the call'); }, 15000);
    ws.onmessage = (m) => {
      // An ended call's socket may still deliver a last event; it must not touch the next call's state.
      if (this.ended || typeof m.data !== 'string') return;
      try { this.handle(JSON.parse(m.data) as RelayEvent); } catch (e) { console.warn('[voice] bad event', e); }
    };
    ws.onclose = (e) => {
      if (this.ended) return;
      this.end(this.ready ? 'Call dropped' : `Couldn’t connect the call${e.reason ? ` (${e.reason})` : ''}`);
    };
  }

  private send(ev: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private sendAudio(pcm: Int16Array) {
    if (!this.ready || this.ended || useVoice.getState().muted) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcmToBase64(this.gate.process(pcm, this.player.outputLevel())) });
  }

  private echoStats(): VoiceEcho {
    return {
      coupling: this.gate.coupling, frames: this.gate.frames, held: this.gate.held, route: this.output.route,
      canceller: this.mic?.cancels ? 'aec3' : 'browser', removedDb: this.mic?.removedDb() ?? undefined, browserCancels: this.mic?.browserCancels(),
      seconds: this.mic?.echoSeconds(),
    };
  }

  setMuted(m: boolean) {
    if (this.mic) this.mic.muted = m;
    if (m && this.ready) this.send({ type: 'input_audio_buffer.clear' });
    if (m) this.userSpeaking = false;
    setV({ muted: m, listening: m ? false : useVoice.getState().listening });
    this.updateLoop();
  }

  /** The loop plays while a reply is being worked on and nobody is talking. */
  private updateLoop() {
    const want = this.responseActive && !this.hangingUp && !this.player.playing && !this.player.holding && !this.userSpeaking && !this.ended;
    if (!want) {
      if (this.loopTimer) clearTimeout(this.loopTimer);
      this.loopTimer = null;
      this.loop.stop();
      return;
    }
    if (this.loop.on || this.loopTimer) return;
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      if (this.responseActive && !this.hangingUp && !this.player.playing && !this.player.holding && !this.userSpeaking && !this.ended) this.loop.start();
    }, LOOP_AFTER_MS);
  }

  // ---------- realtime events ----------

  /** Every relay event; the switch is exhaustive, so a new RelayEvent type must be handled here. */
  private handle(ev: RelayEvent) {
    switch (ev.type) {
      case 'session.created': // the relay is listening
        if (!this.ready) {
          this.ready = true;
          if (this.connectTimer) clearTimeout(this.connectTimer);
          setV({ status: 'live', startedAt: Date.now() });
          this.send({ type: 'response.create' }); // the bot greets first
        }
        return;

      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        setV({ listening: true });
        // Pause and listen. Once the relay has the words, it says whether to play on or stop (dispatch.playback).
        this.player.pause();
        this.updateLoop();
        return;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        setV({ listening: false });
        this.updateLoop();
        return;

      // The relay sends what the user has said so far, whole each time.
      case 'conversation.item.input_audio_transcription.updated':
        this.caption(ev.item_id, 'user', ev.transcript ?? '', false, 'set');
        return;
      case 'conversation.item.input_audio_transcription.completed':
        this.caption(ev.item_id, 'user', ev.transcript ?? '', true, 'set');
        return;
      case 'conversation.item.deleted': // speech dropped on mute
        setV({ captions: useVoice.getState().captions.filter((c) => c.id !== ev.item_id) });
        return;

      case 'response.created':
        this.responseActive = true;
        setV({ thinking: true, activity: null });
        this.updateLoop();
        return;
      case 'response.output_item.added':
        this.caption(ev.item.id, 'assistant', '', false, 'set');
        return;
      case 'response.output_audio_transcript.delta':
        this.caption(ev.item_id, 'assistant', ev.delta ?? '', false, 'append');
        setV({ activity: null });
        return;
      case 'response.output_audio_transcript.done':
        if (ev.transcript) this.caption(ev.item_id, 'assistant', ev.transcript, true, 'set');
        return;
      case 'response.output_audio.delta':
        if (ev.delta && !(this.interruptedItem && ev.item_id === this.interruptedItem)) {
          this.audioItem = ev.item_id;
          this.player.push(base64ToPcm(ev.delta), this.sess?.sampleRate);
        }
        return;
      case 'response.done':
        this.responseActive = false;
        setV({ thinking: false, activity: null });
        this.updateLoop();
        return;

      case 'dispatch.activity':
        setV({ activity: ev.label || null });
        return;
      case 'dispatch.playback':
        if (ev.action === 'resume') {
          this.player.resume();
        } else {
          // Talked over: what it holds goes, and so does that item's audio still on the way.
          this.interruptedItem = this.audioItem;
          this.player.clear();
        }
        this.updateLoop();
        return;
      case 'dispatch.hangup': // the bot said goodbye: let it finish playing, then hang up
        this.hangingUp = true;
        this.updateLoop();
        void this.player.whenIdle().then(() => this.end());
        return;

      case 'error': {
        console.warn('[voice] realtime error', ev.error);
        if (!this.ready) this.end(ev.error.message || 'Voice service error');
        return;
      }
      default: {
        const unhandled: never = ev;
        console.warn('[voice] unknown event', unhandled);
      }
    }
  }

  private caption(id: string | undefined, role: Caption['role'], text: string, final: boolean, mode: 'set' | 'append') {
    if (!id) return;
    const caps = useVoice.getState().captions;
    const i = caps.findIndex((c) => c.id === id);
    if (i < 0) {
      setV({ captions: [...caps, { id, role, text, final }].slice(-200) });
      return;
    }
    const prev = caps[i];
    const next = { ...prev, text: mode === 'append' ? prev.text + text : text || prev.text, final: final || prev.final };
    const copy = caps.slice();
    copy[i] = next;
    setV({ captions: copy });
  }

  transcript() {
    return useVoice.getState().captions.filter((c) => c.text.trim()).map((c) => ({ role: c.role, text: c.text.trim() }));
  }

  // ---------- teardown ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('pagehide', this.onUnload);
    letScreenSleep();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    try { this.ws?.close(1000, 'call ended'); } catch { /* ignore */ }
    const echo = this.echoStats();
    this.mic?.stop();
    this.loop.dispose();
    this.player.dispose();
    this.output.dispose();
    void this.ctx.close().catch(() => {});
    const transcript = this.transcript();
    if (this.sess) void voiceApi.end(this.botId, this.sess.callId, transcript, error, echo).catch((e) => console.warn('[voice] end failed', e));
    if (current === this) current = null;
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, activity: null });
      setTimeout(() => { if (useVoice.getState().status === 'error' && !current) setV({ status: 'idle', botId: null, error: null }); }, 6000);
    } else {
      setV({ status: 'idle', botId: null, callId: null, speaking: false, listening: false, thinking: false, activity: null, startedAt: null });
    }
  }
}

/**
 * Play a short TTS sample through the same PCM path the call uses. Aborting `signal` stops it,
 * whether the sample is still being made or already playing, and resolves quietly.
 */
export async function previewVoice(p: { botId: string; voice?: string; speed?: number }, signal?: AbortSignal): Promise<void> {
  const ctx = createAudioContext();
  const player = new PcmPlayer(ctx);
  // pause() fades the sound out; clear() then lets whenIdle() below resolve.
  const stop = () => { player.pause(); player.clear(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const pcm = await voiceApi.preview(p, signal);
    if (signal?.aborted) return;
    // Feed it in 100 ms chunks, like realtime deltas.
    for (let i = 0; i < pcm.length; i += 2400) player.push(pcm.subarray(i, i + 2400));
    await player.whenIdle();
  } catch (e) {
    if (!signal?.aborted) throw e;
  } finally {
    signal?.removeEventListener('abort', stop);
    // Closing at once would cut the fade short.
    setTimeout(() => { player.dispose(); void ctx.close().catch(() => {}); }, signal?.aborted ? 120 : 0);
  }
}
