#!/usr/bin/env python3
"""Download models listed in models.json at their pinned revisions and check every file's hash.

    python3 fetch_models.py DEST ID [ID ...]

Each model lands in DEST/<id>/. Hugging Face files come from resolve/<revision>/, so a later push to
the repo never changes what is downloaded. Large files are checked against their LFS sha256, small
ones against their git blob sha1. A file already present with the right hash is kept.
"""
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

MANIFEST = Path(__file__).with_name("models.json")


def digest(path: Path, spec: str) -> bool:
    kind, want = spec.split(":", 1)
    if kind == "sha256":
        h = hashlib.sha256()
    elif kind == "git":
        h = hashlib.sha1(b"blob %d\0" % path.stat().st_size)
    else:
        raise ValueError(f"unknown hash kind {kind}")
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest() == want


def fetch(url: str, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".part")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r, tmp.open("wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            tmp.replace(dest)
            return
        except OSError as e:
            print(f"  retry {attempt + 1} after {e}", file=sys.stderr)
            time.sleep(2 + attempt * 3)
    raise SystemExit(f"could not download {url}")


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    dest_root = Path(sys.argv[1])
    manifest = json.loads(MANIFEST.read_text())
    for model_id in sys.argv[2:]:
        m = manifest[model_id]
        out = dest_root / model_id
        for name, spec in m["files"].items():
            path = out / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and digest(path, spec):
                continue
            url = m["url"] if "url" in m else f"https://huggingface.co/{m['repo']}/resolve/{m['revision']}/{name}"
            print(f"{model_id}: {name}", flush=True)
            fetch(url, path)
            if not digest(path, spec):
                raise SystemExit(f"{model_id}/{name}: hash mismatch, expected {spec}")
        meta = {k: v for k, v in m.items() if k != "files"}
        (out / "MODEL.json").write_text(json.dumps({"id": model_id, **meta}, indent=2) + "\n")


if __name__ == "__main__":
    main()
