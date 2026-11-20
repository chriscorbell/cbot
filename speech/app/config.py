"""Settings from the environment. compose.yaml sets the ones that differ from these defaults."""
import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


MODELS = Path(os.environ.get("SPEECH_MODELS", "/models"))
PORT = _int("SPEECH_PORT", 8000)

# Threads for each model's matrix maths. Keep them at or below the container's CPU cap: more
# threads than CPUs makes the kernel throttle the container and every chunk arrives late.
THREADS = _int("SPEECH_THREADS", 4)
TTS_THREADS = _int("SPEECH_TTS_THREADS", THREADS)
ASR_THREADS = _int("SPEECH_ASR_THREADS", THREADS)  # Parakeet Unified on whole clips and finals
STREAM_THREADS = _int("SPEECH_STREAM_THREADS", ASR_THREADS)  # the streaming model during calls

# Speech recognition models, by directory name under MODELS (see models.json).
OFFLINE_MODEL = os.environ.get("SPEECH_OFFLINE_MODEL", "parakeet-unified-en-0.6b")
STREAM_MODEL = os.environ.get("SPEECH_STREAM_MODEL", "nemotron-speech-streaming-en-0.6b-160ms")
VAD_MODEL = MODELS / "silero-vad" / "silero_vad.onnx"

TTS_MODEL = MODELS / "phonon-31m-en"
VOICES = MODELS / "phonon-voices-en"
DEFAULT_VOICE = os.environ.get("SPEECH_DEFAULT_VOICE", "harper")

# The ZONOS3-Mini server (zonos3/Dockerfile), whose voices are listed and spoken next to Phonon's.
# Empty leaves them out.
ZONOS3_URL = os.environ.get("SPEECH_ZONOS3_URL", "")

# Longest text one synthesis request takes, and longest clip /v1/transcribe takes.
MAX_TTS_CHARS = _int("SPEECH_MAX_TTS_CHARS", 4000)
MAX_CLIP_SECONDS = _int("SPEECH_MAX_CLIP_SECONDS", 600)
MAX_UPLOAD_BYTES = _int("SPEECH_MAX_UPLOAD_BYTES", 50 * 1024 * 1024)
