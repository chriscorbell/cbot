#!/bin/sh
# Starts Zyphra's ZONOS3 server for one call at a time: the GPU (Vulkan) when the container has a
# render node, else the CPU. ZONOS3_DEVICE=cpu or gpu overrides the choice.
set -e
device="${ZONOS3_DEVICE:-auto}"
if [ "$device" = auto ]; then
  if ls /dev/dri/renderD* >/dev/null 2>&1; then device=gpu; else device=cpu; fi
fi
echo "zonos3-start: running on the $device"
# One decode lane and two backbone slots: a call speaks one sentence at a time, and a voice preview
# may overlap it. The backbone looks for zac-keep2.gguf next to itself.
exec zonos3-server /models/backbone-ptq.gguf "--$device" --zac-threads 1 --batch 2 \
  --tts-default-voices-dir /voices --host 0.0.0.0 --port 1919
