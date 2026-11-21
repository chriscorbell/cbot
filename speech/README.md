# Speech service

Local text-to-speech and speech recognition for Dispatch's voice features, English only.

Compose runs it as the `speech` service next to `dispatch`, on an internal network with no route out and no published port. From the `dispatch` container it is `http://speech:8000`, which compose passes to Dispatch as `SPEECH_URL`.

There is no authentication: only Dispatch can reach it. The machine itself can too, and with it the web pages the bots open in Chrome. So a request that carries an `Origin` header is refused with 403 (`app/guard.py`): browsers always send one on a WebSocket handshake and a POST, and Dispatch never does.

| Job | Model | Runtime |
|---|---|---|
| Text-to-speech | Phonon 31M (`phonon-31m-en`, q8) and its 37 English voices | `ptts`, Gradium's Rust runtime, on the CPU |
| Whole clips (dictation) and the final transcript of each utterance in a call | Parakeet Unified EN 0.6B, offline mode (int8 ONNX) | sherpa-onnx |
| Live partial transcripts in a call | Nemotron Speech Streaming EN 0.6B, 160 ms chunks (int8 ONNX) | sherpa-onnx |
| Start and end of speech | Silero VAD v6 | onnxruntime |

The weights are downloaded when the image is built, at the revisions `models.json` pins, and checked against their hashes.

## Audio formats

| Direction | Format |
|---|---|
| Text-to-speech out | Raw PCM, 16-bit signed little-endian, mono, 24 kHz |
| Streaming recognition in | Raw PCM, 16-bit signed little-endian, mono, at the `sample_rate` the socket was opened with (24 kHz by default, anything from 8 to 48 kHz) |
| Whole clips in | Anything FFmpeg decodes: WebM/Opus and Ogg/Opus from MediaRecorder in Chrome and Firefox, MP4/AAC from Safari, WAV, MP3, FLAC |

The recognizers work at 16 kHz mono; the service resamples everything else.

## `GET /health`

`200` once every model is loaded. Until then the port is closed. The image's healthcheck calls it.

```json
{
  "status": "ok",
  "tts": { "model": "phonon-31m-en", "sampleRate": 24000, "voices": 37 },
  "asr": {
    "offline": "parakeet-unified-en-0.6b",
    "stream": "nemotron-speech-streaming-en-0.6b-160ms",
    "streamModels": ["nemotron-speech-streaming-en-0.6b-160ms"]
  },
  "threads": { "tts": 4, "asr": 4, "stream": 4 }
}
```

## `GET /v1/voices`

The voices for the voice picker, the default, and the speed range.

```json
{
  "default": "harper",
  "sampleRate": 24000,
  "speed": { "min": 0.86, "max": 1.27, "default": 1.0 },
  "voices": [
    {
      "id": "zoey", "name": "Zoey", "gender": "female", "locale": "en-us", "age": "Adult",
      "character": false, "description": "Playful, upbeat and Gen Z energy voice with a standard American accent. Perfect for engaging conversations!",
      "catalogId": "NbpkqMVS3CJeq2j8"
    }
  ]
}
```

`id` is what `/v1/tts` takes: the name in lower case with spaces turned into hyphens. `gender` is `"female"` or `"male"` for the 25 regular voices (13 female, 12 male; `locale` `en-us` or `en-gb`) and `null` for the 12 character voices (`character: true`, `locale: null`), whose `description` says who they are. `catalogId` is the voice's id in Gradium's catalog. The list keeps the catalog's order: US voices, then UK voices, then the characters.

## `POST /v1/tts`

Speech for a piece of text, streamed as it is generated.

Request body, JSON:

| Field | Type | Default | |
|---|---|---|---|
| `text` | string, 1 to 4000 characters | required | Phonon spells out numbers, amounts, dates, times, emails and URLs. Its normalizer drops em and en dashes, so `app/text.py` turns them into the pauses they mark first: a comma between words, a full stop at the end, a hyphen in a range ("3–5"). Long text is split into sentences and spoken one after another in the same stream. |
| `voice` | string | `/v1/voices`' `default` | An `id` from `/v1/voices` |
| `speed` | number | `1` | Speaking rate. Phonon's range is narrow: values are clamped to 0.86 to 1.27 (`/v1/voices` reports it) |
| `format` | `"pcm"` or `"wav"` | `"pcm"` | `pcm` streams; `wav` returns the whole file once it is done |

Response for `pcm`: `200` with `Content-Type: audio/pcm;rate=24000;channels=1` and a chunked body of raw PCM (see Audio formats). Headers `X-Sample-Rate`, `X-Voice` and `X-Speed` give the rate, voice and clamped speed used.

- The headers come back at once. The first chunk is about 80 ms of audio and follows 15 to 50 ms after the request; later chunks grow to about a second.
- Chunk boundaries are arbitrary and can split a sample, so keep an odd trailing byte for the next chunk.
- The body ends when the speech does. Closing the connection early (`AbortController` with fetch) stops the generation, which is how a call cuts the bot off when the user talks over it.

Response for `wav`: `200` with `Content-Type: audio/wav`, a 16-bit mono 24 kHz WAV, and `X-Processing-Ms` (time to generate).

Errors: `400` with `{"detail": "..."}` for an unknown voice or text that is only whitespace; `422` for a missing or mistyped field, or text over 4000 characters.

One Phonon generation runs at a time. Phonon generates about 17 times faster than real time, so a second request waits at most a fraction of a second. A voice's first use after a restart, or after a request at a different speed, costs about 30 ms more while Phonon primes it; the default voice is primed at startup.

For a call, synthesize sentence by sentence: post each sentence as the language model finishes it, play its chunks as they arrive, and post the next sentence when the previous response has ended. Generation finishes long before playback, so the player always has audio queued.

## `POST /v1/transcribe`

The transcript of a whole clip, for dictation.

Request: `multipart/form-data` with the audio in a `file` field (other fields, such as `language`, are ignored), or the raw audio as the body with any `Content-Type`. At most 50 MB and 600 seconds.

Response, `200`:

```json
{ "text": "Hey, can you look up the current weather in Tokyo for me?", "duration": 4.6, "model": "parakeet-unified-en-0.6b", "processing_ms": 203 }
```

`text` has punctuation and capitals, and is `""` for a clip with no speech. `duration` is the clip's length in seconds. A clip of up to 30 seconds is decoded in one pass; a longer one is split at pauses into pieces of at most 30 seconds, and silence of more than a second and a half between them is skipped. Clips are decoded one at a time; a second request waits.

Errors: `400` for an empty request, audio FFmpeg cannot decode, or a clip over 600 seconds; `413` for an upload over 50 MB.

## `WebSocket /v1/transcribe/stream`

Live recognition for calls: speech start and stop, partial transcripts while the user talks, and a final transcript for each utterance.

Open it with query parameters, all optional:

| Parameter | Default | |
|---|---|---|
| `sample_rate` | `24000` | Rate of the PCM you send, 8000 to 48000 |
| `model` | `nemotron-speech-streaming-en-0.6b-160ms` | The streaming model for partials: a name from `/health`'s `streamModels`, or `nemotron` or `parakeet-unified` for the installed one of that family |
| `final` | `offline` | `offline`: the final transcript comes from Parakeet Unified decoding the whole utterance. `stream`: it is the streaming model's own text |
| `partials` | `true` | `false` sends no `partial` events |
| `silence_ms` | `500` | Silence that ends an utterance |
| `min_speech_ms` | `160` | Speech needed before `speech_started` |
| `threshold` | `0.5` | Silero speech probability that counts as speech, 0.05 to 0.95 |
| `prefix_ms` | `500` | Audio from before the detected start that the recognizers also get, so the first syllable is not lost |
| `max_utterance_ms` | `30000` | An utterance this long is ended and the next one starts |

Send binary messages of PCM (see Audio formats), any length; the browser's 40 ms frames are fine. Keep sending while the call is open, silence included: the server's clock is the audio it has received. Two text messages control the current utterance:

- `{"type": "commit"}` ends it now, as if the silence had come: `speech_stopped` with `"forced": true`, then `final`. Ignored when nobody is speaking.
- `{"type": "reset"}` drops it with no final (`speech_dropped`), for example when the user mutes the microphone.

The server sends JSON text messages:

| `type` | Fields | When |
|---|---|---|
| `ready` | `model`, `sample_rate`, `options` (every parameter's value) | Once, first |
| `speech_started` | `utterance`, `start_ms` | The VAD heard `min_speech_ms` of speech. Pause the bot's audio here for barge-in, and stop it if the final has words of the user's own |
| `partial` | `utterance`, `text` | The streaming model's text for the utterance so far, whenever it changes. Each partial replaces the previous one |
| `speech_stopped` | `utterance`, `end_ms`, `forced` | `silence_ms` of silence after speech, a `commit`, or `max_utterance_ms` |
| `final` | `utterance`, `text`, `model`, `start_ms`, `end_ms`, `processing_ms` | Right after `speech_stopped`. Replaces the partials; can differ from the last one. `model` is the model the text came from: Parakeet Unified, or the streaming model when Parakeet found nothing in a one-word utterance and the stream had. `text` can be `""` when the VAD heard something that was not words |
| `speech_dropped` | `utterance` | After a `reset` mid-utterance |
| `error` | `message` | A bad parameter (the socket then closes with 1008) or a failure inside the session (closes with 1011) |

Every event also has `audio_ms`: how much audio the server had received when it sent the event. `start_ms` and `end_ms` are positions in that same audio, so they line up with what you sent. `utterance` counts from 1. For each utterance the order is `speech_started`, any `partial`s, then `speech_stopped` and `final` (or `speech_dropped`). Closing the socket discards an utterance in progress.

What to expect, measured on the dev machine with this service's 4-CPU cap:

| Event | When |
|---|---|
| `speech_started` | About 170 ms after the user starts talking |
| Partials | About 130 ms behind the words |
| `speech_stopped` | About 650 ms after the last word: the 500 ms of `silence_ms` plus the VAD's own lag |
| `final` | 100 ms after `speech_stopped` for a one-word reply, 250 to 300 ms for a five-second sentence, since Parakeet Unified decodes the whole utterance. `final=stream` finishes in a steadier 150 to 230 ms, less accurately |

Lowering `silence_ms` makes turns end sooner, at the risk of cutting users off when they pause mid-sentence. The service does not cancel echo: the browser's `echoCancellation` has to keep the bot's own voice out of the microphone.

## Settings

compose.yaml sets `SPEECH_THREADS`; the rest are rarely needed.

| Variable | Default | |
|---|---|---|
| `SPEECH_THREADS` | `4` | Threads per model. Keep it at or below the container's `cpus` |
| `SPEECH_TTS_THREADS`, `SPEECH_ASR_THREADS`, `SPEECH_STREAM_THREADS` | `SPEECH_THREADS` | Per model: Phonon, Parakeet Unified, the streaming model |
| `SPEECH_STREAM_MODEL` | `nemotron-speech-streaming-en-0.6b-160ms` | Default streaming model; must be in the image |
| `SPEECH_OFFLINE_MODEL` | `parakeet-unified-en-0.6b` | Model for clips and finals |
| `SPEECH_DEFAULT_VOICE` | `harper` | Phonon's default voice |
| `SPEECH_MAX_TTS_CHARS` | `4000` | |
| `SPEECH_MAX_CLIP_SECONDS`, `SPEECH_MAX_UPLOAD_BYTES` | `600`, `52428800` | Limits for `/v1/transcribe` |

## Dependencies

`requirements.in` lists the service's direct dependencies. `requirements.txt` is compiled from it with every package and its hashes, and the image installs only that, with `--require-hashes`. After changing `requirements.in`, compile it again in the image's Python:

```bash
cd speech
docker run --rm -v "$PWD":/w -w /w python:3.12.16-slim-bookworm sh -c \
  'pip install -q pip-tools && pip-compile --generate-hashes --strip-extras --allow-unsafe requirements.in'
```

Dependabot proposes updates to `requirements.in` and compiles `requirements.txt` the same way, from the command in its header.

## Files

| Path | |
|---|---|
| `Dockerfile` | Builds sherpa-onnx from source at a pinned commit, fetches the models, installs the service |
| `requirements.in`, `requirements.txt` | The service's direct dependencies, and every package they need locked with its hashes |
| `models.json`, `fetch_models.py` | Every model file with its repository, revision, license and hash, and the script that downloads and checks them |
| `app/main.py` | The HTTP and WebSocket routes |
| `app/tts.py` | Phonon: voices, speed, streaming |
| `app/asr.py`, `app/listen.py`, `app/vad.py` | Recognizers, the live session (VAD and streaming), Silero |
| `app/ort-cpu.conf` | onnxruntime settings that keep the models fast under a CPU cap |
| `bench/` | The benchmark and the smoke test; `bench/README.md` says how to run them |

Other streaming models can be added for comparison by mounting their directories (as `fetch_models.py` lays them out) under `/models`; `/health` lists what it finds.
