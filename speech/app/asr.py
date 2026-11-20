"""Speech recognition models on sherpa-onnx: Parakeet Unified for whole clips, and a streaming
model (Nemotron Speech Streaming or Parakeet Unified's buffered mode) for live audio."""
import threading
import time
from pathlib import Path

import numpy as np
import sherpa_onnx

from . import config
from .audio import ASR_RATE
from .vad import FRAME, SileroModel

# sherpa-onnx reads onnxruntime session settings from a file named after the provider.
PROVIDER = f"cpu:{Path(__file__).with_name('ort-cpu.conf')}"
STREAM_FAMILIES = ("nemotron-speech-streaming-en-0.6b-", "parakeet-unified-en-0.6b-streaming-")
ALIASES = {"nemotron": STREAM_FAMILIES[0], "parakeet-unified": STREAM_FAMILIES[1]}


def _files(d: Path) -> dict:
    return {
        "encoder": str(d / "encoder.int8.onnx"),
        "decoder": str(d / "decoder.int8.onnx"),
        "joiner": str(d / "joiner.int8.onnx"),
        "tokens": str(d / "tokens.txt"),
    }


class Recognizers:
    def __init__(self) -> None:
        self.vad = SileroModel(str(config.VAD_MODEL))
        self.offline_id = config.OFFLINE_MODEL
        self.offline = sherpa_onnx.OfflineRecognizer.from_transducer(
            **_files(config.MODELS / self.offline_id),
            num_threads=config.ASR_THREADS,
            provider=PROVIDER,
            model_type="nemo_transducer",
            decoding_method="greedy_search",
        )
        # One clip at a time: a second request waits rather than splitting the CPU.
        self._offline_lock = threading.Lock()
        self._online: dict[str, sherpa_onnx.OnlineRecognizer] = {}
        self._online_lock = threading.Lock()
        self.stream_models = sorted(
            p.name for p in config.MODELS.iterdir()
            if p.is_dir() and p.name.startswith(STREAM_FAMILIES) and (p / "encoder.int8.onnx").exists()
        )
        if config.STREAM_MODEL not in self.stream_models:
            raise RuntimeError(f"SPEECH_STREAM_MODEL {config.STREAM_MODEL!r} is not under {config.MODELS}")
        self.default_stream = config.STREAM_MODEL
        self.online(self.default_stream)

    def resolve(self, name: str | None) -> str:
        """A streaming model id from a full id, a family alias ("nemotron", "parakeet-unified"), or
        nothing (the default)."""
        if not name:
            return self.default_stream
        if name in self.stream_models:
            return name
        prefix = ALIASES.get(name)
        if prefix:
            if self.default_stream.startswith(prefix):
                return self.default_stream
            for m in self.stream_models:
                if m.startswith(prefix):
                    return m
        raise KeyError(name)

    def online(self, model_id: str) -> sherpa_onnx.OnlineRecognizer:
        with self._online_lock:
            rec = self._online.get(model_id)
            if rec is None:
                rec = sherpa_onnx.OnlineRecognizer.from_transducer(
                    **_files(config.MODELS / model_id),
                    num_threads=config.STREAM_THREADS,
                    provider=PROVIDER,
                    decoding_method="greedy_search",
                )
                self._online[model_id] = rec
            return rec

    def decode_offline(self, segments: list[np.ndarray]) -> list[str]:
        """One segment at a time: a batch pads every segment to the longest and multiplies the memory.

        Each segment gets half a second of silence after it, which keeps a word right at the end of
        a clip (a dictation stopped quickly) from coming back empty. On a clip of one short word the
        model can still return nothing, and whether it does depends on the exact cut; a segment that
        decodes to nothing is tried once more without the added silence."""
        texts = []
        tail = np.zeros(ASR_RATE // 2, np.float32)
        with self._offline_lock:
            for seg in segments:
                text = ""
                for audio in (np.concatenate([seg, tail]), seg):
                    s = self.offline.create_stream()
                    s.accept_waveform(ASR_RATE, audio)
                    self.offline.decode_stream(s)
                    text = s.result.text.strip()
                    if text or len(seg) > 10 * ASR_RATE:
                        break
                texts.append(text)
        return texts

    def speech_segments(self, x: np.ndarray, max_seconds: float = 30.0) -> list[np.ndarray]:
        """The speech in a long clip, as pieces of at most max_seconds that start and end in pauses.
        Silence longer than a second and a half between pieces is left out."""
        state = self.vad.new_state()
        n = len(x) // FRAME
        speech = [state.prob(x[i * FRAME:(i + 1) * FRAME]) >= 0.5 for i in range(n)]
        # Runs of speech, joined across pauses under half a second, padded by a quarter second.
        regions: list[list[int]] = []
        for i, s in enumerate(speech):
            if not s:
                continue
            if regions and i - regions[-1][1] < 16:
                regions[-1][1] = i + 1
            else:
                regions.append([i, i + 1])
        pad, limit = 8 * FRAME, int(max_seconds * ASR_RATE)
        spans = [(max(0, a * FRAME - pad), min(len(x), b * FRAME + pad)) for a, b in regions]
        pieces: list[list[int]] = []
        for a, b in spans:
            if pieces and b - pieces[-1][0] <= limit and a - pieces[-1][1] < int(1.5 * ASR_RATE):
                pieces[-1][1] = b
            else:
                pieces.append([a, b])
        out = []
        for a, b in pieces:
            for c in range(a, b, limit):  # a single run of speech longer than the limit: hard cuts
                out.append(x[c:min(b, c + limit)])
        return out

    def transcribe(self, x: np.ndarray) -> dict:
        t = time.perf_counter()
        duration = len(x) / ASR_RATE
        segments = [x] if duration <= 30 else self.speech_segments(x)
        texts = self.decode_offline(segments) if segments and len(x) else []
        return {
            "text": " ".join(t for t in texts if t),
            "duration": round(duration, 3),
            "model": self.offline_id,
            "processing_ms": round((time.perf_counter() - t) * 1000),
        }
