# Speech benchmarks and smoke test

`bench.py` measures the running speech service the way Dispatch will use it, from a separate container on the project's `speech` network. `smoke.mjs` calls every endpoint once from the `dispatch` container.

## Running the benchmark

With the dev project up (`DISPATCH_PORT=8788 docker compose -p dispatch-dev up -d --build`), from the repository root:

```sh
id=$(docker inspect -f '{{.Id}}' dispatch-dev-speech-1)
docker run --rm --network dispatch-dev_speech --cpus 4 \
  -v "$PWD/speech/bench:/bench:ro" -v "$PWD/tests:/tests:ro" -v "$PWD/out:/out" \
  -v /sys/fs/cgroup/system.slice/docker-$id.scope:/cg:ro \
  -v /path/to/clips:/data:ro \
  dispatch-speech:dev python /bench/bench.py all --out /out \
  --clip "/data/ls0.wav=After early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels"
```

The image has everything the script needs. The cgroup mount lets it read the speech container's CPU time and memory (cgroup v2); without it those figures are left out. `--clip path=text` adds a recording with its reference transcript and can be repeated. The recorded run used three LibriSpeech test-clean recordings (CC BY 4.0) that ship as test files with the sherpa-onnx model exports:

| Clip | Source |
|---|---|
| `ls0.wav`, `ls1.wav` | `test_wavs/0.wav` and `1.wav` of `csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25` at `237e551a`, references in its `trans.txt` |
| `ls2.wav` | `test_wavs/0.wav` of `csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming` at `8c3a10fb`: "Well, I don't wish to see it any more, observed Phoebe, turning away her eyes. It is certainly very like the old portrait." |

`bench.py tts|speed|stt|stream|all` runs one part or all of them; each run writes its numbers to `--out` as JSON. `--stream-model model:final` (repeatable) picks the streaming configurations, for example `nemotron-speech-streaming-en-0.6b-560ms:offline` or `parakeet-unified-en-0.6b-streaming-1120ms:stream`. A model the image does not ship can be fetched with `python3 speech/fetch_models.py <dir> <id>` and mounted into the speech container at `/models/<id>` with a Compose override file; `/health` lists what the service found.

## What each number means

**Text-to-speech.** Time to first audio is from sending `POST /v1/tts` to the first byte of the body, in the client container. Real-time factor is the time to the last byte divided by the length of the audio. "Short" is "Sure, I can help with that." (2 s of audio), "long" a 176-character sentence (about 10 s); ten runs each in the default voice, medians. The cold figure is the first request for a voice the service has not used since it started.

**Speed.** Total length of four sentences in four voices at each requested speed, against speed 1; then the slowest and fastest speeds go through `/v1/transcribe` to check the words survive.

**Whole clips.** `processing_ms` as the service reports it (decoding the upload and recognizing it), divided by the clip's length for the real-time factor. The clips are the test recording's speech, the LibriSpeech clips, four Phonon sentences, all of them in one minute-long file, the full 103 s `tests/ask-weather.wav` (mostly silence), and the test recording as WebM/Opus, as MediaRecorder sends it.

**Streaming.** One session of about 89 s: a second of quiet, then 16 utterances with 1.5 s between them (the test recording, three LibriSpeech clips, four Phonon sentences and eight one- or two-word Phonon replies such as "Yes." and "Stop."), over a noise floor at -65 dBFS. It goes out at 24 kHz in 40 ms frames at real-time pace, like the browser's microphone. For each utterance, speech starts and ends at the first and last 10 ms above -40 dBFS.

- `speech_started`: from the start of speech to the event.
- First partial: from the start of speech to the first `partial`.
- Partial word lag: when each word first shows up in a partial, minus when that word ended in the audio. Word end times come from Parakeet Unified's token timestamps on the clip; median and 90th percentile over every word.
- Final after speech end: from the end of speech to `final`. It includes `silence_ms` (500 ms) and the VAD's lag in deciding the speech is over; "after stopped" is the part after `speech_stopped`.
- WER: word error rate over all utterances, lower case and without punctuation. British and American spellings ("dishonoured") count as errors, so differences of one or two words between models are noise.
- Replies: how many of the eight short replies came out exactly right.
- CPU: the speech container's CPU time during the session divided by its length, in cores.

## Smoke test

From the repository root, with the dev project up:

```sh
ffmpeg -ss 8.6 -t 4.6 -i tests/ask-weather.wav -ac 1 -c:a libopus -b:a 32k /tmp/dictation.webm
docker cp speech/bench/smoke.mjs dispatch-dev-dispatch-1:/tmp/ && docker cp /tmp/dictation.webm dispatch-dev-dispatch-1:/tmp/
docker exec dispatch-dev-dispatch-1 node /tmp/smoke.mjs /tmp/dictation.webm "Hey, can you look up the current weather in Tokyo for me?"
```

It checks health and voices, streams speech and saves it to `/tmp/speech-smoke/stream.wav`, saves a WAV in another voice and speed to `/tmp/speech-smoke/tts.wav` and transcribes it back, transcribes the WebM clip, sends two bad requests, runs a live session with the streamed speech and prints its events, ends an utterance halfway with `commit`, and opens a socket with a bad model. It exits non-zero if a check fails.
