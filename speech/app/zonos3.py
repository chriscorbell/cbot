"""ZONOS3-Mini voices (Zyphra), from the server in the zonos3 container (zonos3/Dockerfile).

The server streams mono float32 PCM at 44.1 kHz. Calls and previews take PCM16 at Phonon's 24 kHz,
so each stream is resampled on its way through. The voices are the ten English voices the server
ships, used through their speaker embeddings (faster than its reference-clip mode).
"""
import asyncio
import logging
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import numpy as np
import soxr

from .audio import to_pcm16

log = logging.getLogger("speech.zonos3")

SOURCE_RATE = 44100

# (file stem on the server, name, gender, locale, description, natural pace). The description says
# what the voice's file name says, its first phrase short enough for a card in the voice picker. A
# voice without a locale is a character voice. The natural pace is UTF-8 bytes of text per second of
# speech without a speaking-rate condition, measured over three sentences and two seeds.
_VOICES = [
    ("Savannah_en-American_F_1", "Savannah", "female", "en-us", "Female voice, American accent", 16.8),
    ("Wyatt_en-American_M_1", "Wyatt", "male", "en-us", "Male voice, American accent", 12.2),
    ("Imogen_en-British_F_1", "Imogen", "female", "en-gb", "Female voice, British accent", 16.4),
    ("Rupert_en-British_M_1", "Rupert", "male", "en-gb", "Male voice, British accent", 17.0),
    ("Cillian_en-Irish_M_1", "Cillian", "male", "en-ie", "Male voice, Irish accent", 18.9),
    ("Jett_en-energetic_M_1", "Jett", "male", None, "Energetic male voice", 15.7),
    ("Thaddeus_en-announcervoice_M_1", "Thaddeus", "male", None, "Announcer-style male voice", 13.0),
    ("Willow_en-asrm_F_1", "Willow", "female", None, "Soft ASMR female voice", 12.1),
    ("Sakura_en-anime_F_1", "Sakura", "female", None, "Anime-style female voice", 14.2),
    ("Morgana_en-witch_F_1", "Morgana", "female", None, "Witch, a female character voice", 12.1),
]
DEFAULT_VOICE = "zonos3-savannah"
# The speaking-rate condition comes out about 9% faster than asked: requests from 12 to 20 bytes/s
# measured 13.3 to 21.6 over three voices.
RATE_GAIN = 1.09
# After the server can't be reached, requests skip it for this long, so a call doesn't wait out a
# connection attempt on every sentence.
BACKOFF_S = 30


class Zonos3Error(RuntimeError):
    pass


class Zonos3:
    def __init__(self, url: str, out_rate: int) -> None:
        self.url = url.rstrip("/")
        self.out_rate = out_rate
        self.client = httpx.AsyncClient(base_url=self.url, timeout=httpx.Timeout(30.0, connect=1.0))
        self.voices = [
            {
                "id": f"zonos3-{name.lower()}", "name": name, "gender": gender, "locale": locale, "age": None,
                "character": locale is None, "description": f"{desc}. ZONOS3-Mini.", "engine": "zonos3",
            }
            for _, name, gender, locale, desc, _ in _VOICES
        ]
        self.voice_ids = {v["id"] for v in self.voices}
        self.default_voice = DEFAULT_VOICE
        self._stem = {f"zonos3-{name.lower()}": stem for stem, name, *_ in _VOICES}
        self._pace = {f"zonos3-{name.lower()}": pace for _, name, *_, pace in _VOICES}
        # Voice id -> the server's speaker id, once the server has answered.
        self._speakers: dict[str, str] = {}
        self._down_until = 0.0

    @property
    def ready(self) -> bool:
        return bool(self._speakers)

    async def connect(self) -> None:
        """Learns the server's speaker ids, retrying until it answers (it loads its models after start)."""
        tries = 0
        while not self._speakers:
            try:
                r = await self.client.get("/v2/speakers")
                r.raise_for_status()
                d = r.json()
                by_stem = {Path(s["original_name"]).stem: s["id"] for s in (d if isinstance(d, list) else d.get("speakers", []))}
                speakers = {vid: by_stem[stem] for vid, stem in self._stem.items() if stem in by_stem}
                missing = sorted(set(self._stem) - set(speakers))
                if missing:
                    log.warning("ZONOS3 server lacks %s", ", ".join(missing))
                self._speakers = speakers
                log.warning("ZONOS3: %d voices at %s", len(speakers), self.url)
            except Exception as e:  # not up yet
                tries += 1
                if tries == 1:
                    log.warning("ZONOS3 not answering yet at %s: %s", self.url, e)
                await asyncio.sleep(5)

    async def stream(self, text: str, voice: str, speed: float) -> AsyncIterator[bytes]:
        """PCM16 at `out_rate` as the server generates it. Raises Zonos3Error before the first chunk
        if the server can't take the request. Leaving the iterator early closes the request."""
        speaker = self._speakers.get(voice)
        if not speaker:
            raise Zonos3Error("the ZONOS3 server has not answered yet")
        if time.monotonic() < self._down_until:
            raise Zonos3Error("the ZONOS3 server was not reachable a moment ago")
        body: dict = {"text": text, "stream": True, "speaker_embedding_id": speaker, "speaker_mode": "embedding"}
        if abs(speed - 1.0) > 0.005:
            body["condition_values"] = {"speaking_rate": round(self._pace[voice] * speed / RATE_GAIN, 2)}
        rs = soxr.ResampleStream(SOURCE_RATE, self.out_rate, 1, dtype="float32", quality="HQ")
        rest = b""
        try:
            async with self.client.stream("POST", "/v2/generate", json=body) as r:
                if r.status_code != 200:
                    raise Zonos3Error(f"ZONOS3 answered HTTP {r.status_code}: {(await r.aread())[:200]!r}")
                async for chunk in r.aiter_raw():
                    data = rest + chunk
                    n = len(data) // 4 * 4
                    rest = data[n:]
                    if n:
                        y = rs.resample_chunk(np.frombuffer(data[:n], "<f4"))
                        if y.size:
                            yield to_pcm16(y)
        except httpx.TransportError as e:
            if isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout)):
                self._down_until = time.monotonic() + BACKOFF_S
            raise Zonos3Error(f"ZONOS3: {e!r}") from e
        except httpx.HTTPError as e:
            raise Zonos3Error(f"ZONOS3: {e!r}") from e
        y = rs.resample_chunk(np.zeros(0, np.float32), last=True)
        if y.size:
            yield to_pcm16(y)

    async def health(self) -> dict:
        return {"url": self.url, "ready": self.ready and time.monotonic() >= self._down_until, "voices": len(self._speakers)}

    async def close(self) -> None:
        await self.client.aclose()
