// Echo cancellation in the page, with WebRTC's AEC3 (the canceller inside Chrome) compiled to
// WebAssembly (@ennuicastr/webrtcaec3.js).
//
// A browser's own canceller decides for itself what to subtract from the microphone, and with desk
// speakers the bot's voice still reached it at -8 to -12 dB in Safari and Firefox, whether the bot
// played from an AudioContext or through WebRTC; the speech service heard it as the user talking
// over the bot. Here the canceller is given exactly what the call plays, sample for sample on the
// same clock as the microphone, as a native call app does, and the browser's is turned off.
import type WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { RATE } from './audio';

type Aec3Module = WebRtcAec3.WebRtcAec3;

let loading: Promise<Aec3Module> | null = null;

/** Loads AEC3 once per page (a 250 KB script with its WebAssembly inside). Rejects where it can't run. */
export function loadAec3(): Promise<Aec3Module> {
  loading ??= (async () => {
    // The script keeps its WebAssembly, as a data URL, in a global it assigns without declaring,
    // which a module's strict mode refuses unless the global already exists.
    (globalThis as { WebRtcAec3Wasm?: string }).WebRtcAec3Wasm ??= '';
    const { default: factory } = await import('@ennuicastr/webrtcaec3.js');
    return factory();
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Below this level (RMS, full scale 1) the call plays nothing worth measuring the canceller by. */
const AUDIBLE = 0.003;

/**
 * Cancels the call's own sound from the microphone. Takes both at the context's rate and gives the
 * microphone back at 24 kHz, about 10 ms later (AEC3 works in 10 ms blocks).
 */
export class EchoCanceller {
  private aec: WebRtcAec3.AEC3;
  private opts: { sampleRateIn: number; sampleRateOut: number };
  /** For the call's log: dB taken off each block while the call played, the last minute's worth. */
  private removed: number[] = [];

  constructor(mod: Aec3Module, rate: number) {
    // AEC3 runs at 48 kHz (it supports few rates) and resamples what it is given.
    this.aec = new mod.AEC3(48000, 1, 1);
    this.opts = { sampleRateIn: rate, sampleRateOut: RATE };
  }

  /** One block of what the speakers played (`played`) and what the microphone heard, the same length. */
  process(heard: Float32Array, played: Float32Array): Float32Array {
    this.aec.analyze([played], { sampleRateIn: this.opts.sampleRateIn });
    const n = this.aec.processSize([heard], this.opts);
    const out = new Float32Array(n);
    if (n) this.aec.process([out], [heard], this.opts);
    if (n && level(played) >= AUDIBLE) {
      const inE = energy(heard) / heard.length;
      if (inE > 0) this.removed.push(10 * Math.log10(inE / Math.max(energy(out) / n, 1e-12)));
      if (this.removed.length > 1500) this.removed.shift();
    }
    return out;
  }

  /**
   * How much quieter the microphone was after cancelling while the call played, in dB: the median
   * block, so the user talking over the bot for a moment (which it keeps) doesn't count against it.
   * Null before the call has played anything.
   */
  removedDb(): number | null {
    if (!this.removed.length) return null;
    const sorted = [...this.removed].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  free() {
    this.aec.free();
  }
}

function energy(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}

const level = (a: Float32Array) => (a.length ? Math.sqrt(energy(a) / a.length) : 0);
