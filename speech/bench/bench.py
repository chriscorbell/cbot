#!/usr/bin/env python3
"""Benchmarks for the speech service, run from a container on the same network.

    docker run --rm --network dispatch-dev_speech -v "$PWD/speech/bench:/bench:ro" -v "$PWD/tests:/tests:ro" \
      -v /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' dispatch-dev-speech-1).scope:/cg:ro \
      -v /some/out:/out dispatch-speech:dev python /bench/bench.py all --out /out

Subcommands: tts, speed, stt, stream, all. README.md next to this file explains each number.
The image's own Python has everything this needs (numpy, soxr, av, websockets, sherpa-onnx and the
offline model, used here only to find word end times for the partial-latency figure).
"""
import argparse
import asyncio
import http.client
import io
import json
import re
import statistics
import sys
import time
import wave
from pathlib import Path
from urllib.parse import urlencode, urlparse

import av
import numpy as np
import soxr

SHORT = "Sure, I can help with that."
LONG = ("I checked the forecast for tomorrow, and it looks like rain in the morning, clearing by early "
        "afternoon, with a high of fifty eight degrees and a light wind from the northwest.")
ROUND_TRIP = [  # (voice, text) synthesized by the service, then recognized; no digits, so WER is fair
    ("harper", "Your meeting with the design team moved to half past three, and I sent everyone the new invite."),
    ("easton", "I found two flights that leave tomorrow morning, and the earlier one has a window seat left."),
    ("maeve", "The report is finished and saved in your library, with a short summary at the top."),
    ("hugh", "Could you tell me which of these photos you would like me to post on the website?"),
]
SHORT_REPLIES = [("harper", "Yes."), ("easton", "No."), ("maeve", "Stop."), ("hugh", "Thanks."),
                 ("easton", "Okay."), ("maeve", "Go ahead."), ("harper", "No."), ("hugh", "Yes.")]
SPEED_TEXTS = [SHORT, ROUND_TRIP[0][1], ROUND_TRIP[2][1], "That's done. Anything else I can do for you?"]
SPEED_VOICES = ["harper", "easton", "maeve", "hugh"]


# ---------------------------------------------------------------- helpers
def norm_words(s: str) -> list[str]:
    s = s.lower().replace("-", " ")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return s.split()


def wer(ref: str, hyp: str) -> tuple[int, int]:
    r, h = norm_words(ref), norm_words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)], len(r)


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768
        if w.getnchannels() > 1:
            x = x.reshape(-1, w.getnchannels()).mean(axis=1)
        return x, w.getframerate()


def wav_bytes(x: np.ndarray, rate: int) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def webm_opus(x: np.ndarray, rate: int) -> bytes:
    """What MediaRecorder sends: Opus in WebM, 48 kHz."""
    y = soxr.resample(x, rate, 48000).astype(np.float32)
    b = io.BytesIO()
    with av.open(b, "w", format="webm") as c:
        s = c.add_stream("libopus", rate=48000, layout="mono")
        for i in range(0, len(y), 960):
            f = av.AudioFrame.from_ndarray(y[None, i:i + 960], format="flt", layout="mono")
            f.sample_rate = 48000
            for p in s.encode(f):
                c.mux(p)
        for p in s.encode(None):
            c.mux(p)
    return b.getvalue()


def pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))] if xs else float("nan")


class Service:
    def __init__(self, url: str):
        u = urlparse(url)
        self.host, self.port = u.hostname, u.port or 80
        self.url = url

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        c = http.client.HTTPConnection(self.host, self.port, timeout=300)
        c.request(method, path, body=body, headers=headers or {})
        return c, c.getresponse()

    def json(self, method: str, path: str, payload=None, raw: bytes | None = None, ctype: str | None = None):
        body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        headers = {"Content-Type": ctype or "application/json"} if body is not None else {}
        c, r = self.request(method, path, body, headers)
        data = r.read()
        c.close()
        if r.status != 200:
            raise RuntimeError(f"{method} {path}: {r.status} {data[:300]!r}")
        return json.loads(data)

    def tts_stream(self, text: str, voice: str, speed: float = 1.0) -> dict:
        """Time to the first audio byte and to the last, and the audio itself."""
        body = json.dumps({"text": text, "voice": voice, "speed": speed}).encode()
        t0 = time.perf_counter()
        c, r = self.request("POST", "/v1/tts", body, {"Content-Type": "application/json"})
        first, chunks = None, []
        while True:
            b = r.read1(65536)
            if not b:
                break
            if first is None:
                first = time.perf_counter() - t0
            chunks.append(b)
        total = time.perf_counter() - t0
        c.close()
        pcm = b"".join(chunks)
        x = np.frombuffer(pcm[: len(pcm) // 2 * 2], "<i2").astype(np.float32) / 32768
        return {"ttfa": first, "total": total, "audio": x, "seconds": len(x) / 24000}

    def tts_wav(self, text: str, voice: str, speed: float = 1.0) -> np.ndarray:
        c, r = self.request("POST", "/v1/tts", json.dumps({"text": text, "voice": voice, "speed": speed, "format": "wav"}).encode(),
                            {"Content-Type": "application/json"})
        data = r.read()
        c.close()
        x, rate = read_wav_bytes(data)
        assert rate == 24000
        return x

    def transcribe(self, data: bytes, ctype: str) -> tuple[dict, float]:
        t0 = time.perf_counter()
        out = self.json("POST", "/v1/transcribe", raw=data, ctype=ctype)
        return out, time.perf_counter() - t0


def read_wav_bytes(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768, w.getframerate()


class CPU:
    """CPU seconds and memory of the speech container, from its cgroup (mounted at /cg)."""

    def __init__(self, path: str | None):
        self.p = Path(path) if path else None

    def usage(self) -> float | None:
        if not self.p or not (self.p / "cpu.stat").exists():
            return None
        for line in (self.p / "cpu.stat").read_text().splitlines():
            if line.startswith("usage_usec"):
                return int(line.split()[1]) / 1e6
        return None

    def memory(self) -> dict | None:
        if not self.p or not (self.p / "memory.current").exists():
            return None
        stat = dict(line.split() for line in (self.p / "memory.stat").read_text().splitlines())
        return {
            "current_mib": int((self.p / "memory.current").read_text()) / 2**20,
            "anon_mib": int(stat.get("anon", 0)) / 2**20,
            "file_mib": int(stat.get("file", 0)) / 2**20,
            "peak_mib": int((self.p / "memory.peak").read_text()) / 2**20 if (self.p / "memory.peak").exists() else None,
        }


# ---------------------------------------------------------------- tts
def bench_tts(svc: Service, reps: int) -> dict:
    out = {}
    # A voice nobody has used since the service started: its first request primes it.
    cold = svc.tts_stream(SHORT, "spencer")
    out["cold_voice_ttfa_ms"] = round(cold["ttfa"] * 1000, 1)
    for name, text in (("short", SHORT), ("long", LONG)):
        runs = [svc.tts_stream(text, "harper") for _ in range(reps)]
        ttfa = [r["ttfa"] * 1000 for r in runs]
        rtf = [r["total"] / r["seconds"] for r in runs]
        out[name] = {
            "chars": len(text), "audio_s": round(runs[0]["seconds"], 2),
            "ttfa_ms_median": round(statistics.median(ttfa), 1), "ttfa_ms_p90": round(pct(ttfa, 0.9), 1),
            "rtf_median": round(statistics.median(rtf), 3), "total_ms_median": round(statistics.median(r["total"] * 1000 for r in runs)),
        }
    return out


def bench_speed(svc: Service) -> dict:
    voices = svc.json("GET", "/v1/voices")
    lo, hi = voices["speed"]["min"], voices["speed"]["max"]
    speeds = sorted({lo, 0.9, 1.0, 1.1, 1.2, hi})
    base = None
    table = []
    for sp in speeds:
        total = sum(len(svc.tts_wav(t, v, sp)) / 24000 for v in SPEED_VOICES for t in SPEED_TEXTS)
        table.append((sp, total))
        if sp == 1.0:
            base = total
    res = [{"requested": sp, "measured": round(base / total, 3), "seconds": round(total, 2)} for sp, total in table]
    # Do the extremes still say the words? Round trip at the slowest and fastest rates.
    trips = []
    for sp in (lo, hi):
        errs = words = 0
        for v, text in ROUND_TRIP:
            x = svc.tts_wav(text, v, sp)
            got, _ = svc.transcribe(wav_bytes(x, 24000), "audio/wav")
            e, n = wer(text, got["text"])
            errs, words = errs + e, words + n
        trips.append({"speed": sp, "wer": round(errs / words, 3)})
    return {"rates": res, "round_trip": trips}


# ---------------------------------------------------------------- clips
def load_clips(args) -> list[dict]:
    """Human speech with references, and Phonon speech synthesized by the service."""
    clips = []
    x, rate = read_wav("/tests/ask-weather.wav")
    x = soxr.resample(x, rate, 16000)[int(8.6 * 16000):int(13.2 * 16000)].astype(np.float32)
    clips.append({"name": "ask-weather", "kind": "human", "audio": x, "text": "Hey, can you look up the current weather in Tokyo for me?"})
    for spec in args.clip or []:
        path, text = spec.split("=", 1)
        y, r = read_wav(path)
        clips.append({"name": Path(path).stem, "kind": "human", "audio": soxr.resample(y, r, 16000).astype(np.float32), "text": text})
    return clips


def phonon_clips(svc: Service, short: bool = False) -> list[dict]:
    out = []
    for v, text in ROUND_TRIP:
        x = svc.tts_wav(text, v)
        out.append({"name": f"phonon-{v}", "kind": "phonon", "audio": soxr.resample(x, 24000, 16000).astype(np.float32), "text": text})
    if short:  # one- and two-word replies, which a call is full of
        for v, text in SHORT_REPLIES:
            x = svc.tts_wav(text, v)
            out.append({"name": f"reply-{v}-{norm_words(text)[0]}", "kind": "reply", "audio": soxr.resample(x, 24000, 16000).astype(np.float32), "text": text})
    return out


def speech_bounds(x: np.ndarray) -> tuple[int, int]:
    """First and last 10 ms frame above -40 dBFS."""
    f = x[: len(x) // 160 * 160].reshape(-1, 160)
    db = 20 * np.log10(np.sqrt((f ** 2).mean(axis=1)) + 1e-9)
    on = np.nonzero(db > -40)[0]
    return (int(on[0]) * 160, int(on[-1] + 1) * 160) if len(on) else (0, len(x))


def word_ends(clips: list[dict]) -> None:
    """End time of each word in each clip, from the offline model's token timestamps."""
    import sherpa_onnx
    d = "/models/parakeet-unified-en-0.6b"
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=f"{d}/encoder.int8.onnx", decoder=f"{d}/decoder.int8.onnx", joiner=f"{d}/joiner.int8.onnx",
        tokens=f"{d}/tokens.txt", num_threads=4, model_type="nemo_transducer")
    for c in clips:
        s = rec.create_stream()
        s.accept_waveform(16000, c["audio"])
        rec.decode_stream(s)
        toks, ts = s.result.tokens, s.result.timestamps
        # A word ends one 80 ms encoder frame after its last token was emitted.
        ends, cur = [], None
        for tok, t in zip(toks, ts):
            if tok.startswith((" ", "\u2581")) and cur is not None and norm_words(tok):
                ends.append(cur)
            if norm_words(tok) or cur is None:
                cur = t + 0.08
        if cur is not None:
            ends.append(cur)
        # Punctuation-only tokens can make extra "words"; keep as many ends as the transcript has words.
        n = len(norm_words(s.result.text))
        c["word_ends"] = [e for e in ends][:n] if len(ends) >= n else ends + [ends[-1]] * (n - len(ends))


# ---------------------------------------------------------------- stt
def bench_stt(svc: Service, clips: list[dict]) -> dict:
    rows = []
    for c in clips:
        out, wall = svc.transcribe(wav_bytes(c["audio"], 16000), "audio/wav")
        e, n = wer(c["text"], out["text"])
        rows.append({"clip": c["name"], "seconds": round(len(c["audio"]) / 16000, 2), "processing_ms": out["processing_ms"],
                     "rtf": round(out["processing_ms"] / 1000 / (len(c["audio"]) / 16000), 3), "errors": e, "words": n, "text": out["text"]})
    # Longer clips: all of them back to back (about a minute), and the full 103 s test file with its long silences.
    allx = np.concatenate([np.concatenate([c["audio"], np.zeros(8000, np.float32)]) for c in clips])
    ref = " ".join(c["text"] for c in clips)
    out, wall = svc.transcribe(wav_bytes(allx, 16000), "audio/wav")
    e, n = wer(ref, out["text"])
    rows.append({"clip": "all-clips", "seconds": round(len(allx) / 16000, 2), "processing_ms": out["processing_ms"],
                 "rtf": round(out["processing_ms"] / 1000 / (len(allx) / 16000), 3), "errors": e, "words": n})
    raw = Path("/tests/ask-weather.wav").read_bytes()
    out, wall = svc.transcribe(raw, "audio/wav")
    rows.append({"clip": "ask-weather.wav (full, 48 kHz)", "seconds": out["duration"], "processing_ms": out["processing_ms"],
                 "rtf": round(out["processing_ms"] / 1000 / out["duration"], 3), "text": out["text"]})
    # Dictation: the same clip as MediaRecorder would send it.
    c = clips[0]
    data = webm_opus(c["audio"], 16000)
    out, wall = svc.transcribe(data, "audio/webm")
    e, n = wer(c["text"], out["text"])
    rows.append({"clip": f"{c['name']} as webm/opus ({len(data)} bytes)", "seconds": out["duration"], "processing_ms": out["processing_ms"],
                 "request_ms": round(wall * 1000), "errors": e, "words": n, "text": out["text"]})
    return {"clips": rows}


# ---------------------------------------------------------------- streaming
async def run_stream(url: str, clips: list[dict], model: str, final: str, cpu: CPU, rate: int = 24000, gap_s: float = 1.5) -> dict:
    import websockets

    rng = np.random.default_rng(0)
    parts, gt, pos = [np.zeros(16000, np.float32)], [], 16000
    for c in clips:
        a, b = speech_bounds(c["audio"])
        gt.append({"clip": c, "on": pos + a, "off": pos + b, "base": pos})
        parts.append(c["audio"])
        pos += len(c["audio"])
        parts.append(np.zeros(int(gap_s * 16000), np.float32))
        pos += int(gap_s * 16000)
    x16 = np.concatenate(parts)
    x16 = x16 + rng.normal(0, 10 ** (-65 / 20), len(x16)).astype(np.float32)  # a quiet room, not digital silence
    x = soxr.resample(x16, 16000, rate).astype(np.float32)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    frame = rate * 40 // 1000 * 2  # 40 ms, like the browser's worklet

    q = urlencode({"model": model, "sample_rate": rate, "final": final})
    events: list[tuple[float, dict]] = []
    cpu0 = cpu.usage()
    async with websockets.connect(f"{url.replace('http', 'ws')}/v1/transcribe/stream?{q}", max_size=None) as ws:
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready", ready

        async def reader():
            async for m in ws:
                events.append((time.perf_counter(), json.loads(m)))

        rt = asyncio.create_task(reader())
        t0 = time.perf_counter()
        for i in range(0, len(pcm), frame):
            due = t0 + i / 2 / rate
            delay = due - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
            await ws.send(pcm[i:i + frame])
        sent_all = time.perf_counter()
        # Let the last utterance finish; a live mic keeps sending silence, so do the same.
        deadline = sent_all + 4
        n_final = lambda: sum(1 for _, e in events if e["type"] == "final")
        silence = b"\0" * frame
        k = 0
        while n_final() < len(clips) and time.perf_counter() < deadline:
            await asyncio.sleep(max(0, sent_all + (k + 1) * 0.04 - time.perf_counter()))
            await ws.send(silence)
            k += 1
        await asyncio.sleep(0.2)
        rt.cancel()
    cpu1 = cpu.usage()
    wall_at = lambda sample16: t0 + sample16 / 16000  # when the stream had sent that 16 kHz sample

    # Match server utterances to the clips by where they start in the stream.
    by_utt: dict[int, dict] = {}
    for t, e in events:
        u = e.get("utterance")
        if u is None:
            continue
        d = by_utt.setdefault(u, {"partials": []})
        if e["type"] == "partial":
            d["partials"].append((t, e["text"]))
        else:
            d[e["type"]] = (t, e)
    rows = []
    for g in gt:
        cands = [u for u, d in by_utt.items() if "speech_started" in d and
                 abs(d["speech_started"][1]["start_ms"] - g["on"] / 16) < 1000]
        if not cands:
            rows.append({"clip": g["clip"]["name"], "missed": True})
            continue
        # A clip the VAD split in two: take the first piece's start and the last piece's final.
        us = sorted(u for u, d in by_utt.items() if "final" in d and g["base"] / 16 <= d["final"][1]["start_ms"] < (g["base"] + len(g["clip"]["audio"])) / 16)
        first = by_utt[min(cands)]
        last = by_utt[us[-1]] if us else first
        text = " ".join(by_utt[u]["final"][1]["text"] for u in us)
        e, n = wer(g["clip"]["text"], text)
        row = {
            "clip": g["clip"]["name"], "pieces": len(us),
            "start_ms": round((first["speech_started"][0] - wall_at(g["on"])) * 1000),
            "vad_start_err_ms": round(first["speech_started"][1]["start_ms"] - g["on"] / 16),
        }
        if "final" in last:
            row["final_ms"] = round((last["final"][0] - wall_at(g["off"])) * 1000)
            row["final_after_stop_ms"] = round((last["final"][0] - last["speech_stopped"][0]) * 1000)
            row["server_final_ms"] = last["final"][1]["processing_ms"]
        if first["partials"]:
            row["first_partial_ms"] = round((first["partials"][0][0] - wall_at(g["on"])) * 1000)
        # Partial latency: when word i first shows in a partial, minus when word i ended in the stream.
        lat = []
        ends = g["clip"].get("word_ends", [])
        offs = g["base"]
        parts_t = [(t, len(norm_words(txt))) for u in us for (t, txt) in by_utt[u]["partials"]] if us else []
        seen = 0
        for t, nw in parts_t:
            while seen < min(nw, len(ends)):
                lat.append((t - wall_at(offs + ends[seen] * 16000)) * 1000)
                seen += 1
        row["word_lat_ms"] = lat
        row.update(errors=e, words=n, text=text)
        rows.append(row)
    lat_all = [v for r in rows for v in r.get("word_lat_ms", [])]
    errs = sum(r.get("errors", 0) for r in rows)
    words = sum(r.get("words", 0) for r in rows)
    stream_s = len(x16) / 16000
    speech_s = sum((g["off"] - g["on"]) / 16000 for g in gt)

    def med(key):
        v = [r[key] for r in rows if key in r]
        return round(statistics.median(v)) if v else None

    for r in rows:
        r["word_lat_ms"] = [round(v) for v in r["word_lat_ms"]]
    return {
        "model": ready["model"], "final": final, "stream_s": round(stream_s, 1), "speech_s": round(speech_s, 1),
        "speech_started_ms_median": med("start_ms"),
        "first_partial_ms_median": med("first_partial_ms"),
        "partial_word_lag_ms_median": round(statistics.median(lat_all)) if lat_all else None,
        "partial_word_lag_ms_p90": round(pct(lat_all, 0.9)) if lat_all else None,
        "final_after_speech_end_ms_median": med("final_ms"),
        "final_after_stopped_ms_median": med("final_after_stop_ms"),
        "wer": round(errs / words, 3) if words else None,
        "replies_ok": f"{sum(1 for r in rows if r['clip'].startswith('reply-') and r.get('errors') == 0)}/{sum(1 for r in rows if r['clip'].startswith('reply-'))}",
        "cpu_cores_avg": round((cpu1 - cpu0) / stream_s, 2) if cpu0 is not None and cpu1 is not None else None,
        "missed": sum(1 for r in rows if r.get("missed")),
        "utterances": rows,
    }


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["tts", "speed", "stt", "stream", "all"])
    ap.add_argument("--url", default="http://speech:8000")
    ap.add_argument("--out", default="/out")
    ap.add_argument("--cg", default="/cg", help="the speech container's cgroup directory")
    ap.add_argument("--reps", type=int, default=10)
    ap.add_argument("--clip", action="append", help="extra human clip as path.wav=reference text")
    ap.add_argument("--stream-model", action="append", help="model[:final], e.g. nemotron:stream; repeatable")
    args = ap.parse_args()
    svc = Service(args.url)
    cpu = CPU(args.cg)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    results = {"health": svc.json("GET", "/health"), "memory_before": cpu.memory()}
    if args.what in ("tts", "all"):
        results["tts"] = bench_tts(svc, args.reps)
        print(json.dumps(results["tts"], indent=1), flush=True)
    if args.what in ("speed", "all"):
        results["speed"] = bench_speed(svc)
        print(json.dumps(results["speed"], indent=1), flush=True)
    if args.what in ("stt", "all"):
        results["stt"] = bench_stt(svc, load_clips(args) + phonon_clips(svc))
        print(json.dumps(results["stt"], indent=1), flush=True)
    if args.what in ("stream", "all"):
        clips = load_clips(args) + phonon_clips(svc, short=True)
        word_ends(clips)
        results["stream"] = []
        for spec in args.stream_model or ["nemotron:stream"]:
            model, _, final = spec.partition(":")
            r = asyncio.run(run_stream(args.url, clips, model, final or "stream", cpu))
            results["stream"].append(r)
            summary = {k: v for k, v in r.items() if k != "utterances"}
            print(json.dumps(summary), flush=True)
            for u in r["utterances"]:
                print("   ", json.dumps({k: v for k, v in u.items() if k != "word_lat_ms"}), flush=True)
    results["memory_after"] = cpu.memory()
    print("memory", json.dumps(results["memory_after"]))
    (out / f"bench-{args.what}-{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(json.dumps(results, indent=1, default=str))


if __name__ == "__main__":
    sys.exit(main())
