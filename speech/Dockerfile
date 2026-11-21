# Dispatch's speech service: Phonon text-to-speech and Parakeet speech recognition on the CPU.
# compose.yaml runs it as the `speech` service; README.md documents the API.

# ---------------------------------------------------------------- build: sherpa-onnx from source
# The ASR runtime. Built at a pinned commit of main because the buffered streaming path for
# Parakeet Unified was fixed after the last release (k2-fsa/sherpa-onnx#4133, merged 2026-11-13;
# 2.0.1 loses words with endpointing on). Swap in the PyPI wheel once a release includes it.
FROM python:3.15.2-slim-bookworm AS sherpa
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG SHERPA_ONNX_COMMIT=78022953788ff05f62f4a733c6268a5689efeb86
RUN git init -q /src && cd /src \
 && git fetch -q --depth 1 https://github.com/k2-fsa/sherpa-onnx "${SHERPA_ONNX_COMMIT}" \
 && git checkout -q FETCH_HEAD
# The Python module imports its TTS and diarization classes unconditionally, so those stay in;
# audio devices, the websocket server and the command-line binaries are left out.
ENV SHERPA_ONNX_CMAKE_ARGS="-DCMAKE_BUILD_TYPE=Release -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF -DSHERPA_ONNX_ENABLE_BINARY=OFF" \
    SHERPA_ONNX_MAKE_ARGS="-j12"
RUN pip wheel --no-deps -w /wheels /src && ls -l /wheels

# ---------------------------------------------------------------- models, at pinned revisions
# models.json lists each file with its hash; fetch_models.py refuses a file that does not match.
# One layer per model, so changing the set downloads only what changed. Nothing is fetched at runtime.
FROM python:3.15.2-slim-bookworm AS models
COPY models.json fetch_models.py /src/
RUN python3 /src/fetch_models.py /models phonon-31m-en phonon-voices-en silero-vad
RUN python3 /src/fetch_models.py /models parakeet-unified-en-0.6b
RUN python3 /src/fetch_models.py /models nemotron-speech-streaming-en-0.6b-160ms

# ---------------------------------------------------------------- the service
FROM python:3.15.2-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt /app/
RUN --mount=type=bind,from=sherpa,source=/wheels,target=/wheels \
    pip install --no-cache-dir --root-user-action=ignore -r /app/requirements.txt /wheels/*.whl \
 && useradd --system --home-dir /app --shell /usr/sbin/nologin speech
COPY --from=models /models /models
COPY app /app/app
WORKDIR /app
USER speech
# ORT_DISABLE_TELEMETRY: belt and braces. Neither onnxruntime here has Microsoft's telemetry
# uploader (it arrived in 1.29), and compose.yaml gives this container no route out anyway.
ENV SPEECH_MODELS=/models SPEECH_PORT=8000 ORT_DISABLE_TELEMETRY=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status != 200)"
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${SPEECH_PORT}\" --no-access-log --ws-max-size 1048576"]
