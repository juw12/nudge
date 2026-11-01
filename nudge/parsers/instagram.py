"""Instagram / Facebook Messenger "Download your information" (JSON format).

Both export DMs as  .../messages/inbox/<thread_folder>/message_1.json
with the same schema. Text is stored as latin-1-escaped UTF-8 (mojibake),
which we repair.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from ..models import Message, Thread, first_url

SYSTEM_PHRASES = (
    "reacted ",
    "liked a message",
    "changed the group",
    "named the group",
    "started a video chat",
    "sent an attachment.",
)


def fix_text(value: str | None) -> str:
    if not value:
        return ""
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def looks_like_export(root: Path) -> bool:
    return any(_message_files(root))


def _message_files(root: Path):
    for path in root.rglob("message_*.json"):
        if "inbox" in path.parts or "message_requests" in path.parts or "messages" in path.parts:
            yield path


def parse(root: Path) -> list[Thread]:
    threads: dict[Path, Thread] = {}
    for path in sorted(_message_files(root)):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if "messages" not in data or "participants" not in data:
            continue

        folder = path.parent
        source = "messenger" if "facebook" in str(path).lower() else "instagram"
        thread = threads.get(folder)
        if thread is None:
            thread = Thread(
                thread_id=f"{source}:{folder.name}",
                title=fix_text(data.get("title")) or folder.name,
                source=source,
                participants={fix_text(p.get("name")) for p in data["participants"]},
            )
            threads[folder] = thread

        for raw in data["messages"]:
            if raw.get("is_unsent"):
                continue
            message = _parse_message(raw)
            if message is not None:
                thread.messages.append(message)

    return [t.finalize() for t in threads.values() if t.messages]


def _parse_message(raw: dict) -> Message | None:
    sender = fix_text(raw.get("sender_name"))
    timestamp_ms = raw.get("timestamp_ms")
    if not sender or timestamp_ms is None:
        return None

    text = fix_text(raw.get("content"))
    share = raw.get("share") or {}
    share_url = share.get("link") or first_url(text)

    # Shared reels sometimes arrive as attachment-only messages without a link.
    if share_url is None and (share.get("share_text") or raw.get("clips")):
        share_url = "https://www.instagram.com/reel/"

    if share_url is None and text.lower().startswith(SYSTEM_PHRASES):
        return None

    reactions = [
        (fix_text(r.get("actor")), fix_text(r.get("reaction")))
        for r in raw.get("reactions", [])
    ]
    return Message(
        sender=sender,
        timestamp=datetime.fromtimestamp(timestamp_ms / 1000),
        text=text or fix_text(share.get("share_text")),
        share_url=share_url,
        reactions=reactions,
    )
