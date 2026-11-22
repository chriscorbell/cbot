// Browser audio for voice calls: mic capture → PCM16 @ 24 kHz (AudioWorklet), and a gapless PCM16 player.
import type { EchoCanceller } from './aec';
import { EchoLog } from './echo-log';

export const RATE = 24000;

// The worklet runs at the context's native rate (usually 48 kHz). It box-filters down to 24 kHz,
// converts to Int16 and posts 40 ms frames plus a level for the UI. With `raw`, it posts 40 ms of
// the microphone (input 0) and of what the call plays (input 1) as they are, for the echo canceller,
// with how many render quanta came with no microphone audio (the echo log counts them).
const WORKLET = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.raw = !!o.raw;
    this.block = Math.round(sampleRate * 0.04);
    this.mic = new Float32Array(this.block); this.ref = new Float32Array(this.block); this.m = 0; this.gaps = 0;
    this.target = o.rate || 24000;
    this.ratio = sampleRate / this.target;
    this.frame = new Int16Array(Math.round(this.target * 0.04));
    this.n = 0; this.sum = 0; this.cnt = 0; this.t = 0; this.peak = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) { this.gaps++; return true; }
    if (this.raw) {
      const ref = inputs[1] && inputs[1][0];
      for (let i = 0; i < ch.length; i++) {
        this.mic[this.m] = ch[i];
        this.ref[this.m] = ref ? ref[i] : 0;
        if (++this.m === this.block) {
          const mic = this.mic.slice(0); const played = this.ref.slice(0);
          this.port.postMessage({ mic: mic.buffer, ref: played.buffer, gaps: this.gaps }, [mic.buffer, played.buffer]);
          this.m = 0; this.gaps = 0;
        }
      }
      return true;
    }
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sum += s; this.cnt++; this.t += 1;
      const a = s < 0 ? -s : s; if (a > this.peak) this.peak = a;
      if (this.t >= this.ratio) {
        this.t -= this.ratio;
        let v = this.sum / this.cnt; this.sum = 0; this.cnt = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.frame.length) {
          const out = this.frame.slice(0);
          this.port.postMessage({ pcm: out.buffer, level: this.peak }, [out.buffer]);
          this.n = 0; this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
`;

let workletUrl: string | null = null;
const loadedContexts = new WeakSet<BaseAudioContext>();

async function ensureWorklet(ctx: AudioContext) {
  if (loadedContexts.has(ctx)) return;
  workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(workletUrl);
  loadedContexts.add(ctx);
}

/** Create (and resume) an AudioContext. Call this synchronously inside a click handler so autoplay rules allow it. */
export function createAudioContext(): AudioContext {
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx({ latencyHint: 'interactive' });
  void ctx.resume().catch(() => {});
  return ctx;
}

export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow it in your browser’s site settings.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found.';
  if (name === 'NotReadableError') return 'Your microphone is in use by another app.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser can’t use the microphone here (it needs HTTPS or localhost).';
  return (e as Error)?.message || 'Could not open the microphone.';
}

/**
 * The microphone picked in Settings (or the call's settings), if it is still plugged in; the system
 * default otherwise. `strict` is for picking one on purpose: then a microphone that won't open is an
 * error rather than a quiet switch to the default. `raw` turns the browser's processing off, for a
 * call that cancels echo itself (aec.ts): its noise suppression and gain control would change the
 * echo from one moment to the next, and the canceller needs it to stay a copy of what played.
 */
export async function openMic(opts: { strict?: boolean; raw?: boolean } = {}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mediaDevices'), { name: 'NotSupportedError' });
  let micId = '';
  try { micId = JSON.parse(localStorage.getItem('dispatch.prefs') ?? '{}').micId ?? ''; } catch { /* default */ }
  const on = !opts.raw;
  const base = { echoCancellation: on, noiseSuppression: on, autoGainControl: on, channelCount: 1 };
  if (micId) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: micId } } }); } catch (e) { if (opts.strict) throw e; }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}

/**
 * Firefox can't connect a microphone to a context running at another sample rate (Mozilla bug
 * 1674892), as with a 44.1 kHz microphone and 48 kHz speakers; Chrome resamples quietly. Find a rate
 * it accepts and capture in a context of its own; the worklet resamples to 24 kHz from any rate.
 */
export async function captureContext(stream: MediaStream): Promise<{ ctx: AudioContext; source: MediaStreamAudioSourceNode } | null> {
  const told = stream.getAudioTracks()[0]?.getSettings().sampleRate;
  const rates = [...new Set([told, 48000, 44100, 32000, 24000, 16000].filter((r): r is number => !!r))];
  for (const sampleRate of rates) {
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      const source = ctx.createMediaStreamSource(stream);
      void ctx.resume().catch(() => {});
      return { ctx, source };
    } catch {
      void ctx?.close().catch(() => {});
    }
  }
  return null;
}

/** How long to wait for the microphone's first frame (40 ms of audio) before deciding it isn't coming. */
const FIRST_FRAME_MS = 1500;

/**
 * A call's own echo cancelling, for MicCapture. `reference` gives the node carrying what the call
 * plays, in the context the microphone is captured in, or null if the call doesn't play there. When
 * that is the capture's own context (see captureContext), returning a node hands the context over:
 * the call plays in it, so the capture doesn't close it.
 */
export interface Cancelling {
  reference: (ctx: AudioContext) => AudioNode | null;
  canceller: (rate: number) => EchoCanceller;
}

type CaptureMessage = { pcm: ArrayBuffer; level: number } | { mic: ArrayBuffer; ref: ArrayBuffer; gaps: number };

export class MicCapture {
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  /** A capture context of its own, when the call's context and the microphone disagree on rate. */
  private own: AudioContext | null = null;
  private heard: (() => void) | null = null;
  private reference: AudioNode | null = null;
  private aec: EchoCanceller | null = null;
  private log: EchoLog | null = null;
  /** Cancelled audio at 24 kHz not yet sent as a whole frame. */
  private pending = new Float32Array(0);
  /** The context the microphone is captured in, once started. */
  context: AudioContext | null = null;
  level = 0;

  constructor(private ctx: AudioContext, private stream: MediaStream, private onFrame: (pcm: Int16Array) => void, private cancelling?: Cancelling) {}

  /** The call's own canceller is removing what the call plays from this microphone. */
  get cancels() { return this.aec !== null; }

  /** How much the canceller has taken off the microphone while the call played, in dB. */
  removedDb() { return this.aec?.removedDb() ?? null; }

  /** The call second by second while the bot was audible, with AEC3. */
  echoSeconds() { return this.log?.seconds; }

  /** Whether the browser says it is cancelling echo on this microphone itself. */
  browserCancels(): boolean | undefined {
    const ec = this.stream.getAudioTracks()[0]?.getSettings().echoCancellation;
    return typeof ec === 'boolean' ? ec : undefined;
  }

  async start() {
    let ctx = this.ctx;
    try {
      this.source = ctx.createMediaStreamSource(this.stream);
    } catch (e) {
      const found = await captureContext(this.stream);
      if (!found) throw e;
      ({ ctx, source: this.source } = found);
      this.own = ctx;
    }
    this.context = ctx;
    this.reference = this.cancelling?.reference(ctx) ?? null;
    if (this.reference && ctx === this.own) this.own = null;
    if (this.reference) {
      this.aec = this.cancelling!.canceller(ctx.sampleRate);
      const context = ctx;
      this.log = new EchoLog(ctx.sampleRate, () => (typeof context.outputLatency === 'number' ? Math.round(context.outputLatency * 1000) : null));
    }
    await ensureWorklet(ctx);
    this.node = new AudioWorkletNode(ctx, 'pcm16-capture', {
      processorOptions: { rate: RATE, raw: this.aec !== null },
      numberOfInputs: this.aec ? 2 : 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (e: MessageEvent<CaptureMessage>) => {
      this.heard?.();
      if ('mic' in e.data) {
        if (!this.aec) return;
        const heard = new Float32Array(e.data.mic);
        const played = new Float32Array(e.data.ref);
        const out = this.aec.process(heard, played);
        this.log?.add(heard, played, out, e.data.gaps);
        this.cancelled(out);
        return;
      }
      this.level = this.level * 0.6 + e.data.level * 0.4;
      this.onFrame(new Int16Array(e.data.pcm));
    };
    // A worklet only runs while connected to the destination; route it through a muted gain.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
    this.reference?.connect(this.node, 0, 1);
    await this.firstFrame(ctx);
  }

  /** The canceller's output, in 40 ms frames of PCM16 like the worklet's own. */
  private cancelled(out: Float32Array) {
    const all = new Float32Array(this.pending.length + out.length);
    all.set(this.pending);
    all.set(out, this.pending.length);
    const size = Math.round(RATE * 0.04);
    let at = 0;
    for (; at + size <= all.length; at += size) {
      const frame = new Int16Array(size);
      let peak = 0;
      for (let i = 0; i < size; i++) {
        const v = Math.max(-1, Math.min(1, all[at + i]));
        frame[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        peak = Math.max(peak, Math.abs(v));
      }
      this.level = this.level * 0.6 + peak * 0.4;
      this.onFrame(frame);
    }
    this.pending = all.slice(at);
  }

  /**
   * Frames come every 40 ms once audio flows, sound or silence. None means the audio graph isn't
   * running (a context the browser kept suspended): wake it once, then give up with a message that
   * says so, rather than a call that never hears anything.
   */
  private async firstFrame(ctx: AudioContext) {
    const wait = () => new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { this.heard = null; resolve(false); }, FIRST_FRAME_MS);
      this.heard = () => { clearTimeout(t); this.heard = null; resolve(true); };
    });
    if (await wait()) return;
    await ctx.resume().catch(() => {});
    if (await wait()) return;
    throw new Error('No sound is coming from your microphone. Check that it’s connected and allowed for this site, then try again.');
  }

  set muted(m: boolean) {
    for (const t of this.stream.getAudioTracks()) t.enabled = !m;
    if (m) this.level = 0;
  }

  stop() {
    try { this.source?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch { /* already gone */ }
    try { if (this.node) this.reference?.disconnect(this.node); } catch { /* not connected */ }
    if (this.node) this.node.port.onmessage = null;
    for (const t of this.stream.getTracks()) t.stop();
    void this.own?.close().catch(() => {});
    this.aec?.free();
    this.source = this.node = this.sink = this.own = this.reference = null;
    this.heard = null;
  }
}

/** Lead-in when playback starts fresh, which absorbs network jitter. The relay mirrors it (PLAYER_LEAD_MS). */
const LEAD = 0.06;
/** A pause fades out over this long, and playing on fades back in, so neither clicks. */
const FADE = 0.03;

/** A chunk on the context's clock. `at` is when its first sample plays, or would have, had it played from the start. */
interface Scheduled { buf: AudioBuffer; src: AudioBufferSourceNode; at: number }

/**
 * Gapless queue of PCM16 chunks (e.g. realtime `response.output_audio.delta`). It can pause and keep
 * what it hasn't played, then play on from the same point or drop it: a call pauses the bot while the
 * user may be talking over it, and the relay says which it was.
 */
export class PcmPlayer {
  private out: GainNode;
  private analyser: AnalyserNode;
  /** The gain the chunks play through. A pause fades it out and a new one takes over. */
  private seg: GainNode;
  private queue: Scheduled[] = [];
  /** While paused: what is left to play, the first chunk from `offset` seconds in. */
  private held: { buf: AudioBuffer; offset: number }[] | null = null;
  private nextTime = 0;
  private idleWaiters: (() => void)[] = [];
  private levelBuf: Float32Array<ArrayBuffer>;
  onIdle: (() => void) | null = null;
  onStart: (() => void) | null = null;

  constructor(private ctx: AudioContext, dest: AudioNode = ctx.destination) {
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    // About one 40 ms microphone frame of output at 48 kHz, for the echo gate.
    this.analyser.fftSize = 2048;
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.out.connect(this.analyser).connect(dest);
    this.seg = this.segment();
  }

  private segment(): GainNode {
    const g = this.ctx.createGain();
    g.connect(this.out);
    return g;
  }

  get playing() { return this.queue.length > 0; }
  /** Paused with audio still to play. */
  get holding() { return !!this.held?.length; }

  push(pcm: Int16Array, rate = RATE) {
    if (!pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    if (this.held) this.held.push({ buf, offset: 0 });
    else this.schedule(buf, 0);
  }

  private schedule(buf: AudioBuffer, offset: number) {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.seg);
    const now = this.ctx.currentTime;
    const wasIdle = !this.queue.length;
    const at = this.nextTime > now ? this.nextTime : now + LEAD;
    src.start(at, offset);
    this.nextTime = at + buf.duration - offset;
    const entry: Scheduled = { buf, src, at: at - offset };
    this.queue.push(entry);
    src.onended = () => {
      const i = this.queue.indexOf(entry);
      if (i >= 0) this.queue.splice(i, 1);
      if (!this.queue.length) this.settle();
    };
    if (wasIdle) this.onStart?.();
  }

  /** Stop playing, keeping the rest. Chunks pushed meanwhile wait behind it for resume() or clear(). */
  pause() {
    if (this.held) return;
    const now = this.ctx.currentTime;
    // The fade's few milliseconds are played again on resume.
    this.held = this.queue.filter((e) => e.at + e.buf.duration > now).map((e) => ({ buf: e.buf, offset: Math.max(0, now - e.at) }));
    const had = this.queue.length > 0;
    for (const e of this.queue) { e.src.onended = null; try { e.src.stop(now + FADE); } catch { /* not started */ } }
    this.queue = [];
    this.nextTime = 0;
    if (!had) return;
    const old = this.seg;
    old.gain.setValueAtTime(1, now);
    old.gain.linearRampToValueAtTime(0, now + FADE);
    setTimeout(() => { try { old.disconnect(); } catch { /* gone */ } }, (FADE * 1000) + 100);
    this.seg = this.segment();
    this.onIdle?.();
  }

  /** Play on from where pause() stopped. */
  resume() {
    const held = this.held;
    this.held = null;
    if (!held) return;
    if (!held.length) {
      if (!this.queue.length) this.settle();
      return;
    }
    const at = this.ctx.currentTime + LEAD;
    this.seg.gain.setValueAtTime(0, at);
    this.seg.gain.linearRampToValueAtTime(1, at + FADE);
    for (const h of held) this.schedule(h.buf, h.offset);
  }

  /** Drop everything queued or held (the user talked over it). */
  clear() {
    const had = this.queue.length > 0 || this.held !== null;
    for (const e of this.queue) { e.src.onended = null; try { e.src.stop(); } catch { /* not started */ } }
    this.queue = [];
    this.held = null;
    this.nextTime = 0;
    if (had) this.settle();
  }

  /**
   * Resolves once everything queued has played. Speech arrives far faster than it plays, so a long
   * reply can be queued in full; the safety timeout covers all of it plus `graceMs`, never less.
   */
  whenIdle(graceMs = 2000): Promise<void> {
    if (!this.queue.length && !this.holding) return Promise.resolve();
    const heldMs = (this.held ?? []).reduce((s, h) => s + h.buf.duration - h.offset, 0) * 1000;
    const queuedMs = Math.max(0, this.nextTime - this.ctx.currentTime) * 1000 + heldMs;
    return new Promise((resolve) => {
      const t = setTimeout(resolve, queuedMs + graceMs);
      this.idleWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  /** RMS of what is going to the speakers now, full scale 1 (the echo gate's reference). */
  outputLevel(): number {
    if (!this.queue.length) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    return Math.sqrt(sum / this.levelBuf.length);
  }

  /** Output level 0..1 for the speaking animation. */
  level(): number {
    return Math.min(1, this.outputLevel() * 4);
  }

  private settle() {
    this.onIdle?.();
    const w = this.idleWaiters.splice(0);
    for (const f of w) f();
  }

  dispose() {
    this.clear();
    try { this.seg.disconnect(); this.out.disconnect(); this.analyser.disconnect(); } catch { /* ignore */ }
  }
}

// ---------- the call's speaker ----------

/** How long the page's own WebRTC connection may take to come up before the call plays straight from the context. */
const LOOPBACK_MS = 3000;

/**
 * Where a call's sound goes to the speakers. A browser's echo canceller subtracts only the audio it
 * knows is the far end of a call, a WebRTC track; what an AudioContext plays reaches the microphone
 * untouched (measured at -10 dB in Firefox and Safari with desk speakers), and the speech service
 * heard the bot's own voice as the user talking over it. So the call's sound goes through a pair of
 * peer connections inside the page and plays from an audio element, as a video call's does. Until
 * they connect, or if they can't, it plays straight from the context.
 */
export class CallOutput {
  /** Connect the call's sound here. */
  readonly bus: GainNode;
  route: 'webrtc' | 'direct' = 'direct';
  private dest: MediaStreamAudioDestinationNode | null = null;
  private pcs: RTCPeerConnection[] = [];
  private el: HTMLAudioElement | null = null;
  private closed = false;

  constructor(private ctx: AudioContext) {
    this.bus = ctx.createGain();
    this.bus.connect(ctx.destination);
  }

  /** Moves the sound onto the page's WebRTC connection. Resolves either way; `route` says which it plays through. */
  async start(): Promise<void> {
    if (this.route === 'webrtc' || typeof RTCPeerConnection === 'undefined' || typeof this.ctx.createMediaStreamDestination !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const track = await Promise.race([
        this.connect(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), LOOPBACK_MS); }),
      ]);
      if (this.closed) return;
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = new MediaStream([track]);
      await el.play();
      if (this.closed) { el.pause(); el.srcObject = null; return; }
      this.el = el;
      this.bus.disconnect();
      this.bus.connect(this.dest!);
      this.route = 'webrtc';
      const recv = this.pcs[1];
      recv.oniceconnectionstatechange = () => {
        if (this.route !== 'webrtc' || (recv.iceConnectionState !== 'failed' && recv.iceConnectionState !== 'closed')) return;
        console.warn('[voice] the page’s WebRTC connection dropped; playing straight from the AudioContext');
        this.playDirect();
      };
    } catch (e) {
      console.warn('[voice] playing straight from the AudioContext; the page’s WebRTC connection failed:', e);
      this.closePeers();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Two peer connections in this page, one sending the call's sound to the other. Resolves with the received track once they connect. */
  private async connect(): Promise<MediaStreamTrack> {
    this.dest = this.ctx.createMediaStreamDestination();
    const send = new RTCPeerConnection();
    const recv = new RTCPeerConnection();
    this.pcs = [send, recv];
    send.onicecandidate = (e) => { if (e.candidate) void recv.addIceCandidate(e.candidate).catch(() => {}); };
    recv.onicecandidate = (e) => { if (e.candidate) void send.addIceCandidate(e.candidate).catch(() => {}); };
    send.addTrack(this.dest.stream.getAudioTracks()[0], this.dest.stream);
    const received = new Promise<RTCTrackEvent>((resolve) => { recv.ontrack = resolve; });
    const connected = new Promise<void>((resolve, reject) => {
      recv.oniceconnectionstatechange = () => {
        const s = recv.iceConnectionState;
        if (s === 'connected' || s === 'completed') resolve();
        else if (s === 'failed' || s === 'closed') reject(new Error(`ICE ${s}`));
      };
    });
    const offer = await send.createOffer();
    await send.setLocalDescription(offer);
    await recv.setRemoteDescription(offer);
    const answer = await recv.createAnswer();
    await recv.setLocalDescription(answer);
    await send.setRemoteDescription(answer);
    const ev = await received;
    // Nothing to smooth over between two connections in one page: play as soon as it arrives.
    try { (ev.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 0; } catch { /* not supported */ }
    await connected;
    return ev.track;
  }

  /** Plays straight from the context again: the connection broke, or the call's own canceller took over (the Speaker button). */
  playDirect() {
    if (this.closed || this.route === 'direct') return;
    this.route = 'direct';
    this.bus.disconnect();
    this.bus.connect(this.ctx.destination);
    if (this.el) { this.el.pause(); this.el.srcObject = null; this.el = null; }
    this.closePeers();
  }

  private closePeers() {
    for (const pc of this.pcs) { try { pc.close(); } catch { /* closed */ } }
    this.pcs = [];
  }

  dispose() {
    this.closed = true;
    if (this.el) { this.el.pause(); this.el.srcObject = null; this.el = null; }
    this.closePeers();
    try { this.bus.disconnect(); } catch { /* gone */ }
  }
}

// ---------- the thinking loop ----------

/**
 * Three soft, even blips in quick succession, then a rest, like a typing indicator. Quiet enough to
 * sit under a call. The blips are staccato, so the loop starts at full level; only stopping fades.
 */
const LOOP = {
  cycle: 1.3, gain: 0.06, fadeIn: 0.01, fadeOut: 0.12,
  hz: 698.46, attack: 0.003, decay: 0.028, length: 0.12,
  blips: [{ at: 0, level: 1 }, { at: 0.15, level: 0.85 }, { at: 0.3, level: 0.7 }],
};

/** The loop's samples, made once per sample rate: short sine blips with a touch of third harmonic. */
function loopBuffer(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(LOOP.cycle * rate), rate);
  const ch = buf.getChannelData(0);
  for (const b of LOOP.blips) {
    const start = Math.round(b.at * rate);
    for (let i = 0; i < Math.round(LOOP.length * rate) && start + i < ch.length; i++) {
      const t = i / rate;
      const env = Math.min(1, t / LOOP.attack) * Math.exp(-t / LOOP.decay);
      ch[start + i] += b.level * env * (Math.sin(2 * Math.PI * LOOP.hz * t) + 0.12 * Math.sin(6 * Math.PI * LOOP.hz * t));
    }
  }
  return buf;
}

/** A quiet loop that says "still thinking" while the bot works on a reply. Fades in and out. */
export class ThinkingLoop {
  private out: GainNode;
  private src: AudioBufferSourceNode | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private buf: AudioBuffer | null = null;

  constructor(private ctx: AudioContext, dest: AudioNode = ctx.destination) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
  }

  get on() { return this.src !== null && this.stopTimer === null; }

  start() {
    if (this.on) return;
    const now = this.ctx.currentTime;
    if (this.stopTimer) {
      // Fading out: fade back in on the same source.
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    } else {
      this.buf ??= loopBuffer(this.ctx);
      this.src = this.ctx.createBufferSource();
      this.src.buffer = this.buf;
      this.src.loop = true;
      this.src.connect(this.out);
      this.src.start(now);
    }
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(LOOP.gain, now + LOOP.fadeIn);
  }

  stop() {
    if (!this.src || this.stopTimer) return;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + LOOP.fadeOut);
    const src = this.src;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.src !== src) return;
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
      this.src = null;
    }, LOOP.fadeOut * 1000 + 30);
  }

  dispose() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    try { this.src?.stop(); this.src?.disconnect(); this.out.disconnect(); } catch { /* gone */ }
    this.src = null;
  }
}

// ---------- base64 <-> PCM16 ----------

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function base64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length & ~1;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
