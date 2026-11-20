"""Audio in and out: decoding uploaded clips, resampling streamed PCM, and encoding PCM16."""
import io
import struct

import av
import numpy as np
import soxr

ASR_RATE = 16000  # both recognizers and the VAD take 16 kHz mono


class DecodeError(ValueError):
    pass


def decode_clip(data: bytes, max_seconds: float) -> np.ndarray:
    """Any container and codec FFmpeg reads (webm/opus, ogg/opus, mp4/aac, wav, mp3...) to 16 kHz
    mono float32 in [-1, 1]."""
    try:
        with av.open(io.BytesIO(data), mode="r") as container:
            if not container.streams.audio:
                raise DecodeError("no audio stream in the upload")
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="flt", layout="mono", rate=ASR_RATE)
            parts: list[np.ndarray] = []
            total = 0
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    a = out.to_ndarray().reshape(-1)
                    parts.append(a)
                    total += a.size
                if total > max_seconds * ASR_RATE:
                    raise DecodeError(f"clip is longer than {max_seconds:.0f} s")
            for out in resampler.resample(None):
                parts.append(out.to_ndarray().reshape(-1))
    except av.FFmpegError as e:
        raise DecodeError(f"could not decode the audio: {e}") from e
    if not parts:
        return np.zeros(0, np.float32)
    return np.clip(np.concatenate(parts).astype(np.float32, copy=False), -1.0, 1.0)


class StreamResampler:
    """PCM16 little-endian mono at `rate` in, 16 kHz float32 out, keeping filter state between calls."""

    def __init__(self, rate: int):
        self.rate = rate
        self._odd = b""
        self._rs = None if rate == ASR_RATE else soxr.ResampleStream(rate, ASR_RATE, 1, dtype="float32", quality="HQ")

    def push(self, data: bytes) -> np.ndarray:
        data = self._odd + data
        if len(data) % 2:
            self._odd, data = data[-1:], data[:-1]
        else:
            self._odd = b""
        x = np.frombuffer(data, "<i2").astype(np.float32) / 32768.0
        if self._rs is None:
            return x
        return self._rs.resample_chunk(x)

    def flush(self) -> np.ndarray:
        if self._rs is None:
            return np.zeros(0, np.float32)
        return self._rs.resample_chunk(np.zeros(0, np.float32), last=True)


def to_pcm16(x: np.ndarray) -> bytes:
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def wav_header(rate: int, data_bytes: int) -> bytes:
    return b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16
    ) + b"data" + struct.pack("<I", data_bytes)
