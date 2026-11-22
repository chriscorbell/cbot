import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import type { Bot } from '@shared/types';
import { Check, Play, Square } from 'lucide-react';
import { useStore } from '../store';
import { configApi } from '../lib/configApi';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { callLevels, previewVoice, switchMic } from '../voice/call';
import { micErrorMessage } from '../voice/audio';
import { useMics } from '../voice/mics';
import { useConfigUI } from '../configStore';
import { Select } from './Select';
import { Icon } from './Icon';
import { Presence, useExiting } from './Presence';

// Until the speech service's list arrives the picker shows only the bot's own voice.
const FALLBACK: VoiceOptions = { voices: [], speeds: [0.9, 1, 1.1, 1.2, 1.25] };

const voiceName = (id: string) => id.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;
/** "1.0x", "1.2x": the speed beside a voice's name, always with one decimal. */
const speedTag = (s: number) => `${s.toFixed(Number.isInteger(s * 10) ? 1 : 2)}x`;

/** Two words for each of the speech service's voices, for the picker's cards. */
const TAGLINES: Record<string, string> = {
  zoey: 'Playful & upbeat', juniper: 'Cheerful & personable', everly: 'Soft & relaxed', harper: 'Confident & friendly',
  hadley: 'Even & kind', delia: 'Grounded & sincere', easton: 'Punchy & bright', micah: 'Buoyant & playful',
  trevor: 'Buoyant & warm', russell: 'Energetic & rousing', preston: 'Trim & focused', miles: 'Resonant & decisive',
  maeve: 'Sparky & attentive', freya: 'Glossy & bubbly', pippa: 'Confident & upbeat', 'elodie-rose': 'Sharp & eager',
  imogen: 'Bubbly & friendly', lottie: 'Sparky & direct', alfie: 'Punchy & forward', hugh: 'Soft & sincere',
  edwin: 'Efficient & firm', spencer: 'Light & patient', toby: 'Sparky & cheerful', teddy: 'Quick & firm',
  bryony: 'Rich & relaxed', 'captain-silas-blackwater': 'Gravelly & roguish', 'morwenna-of-the-deep': 'Husky & teasing',
  'old-mortlake': 'Raspy & mournful', azgorath: 'Cavernous & calm', 'fennick-the-young-elf': 'Earnest & curious',
  'the-thing-under-the-stairs': 'Growling & sly', 'vyrmathrax-the-ancient': 'Ancient & dry', 'grub-the-ogre': 'Gruff & good-natured',
  'master-aldric': 'Wise & warm', 'the-snow-queen': 'Cool & regal', 'sir-bramwell': 'Booming & pompous', 'fairy-godmother': 'Velvety & soothing',
};
const tagline = (v: { id: string; description?: string }) => TAGLINES[v.id] ?? v.description?.split(/[.,]/)[0] ?? '';

/** Voices under their group (accent or engine), groups in the order the server lists them. One group gets no heading. */
function voiceGroups<V extends { group?: string }>(voices: V[]): { group: string; list: V[] }[] {
  const out: { group: string; list: V[] }[] = [];
  for (const v of voices) {
    const g = v.group ?? '';
    const last = out.find((x) => x.group === g);
    if (last) last.list.push(v); else out.push({ group: g, list: [v] });
  }
  return out.length > 1 ? out : out.map((x) => ({ ...x, group: '' }));
}

/** The speech service's voices and speeds, fetched once and shared. */
let optionsCache: Promise<VoiceOptions> | null = null;
export function useVoiceOptions(): VoiceOptions {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  useEffect(() => {
    optionsCache ??= voiceApi.options().catch((e) => { optionsCache = null; throw e; });
    let alive = true;
    // Without the speech service the pickers keep FALLBACK, today's voices, so settings still open;
    // the log says why the list may be out of date.
    optionsCache.then((o) => { if (alive) setOpts(o); }).catch((e) => console.warn('[voice] couldn’t load the voices; showing the built-in list:', e));
    return () => { alive = false; };
  }, []);
  return opts;
}

/** Saves a bot's voice or speed, optimistically; the server's `bot` event confirms. Throws on failure after rolling back. */
export async function saveVoice(botId: string, patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed'>>) {
  const prev = useStore.getState().bots.find((b) => b.id === botId);
  useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, ...patch } : b)) }));
  try {
    await configApi.updateBot(botId, patch);
  } catch {
    if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed } : b)) }));
    throw new Error('Couldn’t save that setting.');
  }
}

/** The bot's own voice first if the service doesn't list it, so the picker always shows the current one. */
export function voiceList(opts: VoiceOptions, bot: Bot) {
  return opts.voices.some((v) => v.id === bot.voice) ? opts.voices : [{ id: bot.voice, name: voiceName(bot.voice) }, ...opts.voices];
}
export function speedList(opts: VoiceOptions, bot: Bot) {
  return opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);
}
export { speedLabel };

/** "Harper 1.0x": the voice and speed together, as the panel and the call bar show them. */
export function voiceSummary(opts: VoiceOptions, bot: Bot) {
  const v = opts.voices.find((x) => x.id === bot.voice);
  return `${v?.name ?? voiceName(bot.voice)} ${speedTag(bot.voiceSpeed)}`;
}

/**
 * During a call: which microphone it uses, and a meter of what that microphone hears, so a silent or
 * wrong one shows at once. Picking one saves it (the same setting as Settings → Microphone) and moves
 * the live call to it.
 */
function MicRow() {
  const mics = useMics();
  const micId = useConfigUI((s) => s.micId);
  const [error, setError] = useState<string | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // The worklet reports peaks; a square root makes ordinary speech fill a fair part of the bar.
      meter.current?.style.setProperty('--level', String(Math.min(1, Math.sqrt(callLevels().mic) * 1.4)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const pick = (id: string) => {
    setError(null);
    useConfigUI.getState().setPref({ micId: id });
    switchMic().catch((e) => setError(micErrorMessage(e)));
  };
  return (
    <div className="vcall-settings__mic">
      <div className="vcall-settings__row">
        <span>Microphone</span>
        <Select
          label="Microphone"
          value={mics.some((m) => m.id === micId) ? micId : ''}
          options={[{ value: '', label: 'System Default' }, ...mics.map((m) => ({ value: m.id, label: m.label }))]}
          onChange={pick}
        />
      </div>
      <span className="mic-meter" ref={meter} title="What your microphone hears" aria-hidden><i /></span>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}

/**
 * A popover that closes on a click outside it (except on `keepOpenFor`, the control that toggles it,
 * and a Select's menu) or on Escape. While it animates away it no longer owns either.
 */
function useDismiss(ref: RefObject<HTMLDivElement | null>, onClose: () => void, keepOpenFor?: string) {
  const exiting = useExiting();
  useEffect(() => {
    if (exiting) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || (keepOpenFor && t.closest?.(keepOpenFor)) || t.closest?.('.select-pop')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [ref, onClose, keepOpenFor, exiting]);
  return exiting;
}

/** The speed slider: the speech service's speeds as steps. Saving fails into `onError`. */
function SpeedRow({ bot, onError }: { bot: Bot; onError: (e: string | null) => void }) {
  const speeds = speedList(useVoiceOptions(), bot);
  const speedIndex = Math.max(0, speeds.indexOf(bot.voiceSpeed));
  const speedAt = speeds.length > 1 ? speedIndex / (speeds.length - 1) : 1;
  const save = (voiceSpeed: number) => { onError(null); saveVoice(bot.id, { voiceSpeed }).catch((e) => onError((e as Error).message)); };
  return (
    <div className="vcall-settings__speed">
      <span>Speed</span>
      {/* The input is invisible on top; the fill and its knob are drawn under it so they can glide between steps. */}
      <span className="speed-slider" style={{ ['--at' as string]: speedAt }}>
        <span className="speed-slider__fill" aria-hidden />
        <input
          type="range" min={0} max={Math.max(0, speeds.length - 1)} step={1} value={speedIndex}
          onChange={(e) => save(speeds[Number(e.target.value)])}
          aria-label="Speed" aria-valuetext={speedLabel(bot.voiceSpeed)}
        />
      </span>
      <span className="vcall-settings__value">{speedTag(bot.voiceSpeed)}</span>
    </div>
  );
}

/**
 * Speed and voice for a bot (Model & voice in its settings): a speed slider over a list of voices,
 * each with a play button. Closes like any popover (useDismiss).
 */
export function VoicePicker({ bot, onClose, keepOpenFor, className = '' }: { bot: Bot; onClose: () => void; keepOpenFor?: string; className?: string }) {
  const opts = useVoiceOptions();
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useDismiss(ref, onClose, keepOpenFor);
  // Stops the sample playing now; closing the picker stops it too.
  const stopPreview = useRef<AbortController | null>(null);
  useEffect(() => () => stopPreview.current?.abort(), []);
  const voices = voiceList(opts, bot);
  // Open on the chosen voice.
  useEffect(() => { ref.current?.querySelector('.voice-cell.is-selected')?.scrollIntoView({ block: 'nearest' }); }, []);
  const pick = (voice: string) => { setError(null); saveVoice(bot.id, { voice }).catch((e) => setError((e as Error).message)); };
  // The playing voice's button stops it; another voice's button switches to that one.
  const preview = async (voice: string) => {
    stopPreview.current?.abort();
    stopPreview.current = null;
    if (playing === voice) { setPlaying(null); return; }
    const ac = new AbortController();
    stopPreview.current = ac;
    setPlaying(voice);
    setError(null);
    try { await previewVoice({ botId: bot.id, voice, speed: bot.voiceSpeed }, ac.signal); } catch (e) { setError((e as Error).message || 'Preview unavailable'); } finally {
      if (stopPreview.current === ac) { stopPreview.current = null; setPlaying(null); }
    }
  };
  return (
    <div ref={ref} className={`vcall-settings ${className}${exiting ? ' is-exiting' : ''}`} role="dialog" aria-label="Voice">
      <SpeedRow bot={bot} onError={setError} />
      <div className="vcall-settings__voices" role="radiogroup" aria-label="Voice">
        {voiceGroups(voices).map(({ group, list }) => (
          <Fragment key={group || 'voices'}>
            {group && <div className="voice-group" role="presentation">{group}</div>}
            {list.map((v) => (
              // One line per voice: play on the left, the name, and a check on the chosen one.
              <div key={v.id} className={`voice-cell${bot.voice === v.id ? ' is-selected' : ''}${playing === v.id ? ' is-playing' : ''}`}>
                <button type="button" className="voice-cell__play" onClick={() => preview(v.id)} aria-label={playing === v.id ? `Stop ${v.name}` : `Hear ${v.name}`}>
                  {playing === v.id ? <Square size={9} strokeWidth={0} fill="currentColor" aria-hidden /> : <Play className="voice-cell__tri" size={10} strokeWidth={0} fill="currentColor" aria-hidden />}
                </button>
                <button type="button" role="radio" aria-checked={bot.voice === v.id} className="voice-cell__pick" onClick={() => pick(v.id)} title={v.description}>
                  <span className="voice-cell__text">
                    <span className="voice-cell__name">{v.name}</span>
                    <span className="voice-cell__desc">{tagline(v)}</span>
                  </span>
                  {bot.voice === v.id && <Check className="voice-cell__check" size={15} strokeWidth={2.5} aria-hidden />}
                </button>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}

/**
 * The call bar's settings: the microphone and the speed. The voice itself is chosen in the bot's
 * settings (Model & voice), not mid-call.
 */
export function CallSettings({ bot, onClose, keepOpenFor }: { bot: Bot; onClose: () => void; keepOpenFor?: string }) {
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useDismiss(ref, onClose, keepOpenFor);
  return (
    <div ref={ref} className={`vcall-settings${exiting ? ' is-exiting' : ''}`} role="dialog" aria-label="Call settings">
      <MicRow />
      <SpeedRow bot={bot} onError={setError} />
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}

/** A bot's voice chat settings in the details panel: the voice and speed, picked from a popover. */
export function VoiceSettings({ bot }: { bot: Bot }) {
  const opts = useVoiceOptions();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [bot.id]);
  return (
    <div className="panel-card voice-card">
      <div className="panel-row panel-row--setting">
        <span className="panel-row__title">Voice</span>
        <button type="button" className={`mini-select voice-card__toggle${open ? ' is-open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">
          <span>{voiceSummary(opts, bot)}</span>
          <Icon name="chev_down" size={10} />
        </button>
      </div>
      <Presence show={open} ms={120}>
        <VoicePicker bot={bot} onClose={() => setOpen(false)} keepOpenFor=".voice-card__toggle" className="voice-card__popover" />
      </Presence>
    </div>
  );
}
