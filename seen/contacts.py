"""Optional: replace phone numbers / emails with real names using a contacts .vcf export."""
from __future__ import annotations

import re
from pathlib import Path

from .models import Thread


def _phone_key(value: str) -> str | None:
    digits = re.sub(r"\D", "", value)
    return digits[-9:] if len(digits) >= 7 else None  # last 9 digits ignores country codes


def _keys(value: str) -> list[str]:
    value = value.strip()
    keys = []
    if "@" in value:
        keys.append(value.casefold())
    phone = _phone_key(value)
    if phone:
        keys.append(phone)
    return keys


def load_vcf(path: str | Path) -> dict[str, str]:
    """Map normalised phone/email -> display name."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"\r?\n[ \t]", "", text)  # unfold folded lines
    mapping: dict[str, str] = {}
    for card in re.split(r"(?im)^BEGIN:VCARD", text):
        name_match = re.search(r"(?im)^FN[^:]*:(.+)$", card)
        if not name_match:
            continue
        name = name_match.group(1).strip()
        for value in re.findall(r"(?im)^(?:item\d+\.)?(?:TEL|EMAIL)[^:]*:(.+)$", card):
            for key in _keys(value):
                mapping.setdefault(key, name)
    return mapping


def resolve(value: str, mapping: dict[str, str]) -> str:
    for key in _keys(value):
        if key in mapping:
            return mapping[key]
    return value


def apply(threads: list[Thread], mapping: dict[str, str]) -> None:
    if not mapping:
        return
    for thread in threads:
        for message in thread.messages:
            message.sender = resolve(message.sender, mapping)
            message.reactions = [(resolve(actor, mapping), emoji) for actor, emoji in message.reactions]
        thread.participants = {resolve(p, mapping) for p in thread.participants}
        thread.title = resolve(thread.title, mapping)
