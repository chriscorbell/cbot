"""Phonon 31M text-to-speech through Gradium's ptts runtime."""
import asyncio
import json
import re
import threading
import time
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import ptts

from . import config
from .audio import to_pcm16
from .text import pause_dashes

# Phonon has no speed setting as such. Its `duration_delta` conditioner stretches or squeezes the
# speech, and saturates beyond about +-0.5. These points map a speaking rate (1 = normal) to the
# delta that gives it, measured over 4 voices and 4 sentences; `bench.py speed` checks them.
SPEED_TABLE = [  # (speed, duration_delta), speed ascending
    (0.86, 0.45),
    (0.88, 0.30),
    (0.91, 0.15),
    (1.00, 0.00),
    (1.11, -0.15),
    (1.19, -0.30),
    (1.27, -0.45),
]
SPEED_MIN, SPEED_MAX = SPEED_TABLE[0][0], SPEED_TABLE[-1][0]


def speed_to_delta(speed: float) -> float:
    s = min(max(speed, SPEED_MIN), SPEED_MAX)
    xs = [p[0] for p in SPEED_TABLE]
    ys = [p[1] for p in SPEED_TABLE]
    return float(np.interp(s, xs, ys))


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


class Phonon:
    def __init__(self) -> None:
        ptts.set_num_threads(config.TTS_THREADS)
        self.tts = ptts.TTS(str(config.TTS_MODEL), lang="en", quant="q8")
        self.sample_rate = self.tts.sample_rate
        self.voices: list[dict] = []
        for line in (config.VOICES / "voices.jsonl").read_text().splitlines():
            v = json.loads(line)
            if v.get("language") != "en":
                continue
            character = v.get("locale") == "characters"
            vid = slug(v["name"])
            self.tts.add_voice(vid, str(config.VOICES / v["filename"]))
            self.voices.append({
                "id": vid,
                "name": v["name"],
                "gender": v.get("gender"),
                "locale": None if character else v.get("locale"),
                "age": v.get("age"),
                "character": character,
                "description": v.get("description"),
                "catalogId": v["voice_id"],
                "engine": "phonon",
            })
        self.voice_ids = {v["id"] for v in self.voices}
        if config.DEFAULT_VOICE not in self.voice_ids:
            raise RuntimeError(f"SPEECH_DEFAULT_VOICE {config.DEFAULT_VOICE!r} is not an English Phonon voice")
        self.default_voice = config.DEFAULT_VOICE
        # duration_delta is a setting of the whole model, so a generation changes it and starts its
        # stream under this lock. A started stream keeps the value it started with.
        self._lock = threading.Lock()
        self._delta = 0.0
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tts")

    def warm(self, voices: list[str]) -> None:
        """Prime these voices now, so their first request starts as fast as later ones."""
        with self._lock:
            for v in voices:
                with self.tts.stream("Hello, how can I help you today?", voice=v) as audio:
                    for _ in audio:
                        pass

    def _generate(self, text: str, voice: str, speed: float, emit, cancel: threading.Event) -> None:
        with self._lock:
            delta = speed_to_delta(speed)
            if delta != self._delta:
                self.tts.set_conditions({"duration_delta": delta})
                self._delta = delta
            with self.tts.stream(pause_dashes(text), voice=voice) as audio:
                for chunk in audio:
                    if cancel.is_set():
                        break
                    emit(chunk)

    async def stream(self, text: str, voice: str, speed: float) -> AsyncIterator[bytes]:
        """PCM16 chunks as Phonon decodes them. Generation runs ahead of the reader into a queue,
        so a slow reader never holds the model; leaving the iterator early stops the generation."""
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        cancel = threading.Event()
        done = object()

        def emit(chunk: np.ndarray) -> None:
            loop.call_soon_threadsafe(q.put_nowait, to_pcm16(chunk))

        def run() -> None:
            try:
                self._generate(text, voice, speed, emit, cancel)
                loop.call_soon_threadsafe(q.put_nowait, done)
            except BaseException as e:  # surfaced to the reader
                loop.call_soon_threadsafe(q.put_nowait, e)

        fut = loop.run_in_executor(self._pool, run)
        try:
            while True:
                item = await q.get()
                if item is done:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            cancel.set()
            fut.add_done_callback(lambda f: f.exception())

    def synth(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, float]:
        """Whole utterance at once (for WAV output). Returns the samples and the time to generate."""
        out: list[np.ndarray] = []
        t = time.perf_counter()
        self._generate(text, voice, speed, out.append, threading.Event())
        return (np.concatenate(out) if out else np.zeros(0, np.float32)), time.perf_counter() - t
