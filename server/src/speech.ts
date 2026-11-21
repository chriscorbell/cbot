// The speech service (speech/README.md): its voices (Phonon's) and text-to-speech, dictation, and
// the address of its live recognition socket for calls. It runs beside Dispatch in a container on an internal network.
import { env } from './env.js';
import type { VoiceOption } from './types.js';

/** Audio both ways is PCM16 mono at this rate: the browser's capture, the recognizer's input, text-to-speech output. */
export const SAMPLE_RATE = 24000;

export interface VoiceCatalog { defaultVoice: string; speed: { min: number; max: number }; voices: VoiceOption[] }

/** New bots get one of these, picked by id: clear, even Phonon voices that hold up on a call. */
export const NEW_BOT_VOICES = ['harper', 'preston', 'hadley', 'edwin', 'maeve', 'trevor'];

// What /v1/voices reports today, for mapping stored speeds before the service has answered.
const SPEED_RANGE = { min: 0.86, max: 1.27 };

let catalog: { at: number; value: VoiceCatalog } | null = null;
let loading: Promise<VoiceCatalog> | null = null;

/** The speech service's voices, its default voice and its speed range, cached for an hour. Throws when the service is down. */
export function voiceCatalog(): Promise<VoiceCatalog> {
  if (catalog && Date.now() - catalog.at < 3600_000) return Promise.resolve(catalog.value);
  loading ??= (async () => {
    const r = await fetch(`${env.speechUrl}/v1/voices`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`speech service: HTTP ${r.status}`);
    const j = (await r.json()) as {
      default: string; speed: { min: number; max: number };
      voices: { id: string; name: string; gender: string | null; locale: string | null; character: boolean; description: string }[];
    };
    const voices: VoiceOption[] = j.voices.map((v) => ({
      id: v.id, name: v.name, gender: v.gender ?? undefined, description: v.description,
      group: v.character ? 'Characters' : v.locale === 'en-gb' ? 'British' : v.locale === 'en-ie' ? 'Irish' : 'American',
    }));
    const value = { defaultVoice: j.default, speed: { min: j.speed.min, max: j.speed.max }, voices };
    catalog = { at: Date.now(), value };
    return value;
  })().finally(() => { loading = null; });
  return loading;
}

/** Load the catalog once the service is up (it takes a while to load its models), so stored settings map from the start. */
export function initSpeech() {
  let tries = 0;
  const attempt = () => voiceCatalog()
    .then((c) => console.log(`[speech] ${c.voices.length} voices at ${env.speechUrl}`))
    .catch((e) => {
      if (++tries === 1) console.warn(`[speech] not answering yet at ${env.speechUrl}: ${e?.message ?? e}`);
      if (tries < 60) setTimeout(attempt, 5000).unref();
    });
  void attempt();
}

/**
 * A voice as the speech service can use it: one the service doesn't list reads as its default. Before
 * the catalog has loaded, any name passes through.
 */
export function mapVoice(stored: unknown, c: VoiceCatalog | null = catalog?.value ?? null): string {
  const id = typeof stored === 'string' ? stored : '';
  if (!c) return id || NEW_BOT_VOICES[0];
  return c.voices.some((v) => v.id === id) ? id : c.defaultVoice;
}

/** A stored speed clamped to the speech service's range (older settings went from 0.7 to 1.5). */
export function mapSpeed(stored: unknown, c: VoiceCatalog | null = catalog?.value ?? null): number {
  const n = Number(stored);
  const { min, max } = c?.speed ?? SPEED_RANGE;
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 100) / 100 : 1;
}

/** Speech for `text` as streamed PCM (or a whole WAV file). Abort `signal` to stop the generation. */
export function speak(text: string, voice: string, speed: number, signal: AbortSignal, format: 'pcm' | 'wav' = 'pcm'): Promise<Response> {
  return fetch(`${env.speechUrl}/v1/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed, format }),
    signal,
  });
}

/** The transcript of a whole clip in any format FFmpeg decodes (dictation). */
export async function transcribe(file: Blob, name: string): Promise<string> {
  const form = new FormData();
  form.append('file', file, name);
  const r = await fetch(`${env.speechUrl}/v1/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`speech service: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return String(((await r.json()) as { text?: string }).text ?? '').trim();
}

/** The live recognition socket for a call: VAD events, partials and a final transcript per utterance. */
export function listenUrl(params: Record<string, string | number> = {}): string {
  const q = new URLSearchParams({ sample_rate: String(SAMPLE_RATE), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return `${env.speechUrl.replace(/^http/, 'ws')}/v1/transcribe/stream?${q}`;
}
