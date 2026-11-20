import type { Transcription, VoiceEcho, VoiceEnded, VoiceOptions, VoiceSession } from '@shared/contract';
import { binary, request, upload } from '../lib/http';

export type { VoiceOptions, VoiceSession } from '@shared/contract';

let optionsPromise: Promise<VoiceOptions> | null = null;

export const voiceApi = {
  options: () => (optionsPromise ??= request<VoiceOptions>('GET', '/voice/options').catch((e) => { optionsPromise = null; throw e; })),
  session: (botId: string) => request<VoiceSession>('POST', '/voice/session', { botId }),
  end: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string, echo?: VoiceEcho) => request<VoiceEnded>('POST', '/voice/end', { botId, callId, transcript, error, echo }),
  /** Best-effort end on tab close. */
  endBeacon: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], echo?: VoiceEcho) => {
    try { navigator.sendBeacon('/api/voice/end', new Blob([JSON.stringify({ botId, callId, transcript, echo })], { type: 'application/json' })); } catch { /* ignore */ }
  },
  /** PCM16 mono at 24 kHz. */
  async preview(p: { botId: string; voice?: string; speed?: number; text?: string }, signal?: AbortSignal): Promise<Int16Array> {
    const buf = await binary('POST', '/voice/preview', p, signal).catch(() => { throw new Error('Preview unavailable'); });
    return new Int16Array(buf, 0, buf.byteLength >> 1);
  },
  async transcribe(blob: Blob): Promise<string> {
    const fd = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', blob, `dictation.${ext}`);
    return (await upload<Transcription>('/voice/stt', fd).catch((e: Error) => { throw new Error(e.message || 'Transcription failed'); })).text;
  },
};
