// Keeps the bot's own voice, coming back from the speakers, out of what a call sends to the relay.
//
// The browser's echo canceller removes most of it, but with speakers and a microphone in the same
// room some gets through, and the speech service takes it for the user talking over the bot. While
// the bot is audible, a microphone frame goes out only if it is clearly louder than the bot's voice
// usually is at that microphone; silence goes out in its place otherwise. Talking over the bot still
// works, because a voice near the microphone is louder than one from across the desk, and once the
// relay pauses the bot the gate opens. The cost is that a quiet word over the bot may not count.
//
// How loud the bot is at the microphone, as a share of what the player sends to the speakers, is
// learned during the call from every frame while the bot makes sound: the energy at the microphone
// over the energy sent out. A frame counts at most as loud as the gate's limit, so the user talking
// over the bot (until the relay pauses it, a quarter second later) nudges the estimate rather than
// multiplying it.

/** The bot's output level is kept this many 40 ms frames back: its voice reaches the microphone up to this late. */
const WINDOW = 8;
/** Below this output level (RMS, full scale 1) the bot is silent and frames go out as they are. */
const QUIET = 0.003;
/** A frame goes out when it is this many times as loud as the bot's voice at the microphone. */
const MARGIN = 2.5;
/** Once a frame goes out, the gate stays open this many frames, so the user's words aren't cut into pieces. */
const HOLD = 12;
/** The learning averages over about this many frames of the bot's speech (ten seconds). */
const SPAN = 250;
/** For this many frames of the bot's speech in a call (a second), frames are learned from as they are and go out: there is nothing to judge them by yet. */
const SETTLE = 25;

/** RMS of PCM16, full scale 1. */
export function pcmLevel(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return pcm.length ? Math.sqrt(sum / pcm.length) / 0x8000 : 0;
}

export class EchoGate {
  /** How loud the bot's voice is at the microphone, as a share of the player's output level. */
  coupling = 0;
  /** Frames that came in while the bot was audible, and how many of them went out as silence. */
  frames = 0;
  held = 0;
  private outs: number[] = [];
  private open = 0;
  private learned = 0;
  private micEnergy = 0;
  private outEnergy = 0;

  /** One microphone frame, and the player's output level as it came in: what to send. */
  process(pcm: Int16Array, out: number): Int16Array {
    this.outs.push(out);
    if (this.outs.length > WINDOW) this.outs.shift();
    const ref = Math.max(...this.outs);
    if (ref < QUIET) {
      this.open = 0;
      return pcm;
    }
    this.frames++;
    const mic = pcmLevel(pcm);
    const limit = MARGIN * this.coupling * ref;
    if (out >= QUIET) this.learn(this.learned < SETTLE ? mic : Math.min(mic, limit), out);
    if (this.learned <= SETTLE) return pcm;
    if (mic > limit) {
      this.open = HOLD;
      return pcm;
    }
    if (this.open > 0) {
      this.open--;
      return pcm;
    }
    this.held++;
    return new Int16Array(pcm.length);
  }

  /** A running average of both energies: plain at first, then over the last SPAN frames or so. */
  private learn(mic: number, out: number) {
    const rate = Math.max(1 / ++this.learned, 1 / SPAN);
    this.micEnergy += rate * (mic * mic - this.micEnergy);
    this.outEnergy += rate * (out * out - this.outEnergy);
    this.coupling = Math.sqrt(this.micEnergy / this.outEnergy);
  }
}
