# ZONOS3-Mini text-to-speech (Zyphra; weights Apache 2.0, code MIT) through Zyphra's ggml server,
# on the GPU with Vulkan when the container gets a render node (such as an integrated AMD GPU),
# otherwise on the CPU. The speech service is its only client (speech/app/zonos3.py); compose.yaml
# and deploy/speech.compose.yaml run it on the speech service's internal network, with no route out.

# ---------------------------------------------------------------- build: Zyphra's server, pinned
FROM ubuntu:26.04 AS build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates pkg-config cargo rustc libvulkan-dev glslc spirv-headers \
 && rm -rf /var/lib/apt/lists/*
ARG ZONOS3_COMMIT=96d9e0ec1e39083ed336ac78f24e3dbc93721c0f
# ggml and the text normalizer (Rust, built by CMake through cargo) are submodules; the aligner is not needed.
RUN git init -q /src && cd /src \
 && git fetch -q --depth 1 https://github.com/Zyphra/ZONOS3-Mini "${ZONOS3_COMMIT}" && git checkout -q FETCH_HEAD \
 && git submodule update -q --init --depth 1 servers/ggml/ggml third_party/zyphra-textnorm
WORKDIR /src/servers/ggml
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON -DBUILD_SHARED_LIBS=OFF \
 && cmake --build build -j 12 --target zonos3-server
# The ten English voices: each clip with its shipped speaker embedding (the server uses the embedding).
RUN mkdir /voices && cp /src/assets/default_voices/English/*.embedding.npy /src/assets/default_voices/English/*.wav \
      /src/assets/default_voices/English/*.mp3 /src/assets/default_voices/English/*.ogg /voices/

# ---------------------------------------------------------------- models, at a pinned revision
# The quantized backbone (Q4_0 experts, Q8_0 mixers) and the fast keep2_plain decoder, checked by hash.
FROM ubuntu:26.04 AS models
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG HF_REVISION=d2d142a86b1e6aeb4252679673c86ecd86177bf8
RUN mkdir /models && cd /models \
 && curl -fsSL -o backbone-ptq.gguf "https://huggingface.co/Zyphra/ZONOS3-Mini/resolve/${HF_REVISION}/gguf/backbone-ptq.gguf" \
 && echo "66fceb6d73a8c30bde80249e4112bb308380ab7f3384fa11c8e4048115e4ceec  backbone-ptq.gguf" | sha256sum -c --quiet
RUN cd /models \
 && curl -fsSL -o zac-keep2.gguf "https://huggingface.co/Zyphra/ZONOS3-Mini/resolve/${HF_REVISION}/gguf/zac-keep2.gguf" \
 && echo "834e5b70b88294afc3c702a478487e0664dcc6b574c16fc6167d72444aabeafd  zac-keep2.gguf" | sha256sum -c --quiet

# ---------------------------------------------------------------- the server
FROM ubuntu:26.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers libgomp1 curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/servers/ggml/build/zonos3-server /usr/local/bin/
COPY --from=build /voices /voices
COPY --from=models /models /models
COPY start.sh /usr/local/bin/zonos3-start
# Root inside the container: the render node's group differs from host to host. The container has no
# route out and only the speech service talks to it.
ENV ZONOS3_DEVICE=auto ZAC_THREADS=4
EXPOSE 1919
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS -o /dev/null http://127.0.0.1:1919/v2/capabilities
CMD ["zonos3-start"]
