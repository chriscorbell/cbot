"""Live recognition for calls: Silero VAD decides when the user starts and stops talking, and a
streaming recognizer transcribes each utterance while it is spoken.

A session runs on its own thread. Audio goes in through push(), controls through control(), and
events come out through the `send` callback, in order, as plain dicts (README.md, "Streaming
recognition", documents them).
"""
import queue
import re
import threading
import time
from dataclasses import dataclass

import numpy as np

from .asr import Recognizers
from .audio import ASR_RATE, StreamResampler
from .vad import FRAME

FRAME_MS = FRAME * 1000 // ASR_RATE  # 32


@dataclass
class Options:
    threshold: float = 0.5  # speech probability that counts as speech
    min_speech_ms: int = 160  # this much speech before speech_started
    silence_ms: int = 500  # this much silence ends the utterance
    prefix_ms: int = 500  # audio before the detected start that the recognizer also gets
    max_utterance_ms: int = 30000  # longer utterances are finalized and a new one begins
    final: str = "offline"  # "offline": Parakeet Unified decodes the utterance; "stream": the streaming model's own text
    partials: bool = True


class ListenSession:
    def __init__(self, recs: Recognizers, model_id: str, sample_rate: int, opts: Options, send):
        self.recs = recs
        self.model_id = model_id
        self.rec = recs.online(model_id)
        # Nemotron only decodes whole chunks, and a word needs the chunk after it too: at the end of
        # an utterance it gets this much silence so its last words come out. Parakeet Unified's
        # buffered mode decodes the partial last chunk itself and needs none.
        chunk = re.search(r"-(\d+)ms$", model_id)
        self.tail = (int(chunk.group(1)) + 400) * ASR_RATE // 1000 if model_id.startswith("nemotron") and chunk else 0
        self.opts = opts
        self.send = send
        self.resampler = StreamResampler(sample_rate)
        self.vad = recs.vad.new_state()
        self.q: queue.Queue = queue.Queue()
        # All 16 kHz audio since the session started, trimmed to what an utterance can still need.
        self.audio = np.zeros(0, np.float32)
        self.audio_base = 0  # sample index of self.audio[0]
        self.received = 0  # samples received so far (the session's audio clock)
        self.vad_pos = 0  # samples the VAD has looked at
        self.utterance = 0
        self.speaking = False
        self.candidate: int | None = None  # sample where possible speech began
        self.speech_frames = 0
        self.quiet_frames = 0
        self.silence_start: int | None = None
        self.utt_start = 0
        self.stream = None
        self.fed = 0  # samples of the current utterance given to the recognizer
        self.last_text = ""
        self.thread = threading.Thread(target=self._run, name=f"listen-{model_id}", daemon=True)
        self.thread.start()

    # ---- called from the event loop
    def push(self, data: bytes) -> None:
        self.q.put(("audio", data))

    def control(self, kind: str) -> None:
        self.q.put((kind, None))

    def close(self) -> None:
        self.q.put(("close", None))

    # ---- session thread
    def _ms(self, sample: int) -> int:
        return int(sample * 1000 / ASR_RATE)

    def _emit(self, ev: dict) -> None:
        ev["audio_ms"] = self._ms(self.received)
        self.send(ev)

    def _run(self) -> None:
        try:
            while True:
                kind, data = self.q.get()
                if kind == "close":
                    return
                if kind == "audio":
                    x = self.resampler.push(data)
                    if x.size:
                        self._audio(x)
                elif kind == "commit":
                    if self.speaking:
                        self._finish(self.received, forced=True)
                elif kind == "reset":
                    self._drop()
                    self.vad = self.recs.vad.new_state()
        except Exception as e:  # report and stop; the socket side closes the connection
            self.send({"type": "error", "message": f"{type(e).__name__}: {e}"})
            self.send(None)

    def _audio(self, x: np.ndarray) -> None:
        self.audio = np.concatenate([self.audio, x])
        self.received += x.size
        if self.speaking:
            self._feed()
        while self.vad_pos + FRAME <= self.received:
            i = self.vad_pos - self.audio_base
            p = self.vad.prob(self.audio[i:i + FRAME])
            self._vad_frame(p, self.vad_pos)
            self.vad_pos += FRAME
        if self.speaking:
            self._decode()
        else:
            keep = self.opts.prefix_ms * ASR_RATE // 1000 + 64 * FRAME
            cut = max(0, self.received - keep) - self.audio_base
            if self.candidate is None and cut > 0:
                self.audio = self.audio[cut:]
                self.audio_base += cut

    def _vad_frame(self, p: float, pos: int) -> None:
        o = self.opts
        neg = o.threshold - 0.15
        if not self.speaking:
            if p >= o.threshold:
                if self.candidate is None:
                    self.candidate, self.speech_frames, self.quiet_frames = pos, 0, 0
                self.speech_frames += 1
                self.quiet_frames = 0
                if self.speech_frames * FRAME_MS >= o.min_speech_ms:
                    self._start(self.candidate)
            elif self.candidate is not None:
                if p < neg:
                    self.quiet_frames += 1
                if self.quiet_frames * FRAME_MS >= 100:
                    self.candidate = None
            return
        if p >= o.threshold:
            self.silence_start = None
        elif p < neg and self.silence_start is None:
            self.silence_start = pos
        end = pos + FRAME
        if self.silence_start is not None and end - self.silence_start >= o.silence_ms * ASR_RATE // 1000:
            self._finish(self.silence_start)
        elif end - self.utt_start >= o.max_utterance_ms * ASR_RATE // 1000:
            self._finish(end, forced=True)

    def _start(self, start: int) -> None:
        self.speaking = True
        self.candidate = None
        self.silence_start = None
        self.utterance += 1
        self.utt_start = start
        self.stream = self.rec.create_stream()
        self.fed = max(self.audio_base, start - self.opts.prefix_ms * ASR_RATE // 1000)
        self.last_text = ""
        self._emit({"type": "speech_started", "utterance": self.utterance, "start_ms": self._ms(start)})
        self._feed()

    def _feed(self) -> None:
        if self.fed < self.received:
            self.stream.accept_waveform(ASR_RATE, self.audio[self.fed - self.audio_base:])
            self.fed = self.received

    def _decode(self) -> None:
        while self.rec.is_ready(self.stream):
            self.rec.decode_stream(self.stream)
        if self.opts.partials:
            text = self.rec.get_result(self.stream).strip()
            if text != self.last_text:
                self.last_text = text
                self._emit({"type": "partial", "utterance": self.utterance, "text": text})

    def _finish(self, end: int, forced: bool = False) -> None:
        t = time.perf_counter()
        self._emit({"type": "speech_stopped", "utterance": self.utterance, "end_ms": self._ms(end), "forced": forced})
        if self.opts.final == "offline":
            # The whole utterance through Parakeet Unified at full context; the streaming model's
            # own ending is not needed, so it is not flushed.
            a = max(self.audio_base, self.utt_start - self.opts.prefix_ms * ASR_RATE // 1000) - self.audio_base
            b = min(self.received, end + 300 * ASR_RATE // 1000) - self.audio_base
            text = self.recs.decode_offline([self.audio[a:b]])[0]
            model = self.recs.offline_id
            if not text and self.last_text:  # a short word Parakeet missed and the stream caught
                text, model = self.last_text, self.model_id
        else:
            self._feed()
            if self.tail:
                self.stream.accept_waveform(ASR_RATE, np.zeros(self.tail, np.float32))
            self.stream.input_finished()
            while self.rec.is_ready(self.stream):
                self.rec.decode_stream(self.stream)
            text = self.rec.get_result(self.stream).strip()
            model = self.model_id
        self._emit({
            "type": "final", "utterance": self.utterance, "text": text, "model": model,
            "start_ms": self._ms(self.utt_start), "end_ms": self._ms(end),
            "processing_ms": round((time.perf_counter() - t) * 1000),
        })
        self.speaking = False
        self.stream = None
        self.silence_start = None
        self.candidate = None

    def _drop(self) -> None:
        if self.speaking:
            self._emit({"type": "speech_dropped", "utterance": self.utterance})
        self.speaking = False
        self.stream = None
        self.candidate = None
        self.silence_start = None
