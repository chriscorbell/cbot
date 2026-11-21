"""Dispatch's speech service. README.md documents every endpoint."""
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import config
from .asr import Recognizers
from .audio import DecodeError, decode_clip, to_pcm16, wav_header
from .guard import RefuseBrowsers
from .listen import ListenSession, Options
from .tts import SPEED_MAX, SPEED_MIN, Phonon

log = logging.getLogger("speech")
state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    t = time.perf_counter()
    loop = asyncio.get_running_loop()
    state["tts"] = await loop.run_in_executor(None, Phonon)
    state["asr"] = await loop.run_in_executor(None, Recognizers)
    tts: Phonon = state["tts"]
    # Phonon primes a voice on its first use (about 30 ms) and keeps the 16 most recent primed.
    await loop.run_in_executor(None, tts.warm, [tts.default_voice])
    log.warning("models loaded in %.1f s", time.perf_counter() - t)
    yield


app = FastAPI(title="Dispatch speech", lifespan=lifespan, docs_url=None, redoc_url=None)
# Only Dispatch's server may use the service, not the web pages the bots open (guard.py).
app.add_middleware(RefuseBrowsers)


@app.get("/health")
async def health():
    tts: Phonon = state["tts"]
    asr: Recognizers = state["asr"]
    return {
        "status": "ok",
        "tts": {"model": config.TTS_MODEL.name, "sampleRate": tts.sample_rate, "voices": len(tts.voices)},
        "asr": {"offline": asr.offline_id, "stream": asr.default_stream, "streamModels": asr.stream_models},
        "threads": {"tts": config.TTS_THREADS, "asr": config.ASR_THREADS, "stream": config.STREAM_THREADS},
    }


@app.get("/v1/voices")
async def voices():
    tts: Phonon = state["tts"]
    return {
        "default": tts.default_voice,
        "sampleRate": tts.sample_rate,
        "speed": {"min": SPEED_MIN, "max": SPEED_MAX, "default": 1.0},
        "voices": tts.voices,
    }


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=config.MAX_TTS_CHARS)
    voice: str | None = None
    speed: float = Field(1.0, gt=0, le=4)
    format: str = Field("pcm", pattern="^(pcm|wav)$")


@app.post("/v1/tts")
async def tts(req: TTSRequest):
    tts: Phonon = state["tts"]
    voice = req.voice or tts.default_voice
    if voice not in tts.voice_ids:
        raise HTTPException(400, f"unknown voice {voice!r}; GET /v1/voices lists them")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    speed = min(max(req.speed, SPEED_MIN), SPEED_MAX)
    headers = {"X-Sample-Rate": str(tts.sample_rate), "X-Voice": voice, "X-Speed": f"{speed:g}"}
    if req.format == "wav":
        loop = asyncio.get_running_loop()
        pcm, secs = await loop.run_in_executor(tts._pool, tts.synth, text, voice, speed)
        body = to_pcm16(pcm)
        headers["X-Processing-Ms"] = str(round(secs * 1000))
        return Response(wav_header(tts.sample_rate, len(body)) + body, media_type="audio/wav", headers=headers)
    return StreamingResponse(
        tts.stream(text, voice, speed),
        media_type=f"audio/pcm;rate={tts.sample_rate};channels=1",
        headers=headers,
    )


@app.post("/v1/transcribe")
async def transcribe(request: Request):
    """A whole clip: multipart with a `file` field, or the raw bytes as the body."""
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form(max_part_size=config.MAX_UPLOAD_BYTES)
        f = form.get("file")
        if f is None or isinstance(f, str):
            raise HTTPException(400, "multipart upload needs a `file` field")
        data = await f.read()
    else:
        data = await request.body()
    if not data:
        raise HTTPException(400, "no audio in the request")
    if len(data) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "upload too large")
    asr: Recognizers = state["asr"]
    loop = asyncio.get_running_loop()
    try:
        x = await loop.run_in_executor(None, decode_clip, data, config.MAX_CLIP_SECONDS)
    except DecodeError as e:
        raise HTTPException(400, str(e)) from e
    return await loop.run_in_executor(None, asr.transcribe, x)


# (option, lowest, highest) for a listening socket's timings, in milliseconds.
LISTEN_BOUNDS = (("min_speech_ms", 0, 5_000), ("silence_ms", 0, 10_000), ("prefix_ms", 0, 5_000), ("max_utterance_ms", 1_000, 120_000))


def _flag(v: str | None, default: bool) -> bool:
    return default if v is None else v.lower() not in ("0", "false", "no", "off")


@app.websocket("/v1/transcribe/stream")
async def transcribe_stream(ws: WebSocket):
    asr: Recognizers = state["asr"]
    q = ws.query_params
    try:
        model = asr.resolve(q.get("model"))
        rate = int(q.get("sample_rate", 24000))
        if not 8000 <= rate <= 48000:
            raise ValueError("sample_rate must be 8000 to 48000")
        d = Options()
        opts = Options(
            threshold=float(q.get("threshold", d.threshold)),
            min_speech_ms=int(q.get("min_speech_ms", d.min_speech_ms)),
            silence_ms=int(q.get("silence_ms", d.silence_ms)),
            prefix_ms=int(q.get("prefix_ms", d.prefix_ms)),
            max_utterance_ms=int(q.get("max_utterance_ms", d.max_utterance_ms)),
            final=q.get("final", d.final),
            partials=_flag(q.get("partials"), d.partials),
        )
        if opts.final not in ("stream", "offline"):
            raise ValueError("final must be stream or offline")
        if not 0.05 <= opts.threshold <= 0.95:
            raise ValueError("threshold must be 0.05 to 0.95")
        # They decide how much audio a session keeps, so they are bounded.
        for name, low, high in LISTEN_BOUNDS:
            if not low <= getattr(opts, name) <= high:
                raise ValueError(f"{name} must be {low} to {high}")
    except (KeyError, ValueError) as e:
        await ws.accept()
        await ws.send_json({"type": "error", "message": f"bad parameter: {e}"})
        await ws.close(code=1008)
        return
    await ws.accept()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, asr.online, model)  # loads a model other than the default on first use
    events: asyncio.Queue = asyncio.Queue()
    session = ListenSession(asr, model, rate, opts, lambda ev: loop.call_soon_threadsafe(events.put_nowait, ev))
    await ws.send_json({
        "type": "ready", "model": model, "sample_rate": rate,
        "options": {k: getattr(opts, k) for k in Options.__dataclass_fields__},
    })

    async def sender():
        while True:
            ev = await events.get()
            if ev is None:
                await ws.close(code=1011)
                return
            await ws.send_text(json.dumps(ev))

    send_task = asyncio.create_task(sender())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes"):
                session.push(msg["bytes"])
            elif msg.get("text"):
                try:
                    kind = json.loads(msg["text"]).get("type")
                except (ValueError, AttributeError):
                    kind = None
                if kind in ("commit", "reset"):
                    session.control(kind)
                else:
                    await ws.send_json({"type": "error", "message": "unknown control message; send commit or reset"})
    except WebSocketDisconnect:
        pass
    finally:
        session.close()
        send_task.cancel()


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("unhandled error on %s", request.url.path)
    return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)
