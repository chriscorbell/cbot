// A voice call's echo, second by second, for the server's log (VoiceEcho.seconds): when the bot's
// voice gets past AEC3 (aec.ts), the log shows whether the room got louder, the echo's delay moved or
// the microphone dropped audio, which a call's averages can't tell apart.
import type { EchoSecond } from '@shared/contract';

/** Below this (dBFS) the call plays nothing worth measuring by, as in aec.ts. */
const AUDIBLE = -50;
/** The echo's delay is looked for up to this late, in ms, over the last second (1 ms envelope points). */
const MAX_DELAY = 500;
const WINDOW = 1000;
/** Seconds kept for the call's log: the last 15 minutes the bot was audible. */
const KEEP = 900;
/** dBFS for silence. */
const FLOOR = -120;

/** The call second by second while the bot was audible, and the second after. */
export class EchoLog {
  readonly seconds: EchoSecond[] = [];
  private second = 0;
  private n = 0;
  private played = 0;
  private heard = 0;
  private cancelled = 0;
  private cancelledN = 0;
  private gaps = 0;
  private wasAudible = false;
  /** Samples per envelope point (1 ms), and the envelopes of what played and what the microphone heard. */
  private step: number;
  private acc = { n: 0, ref: 0, mic: 0 };
  private refEnv: number[] = [];
  private micEnv: number[] = [];

  constructor(private rate: number, private outputLatency: () => number | null) {
    this.step = Math.max(1, Math.round(rate / 1000));
  }

  /** One block: what the microphone heard, what played, AEC3's output, and render quanta the microphone missed. */
  add(heard: Float32Array, played: Float32Array, cancelled: Float32Array, gaps: number) {
    this.gaps += gaps;
    this.cancelled += energy(cancelled);
    this.cancelledN += cancelled.length;
    for (let i = 0; i < heard.length; i++) {
      const h = heard[i];
      const p = played[i];
      this.heard += h * h;
      this.played += p * p;
      this.acc.mic += Math.abs(h);
      this.acc.ref += Math.abs(p);
      if (++this.acc.n === this.step) {
        this.micEnv.push(this.acc.mic);
        this.refEnv.push(this.acc.ref);
        this.acc = { n: 0, ref: 0, mic: 0 };
      }
      if (++this.n === this.rate) this.close();
    }
  }

  private close() {
    const played = dbfs(this.played, this.n);
    const audible = played >= AUDIBLE;
    // The second after the bot stops is kept too: its voice is still reaching the microphone.
    if (audible || this.wasAudible || this.gaps) {
      this.seconds.push([this.second, played, dbfs(this.heard, this.n), dbfs(this.cancelled, this.cancelledN), audible ? this.delay() : null, this.gaps, this.outputLatency()]);
      if (this.seconds.length > KEEP) this.seconds.shift();
    }
    this.wasAudible = audible;
    this.second++;
    this.n = this.played = this.heard = this.cancelled = this.cancelledN = this.gaps = 0;
    this.refEnv.splice(0, Math.max(0, this.refEnv.length - WINDOW - MAX_DELAY));
    this.micEnv.splice(0, Math.max(0, this.micEnv.length - WINDOW));
  }

  /**
   * How late what played reached the microphone, in ms: the lag at which the microphone's envelope
   * over the last second best matches what played, if it matches well enough to tell.
   */
  private delay(): number | null {
    const mic = this.micEnv.slice(-WINDOW);
    const ref = this.refEnv;
    const n = mic.length;
    if (n < WINDOW / 2) return null;
    let sx = 0;
    let sxx = 0;
    for (const x of mic) { sx += x; sxx += x * x; }
    const vx = sxx - (sx * sx) / n;
    let best = { lag: -1, r: 0.3 };
    for (let lag = 0; lag <= MAX_DELAY; lag++) {
      // mic[i] heard what played `lag` ms before it: ref[at + i].
      const at = ref.length - n - lag;
      if (at < 0) break;
      let sy = 0;
      let syy = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        const y = ref[at + i];
        sy += y;
        syy += y * y;
        sxy += mic[i] * y;
      }
      const vy = syy - (sy * sy) / n;
      const r = vx > 0 && vy > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : 0;
      if (r > best.r) best = { lag, r };
    }
    return best.lag < 0 ? null : best.lag;
  }
}

const dbfs = (e: number, n: number) => (n && e > 0 ? Math.max(FLOOR, Math.round(10 * Math.log10(e / n))) : FLOOR);

function energy(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}
