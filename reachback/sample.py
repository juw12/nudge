"""Generate a fake Instagram export so `reachback demo` works with no real data."""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

ME = "Sam Rivera"
FRIENDS = {
    # name: (shares per week from them, chance you reply to a share, chance you start chats)
    "Maya Chen": (6, 0.15, 0.1),
    "Jordan Okafor": (3, 0.7, 0.5),
    "Priya Nair": (1, 0.0, 0.0),
    "Leo Martins": (4, 0.4, 0.2),
    "Grandma Rose": (0.5, 0.2, 0.05),
}


def _encode(text: str) -> str:
    """Mimic Instagram's latin-1 mojibake encoding."""
    return text.encode("utf-8").decode("latin-1")


def write_sample_export(root: Path, seed: int = 7, as_of: datetime | None = None) -> Path:
    rng = random.Random(seed)
    as_of = as_of or datetime(2026, 10, 31, 22, 0)
    inbox = root / "your_instagram_activity" / "messages" / "inbox"

    for name, (shares_per_week, reply_chance, start_chance) in FRIENDS.items():
        messages = []
        moment = as_of - timedelta(days=45)
        while moment < as_of - timedelta(hours=3):
            moment += timedelta(hours=rng.expovariate(shares_per_week / (7 * 24)) + 1)
            if moment >= as_of:
                break
            reel_id = "".join(rng.choices("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789", k=11))
            share_message = {
                "sender_name": _encode(name),
                "timestamp_ms": int(moment.timestamp() * 1000),
                "share": {"link": f"https://www.instagram.com/reel/{reel_id}/"},
            }
            if rng.random() < reply_chance:
                reply_time = moment + timedelta(minutes=rng.randint(5, 600))
                messages.append({
                    "sender_name": _encode(ME),
                    "timestamp_ms": int(reply_time.timestamp() * 1000),
                    "content": _encode(rng.choice(["LMAOO 😂", "this is literally you", "no way", "stoppp"])),
                })
            elif rng.random() < 0.15:
                share_message["reactions"] = [{"reaction": _encode("😂"), "actor": _encode(ME)}]
            messages.append(share_message)

            if rng.random() < start_chance:
                hello_time = moment + timedelta(days=rng.uniform(0.5, 2))
                if hello_time < as_of:
                    messages.append({
                        "sender_name": _encode(ME),
                        "timestamp_ms": int(hello_time.timestamp() * 1000),
                        "content": _encode("hey how's your week going?"),
                    })

        # A couple of plain unanswered texts at the end for the neglected friends.
        if reply_chance < 0.3:
            for hours_back, text in [(30, "hellooo? 👀"), (6, "miss you, let's catch up soon")]:
                messages.append({
                    "sender_name": _encode(name),
                    "timestamp_ms": int((as_of - timedelta(hours=hours_back)).timestamp() * 1000),
                    "content": _encode(text),
                })

        messages = [m for m in messages if m["timestamp_ms"] <= as_of.timestamp() * 1000]
        messages.sort(key=lambda m: m["timestamp_ms"], reverse=True)  # Instagram stores newest first
        folder = inbox / f"{name.split()[0].lower()}_{rng.randint(10**9, 10**10)}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "message_1.json").write_text(json.dumps({
            "participants": [{"name": _encode(name)}, {"name": _encode(ME)}],
            "messages": messages,
            "title": _encode(name),
        }, indent=1), encoding="utf-8")
    return root
