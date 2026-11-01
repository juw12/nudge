"""WhatsApp "Export chat" .txt files (Android and iOS styles)."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from ..models import Message, Thread, first_url

TIME = r"\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?"
DATE = r"\d{1,4}[./-]\d{1,2}[./-]\d{1,4}"
LINE_PATTERNS = [
    # iOS:     [31/12/2023, 21:15:03] Alex: hey
    re.compile(rf"^\[(?P<date>{DATE}),?\s+(?P<time>{TIME})\]\s(?P<sender>[^:]+?):\s?(?P<text>.*)$"),
    # Android: 12/31/23, 9:15 PM - Alex: hey
    re.compile(rf"^(?P<date>{DATE}),?\s+(?P<time>{TIME})\s[-–]\s(?P<sender>[^:]+?):\s?(?P<text>.*)$"),
]
INVISIBLE = dict.fromkeys(map(ord, "\u200e\u200f\u202a\u202c\ufeff"), None)


def looks_like_export(path: Path) -> bool:
    if path.suffix.lower() != ".txt":
        return False
    try:
        with path.open(encoding="utf-8", errors="ignore") as handle:
            head = [handle.readline().translate(INVISIBLE) for _ in range(20)]
    except OSError:
        return False
    return any(p.match(line.strip()) for line in head for p in LINE_PATTERNS)


def _detect_date_order(dates: list[str], preference: str) -> str:
    if preference in ("dmy", "mdy", "ymd"):
        return preference
    first_parts, second_parts = set(), set()
    for value in dates:
        parts = re.split(r"[./-]", value)
        if len(parts[0]) == 4:
            return "ymd"
        first_parts.add(int(parts[0]))
        second_parts.add(int(parts[1]))
    if max(first_parts, default=0) > 12:
        return "dmy"
    if max(second_parts, default=0) > 12:
        return "mdy"
    return "dmy"  # ambiguous; override with --whatsapp-date-order


def _to_datetime(date_text: str, time_text: str, order: str) -> datetime | None:
    parts = [int(p) for p in re.split(r"[./-]", date_text)]
    if order == "dmy":
        day, month, year = parts
    elif order == "mdy":
        month, day, year = parts
    else:
        year, month, day = parts
    if year < 100:
        year += 2000

    clean_time = time_text.replace("\u202f", " ").replace(".", ":").upper()
    clean_time = re.sub(r"\s+", "", clean_time).replace("A:M:", "AM").replace("P:M:", "PM")
    clean_time = clean_time.replace("A:M", "AM").replace("P:M", "PM")
    for fmt in ("%I:%M:%S%p", "%I:%M%p", "%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(clean_time, fmt)
            return datetime(year, month, day, parsed.hour, parsed.minute, parsed.second)
        except ValueError:
            continue
    return None


def parse(path: Path, date_order: str = "auto") -> list[Thread]:
    raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    entries: list[dict] = []
    for line in raw_lines:
        line = line.translate(INVISIBLE).replace("\u202f", " ")
        match = next((m for p in LINE_PATTERNS if (m := p.match(line.strip()))), None)
        if match:
            entries.append(match.groupdict())
        elif entries:
            entries[-1]["text"] += "\n" + line  # multi-line message continuation

    order = _detect_date_order([e["date"] for e in entries], date_order)
    title = path.stem.replace("WhatsApp Chat with ", "").replace("WhatsApp Chat - ", "")
    thread = Thread(thread_id=f"whatsapp:{path.stem}", title=title, source="whatsapp")

    for entry in entries:
        timestamp = _to_datetime(entry["date"], entry["time"], order)
        if timestamp is None:
            continue
        text = entry["text"].strip()
        thread.messages.append(
            Message(
                sender=entry["sender"].strip(),
                timestamp=timestamp,
                text=text,
                share_url=first_url(text),
            )
        )
    return [thread.finalize()] if thread.messages else []
