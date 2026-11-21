// The messages of a voice call, declared once (the web app imports this file as @shared/voice-protocol).
//
//   browser (web/src/voice/call.ts) ◄──ClientEvent / RelayEvent──► relay (voice-relay.ts) ◄──SpeechEvent── speech service
//
// Browser and relay speak a subset of the OpenAI Realtime protocol (so names follow it), plus three
// events of Dispatch's own: `dispatch.activity`, `dispatch.playback` and `dispatch.hangup`. Microphone audio also goes up as binary
// PCM16 frames. The speech service's events are documented in speech/README.md and sent by
// speech/app/listen.py and main.py; SpeechEvent mirrors them.

/** Browser → relay. */
export type ClientEvent =
  /** Microphone audio, base64 PCM16 mono at the session's sample rate. */
  | { type: 'input_audio_buffer.append'; audio: string }
  /** The microphone was muted: drop what the user was saying. */
  | { type: 'input_audio_buffer.clear' }
  /** The call connected: the bot answers it with a greeting. */
  | { type: 'response.create' }
  /** Stop the reply (and its speech). */
  | { type: 'response.cancel'; response_id?: string }
  /** Accepted and ignored: the call's settings come from POST /api/voice/session. */
  | { type: 'session.update' };

export interface RealtimeError { type: 'invalid_request_error' | 'server_error'; code: string; message: string }

/** One reply as the relay reports it: a turn of the bot's agent, or the greeting. */
export interface RealtimeResponse {
  id: string;
  object: 'realtime.response';
  status: 'in_progress' | 'completed' | 'cancelled';
  status_details?: { type: 'cancelled'; reason: string };
  output: { id: string; type: 'message'; role: 'assistant'; status: 'completed' | 'incomplete'; content: { type: 'output_audio'; transcript: string }[] }[];
}

/** Relay → browser. Item ids: `<callId>_u<n>` for what the user said, the reply's own for the bot's words. */
export type RelayEvent =
  /** The speech service is listening; the browser sends `response.create`. */
  | { type: 'session.created'; session: { id: string; model: string; voice: string; speed: number; sample_rate: number } }
  /** The user started talking: the browser pauses the bot's speech until `dispatch.playback` says what became of it. */
  | { type: 'input_audio_buffer.speech_started'; item_id: string; audio_start_ms: number; audio_ms: number }
  | { type: 'input_audio_buffer.speech_stopped'; item_id: string; audio_end_ms: number; audio_ms: number }
  /** What the user has said so far, whole each time. */
  | { type: 'conversation.item.input_audio_transcription.updated'; item_id: string; transcript: string }
  | { type: 'conversation.item.input_audio_transcription.completed'; item_id: string; transcript: string }
  /** What the user said was dropped (muted, or too short to be speech). */
  | { type: 'conversation.item.deleted'; item_id: string }
  | { type: 'response.created'; response: RealtimeResponse }
  | { type: 'response.output_item.added'; response_id: string; output_index: number; item: { id: string; object: 'realtime.item'; type: 'message'; role: 'assistant'; status: 'in_progress'; content: [] } }
  | { type: 'response.output_audio_transcript.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.output_audio_transcript.done'; response_id: string; item_id: string; transcript: string }
  /** The bot's speech, base64 PCM16 mono at the session's sample rate. */
  | { type: 'response.output_audio.delta'; response_id: string; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.done'; response: RealtimeResponse }
  /** What the bot is doing while a tool runs, for the call bar. */
  | { type: 'dispatch.activity'; response_id: string; label: string }
  /**
   * Sent once for each `speech_started`, after its final transcript: `resume` when what paused the bot
   * had no words in it (play on from where it paused), `stop` when the user talked over it (drop what
   * is queued, and any late audio of that item).
   */
  | { type: 'dispatch.playback'; action: 'resume' | 'stop' }
  /** The bot called end_call: hang up once its last words have played. */
  | { type: 'dispatch.hangup'; response_id: string }
  | { type: 'error'; error: RealtimeError };

/** Speech service → relay, on its live recognition socket. `utterance` numbers what the user said. */
export type SpeechEvent =
  | { type: 'ready'; model?: string; sample_rate?: number }
  | { type: 'speech_started'; utterance: number; start_ms: number; audio_ms: number }
  | { type: 'partial'; utterance: number; text: string }
  | { type: 'speech_stopped'; utterance: number; end_ms: number; audio_ms: number; forced?: boolean }
  | { type: 'final'; utterance: number; text: string; model?: string }
  | { type: 'speech_dropped'; utterance: number }
  | { type: 'error'; message: string };
