"""Telegram Desktop "Export chat history" in machine-readable JSON (result.json)."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from ..models import Message, Thread, first_url


def looks_like_export(path: Path) -> bool:
    return path.suffix.lower() == ".json" and path.name.startswith("result")


def _flatten_text(value) -> tuple[str, str | None]:
    """Telegram text is either a string or a list of strings / entity dicts."""
    if isinstance(value, str):
        return value, first_url(value)
    pieces, link = [], None
    for item in value or []:
        if isinstance(item, str):
            pieces.append(item)
            continue
        pieces.append(item.get("text", ""))
        if link is None and item.get("type") in ("link", "text_link"):
            link = item.get("href") or item.get("text")
    text = "".join(pieces)
    return text, link or first_url(text)


def _parse_chat(chat: dict) -> Thread | None:
    thread = Thread(
        thread_id=f"telegram:{chat.get('id', chat.get('name'))}",
        title=chat.get("name") or "Telegram chat",
        source="telegram",
    )
    for raw in chat.get("messages", []):
        if raw.get("type") != "message" or not raw.get("from"):
            continue
        text, link = _flatten_text(raw.get("text"))
        reactions = []
        for reaction in raw.get("reactions", []) or []:
            for recent in reaction.get("recent", []) or []:
                reactions.append((recent.get("from", ""), reaction.get("emoji", "")))
        thread.messages.append(
            Message(
                sender=raw["from"],
                timestamp=datetime.fromisoformat(raw["date"]),
                text=text,
                share_url=link,
                reactions=reactions,
            )
        )
    if chat.get("type", "personal_chat") not in ("personal_chat", "private_group", "private_supergroup"):
        return None
    if chat.get("type") in ("private_group", "private_supergroup"):
        thread.participants.add("__group__")  # force group flag
    return thread.finalize() if thread.messages else None


def parse(path: Path) -> list[Thread]:
    data = json.loads(path.read_text(encoding="utf-8"))
    chats = data["chats"]["list"] if "chats" in data else [data]
    return [t for chat in chats if (t := _parse_chat(chat))]
