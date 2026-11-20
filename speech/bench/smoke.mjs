// Exercises every endpoint of the speech service, from the cbot container (Node 22, no packages):
//
//   docker cp speech/bench/smoke.mjs cbot-dev-cbot-1:/tmp/ && docker cp clip.webm cbot-dev-cbot-1:/tmp/
//   docker exec cbot-dev-cbot-1 node /tmp/smoke.mjs /tmp/clip.webm "what the clip says"
//
// Writes /tmp/speech-smoke/{stream.wav,tts.wav} and prints what each step got.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.SPEECH_URL ?? 'http://speech:8000';
const [webmPath, webmText] = process.argv.slice(2);
const OUT = '/tmp/speech-smoke';
mkdirSync(OUT, { recursive: true });
const TEXT = 'Your meeting with the design team moved to half past three, and I sent everyone the new invite.';
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ');

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const wavSeconds = (b) => b.readUInt32LE(40) / b.readUInt32LE(28);

async function transcribe(buf, name, type) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const t = performance.now();
  const r = await fetch(`${BASE}/v1/transcribe`, { method: 'POST', body: fd });
  const j = await r.json();
  return { ...j, status: r.status, ms: Math.round(performance.now() - t) };
}

// 1. health and voices
const health = await (await fetch(`${BASE}/health`)).json();
check(health.status === 'ok', `health: ${JSON.stringify(health.asr)}`);
const voices = await (await fetch(`${BASE}/v1/voices`)).json();
check(voices.voices.length > 0, `voices: ${voices.voices.length}, default ${voices.default}, speed ${voices.speed.min} to ${voices.speed.max}, e.g. ${JSON.stringify(voices.voices[0])}`);

// 2. streaming TTS: time to the first audio byte, then the whole clip
let t0 = performance.now();
let r = await fetch(`${BASE}/v1/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: TEXT, voice: 'harper' }) });
const reader = r.body.getReader();
const chunks = [];
let first = null;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  first ??= performance.now() - t0;
  chunks.push(Buffer.from(value));
}
const pcm = Buffer.concat(chunks);
const rate = Number(r.headers.get('x-sample-rate'));
writeFileSync(`${OUT}/stream.wav`, wav(pcm, rate));
check(r.status === 200 && pcm.length > rate, `tts stream: ${r.headers.get('content-type')}, first audio ${first.toFixed(0)} ms, ${(pcm.length / 2 / rate).toFixed(2)} s of audio in ${(performance.now() - t0).toFixed(0)} ms`);

// 3. WAV TTS in another voice and speed, then the round trip through /v1/transcribe
r = await fetch(`${BASE}/v1/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: TEXT, voice: 'maeve', speed: 1.2, format: 'wav' }) });
const ttsWav = Buffer.from(await r.arrayBuffer());
writeFileSync(`${OUT}/tts.wav`, ttsWav);
check(r.status === 200, `tts wav: maeve at speed ${r.headers.get('x-speed')}, ${wavSeconds(ttsWav).toFixed(2)} s, generated in ${r.headers.get('x-processing-ms')} ms`);
let tr = await transcribe(ttsWav, 'tts.wav', 'audio/wav');
check(words(tr.text) === words(TEXT), `transcribe wav (${tr.duration} s, ${tr.processing_ms} ms): "${tr.text}"`);

// 4. dictation: a webm/opus clip as MediaRecorder sends it
if (webmPath) {
  tr = await transcribe(readFileSync(webmPath), 'dictation.webm', 'audio/webm;codecs=opus');
  check(tr.status === 200 && (!webmText || words(tr.text) === words(webmText)), `transcribe webm (${tr.duration} s, ${tr.processing_ms} ms, request ${tr.ms} ms): "${tr.text}"`);
}

// 5. bad requests answer 400
r = await fetch(`${BASE}/v1/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hi', voice: 'nobody' }) });
check(r.status === 400, `unknown voice: ${r.status} ${(await r.text()).slice(0, 80)}`);
r = await fetch(`${BASE}/v1/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('not audio') });
check(r.status === 400, `undecodable upload: ${r.status} ${(await r.text()).slice(0, 80)}`);

// 6. streaming recognition: the TTS clip at 24 kHz in 40 ms frames, real time, then silence
async function listen(query, frames, { commitAfter } = {}) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/v1/transcribe/stream?${query}`);
  ws.binaryType = 'arraybuffer';
  const events = [];
  let start = performance.now();
  ws.onmessage = (m) => events.push({ t: Math.round(performance.now() - start), ...JSON.parse(m.data) });
  const done = new Promise((resolve) => { ws.onclose = resolve; });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  start = performance.now();
  for (let i = 0; i < frames.length; i++) {
    const due = start + i * 40;
    if (due > performance.now()) await new Promise((res) => setTimeout(res, due - performance.now()));
    ws.send(frames[i]);
    if (commitAfter === i) ws.send(JSON.stringify({ type: 'commit' }));
  }
  const until = performance.now() + 3000;
  while (!events.some((e) => e.type === 'final') && performance.now() < until) await new Promise((res) => setTimeout(res, 50));
  ws.close();
  await done;
  return events;
}
const frame = (rate * 40) / 1000 * 2;
const silence = (ms) => Array.from({ length: ms / 40 }, () => Buffer.alloc(frame));
const speech = [];
for (let i = 0; i < pcm.length; i += frame) speech.push(pcm.subarray(i, i + frame));
let ev = await listen(`sample_rate=${rate}`, [...silence(800), ...speech, ...silence(1200)]);
for (const e of ev) console.log('     ', JSON.stringify(e));
const fin = ev.find((e) => e.type === 'final');
check(ev[0]?.type === 'ready' && ev.some((e) => e.type === 'speech_started') && ev.some((e) => e.type === 'partial') && fin && words(fin.text) === words(TEXT),
  `stream: ready, speech_started, ${ev.filter((e) => e.type === 'partial').length} partials, final "${fin?.text}"`);

// 7. commit ends the utterance mid-sentence, without waiting for silence
ev = await listen(`sample_rate=${rate}&partials=false`, [...silence(400), ...speech], { commitAfter: 10 + Math.floor(speech.length / 2) });
const stop = ev.find((e) => e.type === 'speech_stopped');
check(stop?.forced === true && ev.some((e) => e.type === 'final'), `commit halfway: speech_stopped forced=${stop?.forced}, final "${ev.find((e) => e.type === 'final')?.text}"`);

// 8. a bad parameter is refused with an error event
ev = await listen('model=nope', []);
check(ev.some((e) => e.type === 'error'), `bad model: ${JSON.stringify(ev.find((e) => e.type === 'error'))}`);

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
