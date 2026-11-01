"""Core data structures shared by all parsers and the analyzer."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlparse

URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)

# Domain fragment -> human label used in the report.
SHARE_KINDS = [
    ("instagram.com/reel", "reel"),
    ("instagram.com/p/", "post"),
    ("instagram.com/stories", "story"),
    ("instagram.com", "Instagram link"),
    ("tiktok.com", "TikTok"),
    ("youtube.com/shorts", "Short"),
    ("youtube.com", "YouTube video"),
    ("youtu.be", "YouTube video"),
    ("x.com", "tweet"),
    ("twitter.com", "tweet"),
    ("facebook.com", "Facebook post"),
    ("fb.watch", "Facebook video"),
    ("reddit.com", "Reddit post"),
    ("spotify.com", "song"),
]


def classify_share(url: str) -> str:
    lowered = url.lower()
    for fragment, label in SHARE_KINDS:
        if fragment in lowered:
            return label
    host = urlparse(url).netloc.removeprefix("www.")
    return f"link ({host})" if host else "link"


def first_url(text: str) -> str | None:
    match = URL_RE.search(text or "")
    return match.group(0).rstrip(").,!?") if match else None


@dataclass
class Message:
    sender: str
    timestamp: datetime
    text: str = ""
    share_url: str | None = None
    # (actor, emoji) pairs, e.g. ("Me", "❤")
    reactions: list[tuple[str, str]] = field(default_factory=list)

    @property
    def is_share(self) -> bool:
        return self.share_url is not None

    @property
    def share_kind(self) -> str:
        return classify_share(self.share_url) if self.share_url else ""


@dataclass
class Thread:
    thread_id: str
    title: str
    source: str  # "instagram", "messenger", "whatsapp", "telegram"
    participants: set[str] = field(default_factory=set)
    messages: list[Message] = field(default_factory=list)

    def finalize(self) -> "Thread":
        self.messages.sort(key=lambda m: m.timestamp)
        self.participants |= {m.sender for m in self.messages if m.sender}
        return self

    @property
    def is_group(self) -> bool:
        return len(self.participants) > 2
