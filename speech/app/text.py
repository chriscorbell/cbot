"""Text fixes applied before Phonon speaks it."""
import re

# An em dash, an en dash, or two or more hyphens standing in for one, with any spaces around it.
_DASH = re.compile(r"(\s*)(—|–|-{2,})(\s*)")
_CLOSERS = "\"'”’)]}"
_STOPS = ".!?…"


def pause_dashes(text: str) -> str:
    """Dashes as the pauses they are. ptts's normalizer drops em and en dashes (it turns `;`, `:`
    and brackets into commas and `…` into a period), so Phonon ran straight through them. A dash
    between words becomes a comma, the pause ptts gives a semicolon; one that ends the text or a
    quote ("Wait—") becomes `…`, which ptts reads as a full stop. A dash with no spaces between two
    digits ("3–5"), or an en dash with none between two words ("Paris–London"), is a range or a
    pairing and becomes a hyphen, which ptts keeps (it reads years like "2020-2024" as "2020 to
    2024"). An em dash with no spaces between words ("inbox—nothing") is still a pause."""

    def sub(m: re.Match) -> str:
        lead, dash, trail = m.groups()
        before, after = text[: m.start()], text[m.end():]
        prev, nxt = before[-1:], after[:1]
        if not before.strip():
            return ""  # a dash that opens the text
        if not lead and not trail and ((prev.isdigit() and nxt.isdigit()) or (dash == "\u2013" and prev.isalnum() and nxt.isalnum())):
            return "-"
        rest = after.lstrip()
        if not rest or rest[0] in _CLOSERS:
            return "…"
        if rest[0] in _STOPS or rest[0] in ",;:":
            return ""  # punctuation follows; it makes the pause
        if prev in ",;:":
            return " "  # "yes,— no": the comma is there already
        return ", "

    return _DASH.sub(sub, text)
