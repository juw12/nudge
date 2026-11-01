"""Turn parsed threads into a per-friend "you've been leaving them on read" report."""
from __future__ import annotations

import math
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .models import Message, Thread


@dataclass
class Settings:
    days: int = 30                 # look-back window
    reply_window_hours: int = 48   # a reply within this time counts as "responded"
    conversation_gap_hours: int = 8  # silence that makes the next message a new "start"
    include_groups: bool = False
    as_of: datetime | None = None  # defaults to newest message in the data


@dataclass
class FriendReport:
    friend: str
    source: str
    thread_title: str
    shares_received: int = 0
    shares_replied: int = 0
    shares_reacted_only: int = 0
    pending_shares: list[Message] = field(default_factory=list)
    messages_from_them: int = 0
    messages_from_me: int = 0
    their_starts: int = 0
    my_starts: int = 0
    unanswered_streak: int = 0
    waiting_since: datetime | None = None
    last_from_me: datetime | None = None
    score: float = 0.0
    nudge: str = ""
    opener: str = ""

    @property
    def shares_missed(self) -> int:
        return self.shares_received - self.shares_replied - self.shares_reacted_only

    @property
    def response_rate(self) -> float | None:
        if not self.shares_received:
            return None
        return (self.shares_replied + self.shares_reacted_only) / self.shares_received


@dataclass
class Summary:
    as_of: datetime
    days: int
    me: set[str]
    friends: list[FriendReport]
    warnings: list[str] = field(default_factory=list)

    @property
    def total_shares(self) -> int:
        return sum(f.shares_received for f in self.friends)

    @property
    def total_acknowledged(self) -> int:
        return sum(f.shares_replied + f.shares_reacted_only for f in self.friends)

    @property
    def total_pending(self) -> int:
        return sum(len(f.pending_shares) for f in self.friends)

    @property
    def people_waiting(self) -> int:
        return sum(1 for f in self.friends if f.unanswered_streak)


def detect_me(threads: list[Thread], warnings: list[str] | None = None) -> set[str]:
    """You are the sender who appears in the most threads, per platform."""
    by_source: dict[str, Counter] = defaultdict(Counter)
    for thread in threads:
        for sender in {m.sender for m in thread.messages}:
            by_source[thread.source][sender] += 1
    me = set()
    for source, counter in by_source.items():
        ranked = counter.most_common(2)
        if not ranked:
            continue
        me.add(ranked[0][0])
        if warnings is not None and len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            warnings.append(
                f"Couldn't tell which {source} name is you (guessed '{ranked[0][0]}'). "
                "Pass --me \"Your Name\" to be sure."
            )
    return me


def analyze(threads: list[Thread], me: set[str] | None = None, settings: Settings | None = None) -> Summary:
    settings = settings or Settings()
    warnings: list[str] = []
    if not me:
        known = {t.me for t in threads if t.me}
        unknown = [t for t in threads if not t.me]
        me = known | (detect_me(unknown, warnings) if unknown else set())
    else:
        me = set(me) | {t.me for t in threads if t.me}
    me_folded = {name.casefold() for name in me}

    def is_me(name: str) -> bool:
        return name.casefold() in me_folded

    all_times = [m.timestamp for t in threads for m in t.messages]
    as_of = settings.as_of or (max(all_times) if all_times else datetime.now())

    reports = []
    for thread in threads:
        if thread.is_group and not settings.include_groups:
            continue
        others = [p for p in thread.participants if not is_me(p) and p != "__group__"]
        if not others:
            continue
        friend = thread.title if thread.is_group else others[0]
        report = _analyze_thread(thread, friend, is_me, as_of, settings)
        if report.messages_from_them:
            reports.append(report)

    reports.sort(key=lambda r: r.score, reverse=True)
    return Summary(as_of=as_of, days=settings.days, me=me, friends=reports, warnings=warnings)


def _analyze_thread(thread, friend, is_me, as_of, settings) -> FriendReport:
    window_start = as_of - timedelta(days=settings.days)
    reply_window = timedelta(hours=settings.reply_window_hours)
    gap = timedelta(hours=settings.conversation_gap_hours)

    report = FriendReport(friend=friend, source=thread.source, thread_title=thread.title)
    my_times = [m.timestamp for m in thread.messages if is_me(m.sender)]
    report.last_from_me = my_times[-1] if my_times else None

    previous_time = None
    for message in thread.messages:
        mine = is_me(message.sender)
        in_window = window_start <= message.timestamp <= as_of

        if in_window:
            starts_conversation = previous_time is None or message.timestamp - previous_time >= gap
            if mine:
                report.messages_from_me += 1
                report.my_starts += starts_conversation
            else:
                report.messages_from_them += 1
                report.their_starts += starts_conversation
                if message.is_share:
                    _score_share(report, message, my_times, reply_window, is_me)
        previous_time = message.timestamp

    # Messages from them at the end of the thread that you never answered.
    for message in reversed(thread.messages):
        if is_me(message.sender):
            break
        report.unanswered_streak += 1
        report.waiting_since = message.timestamp

    report.score = _priority(report, as_of)
    report.nudge, report.opener = _suggest(report, as_of)
    return report


def _score_share(report, share, my_times, reply_window, is_me) -> None:
    report.shares_received += 1
    next_index = bisect_right(my_times, share.timestamp)
    next_reply = my_times[next_index] if next_index < len(my_times) else None

    if next_reply is not None and next_reply - share.timestamp <= reply_window:
        report.shares_replied += 1
    elif any(is_me(actor) for actor, _ in share.reactions):
        report.shares_reacted_only += 1
    elif next_reply is None:
        # You haven't said anything in this chat since they sent it.
        report.pending_shares.append(share)


def _priority(report: FriendReport, as_of: datetime) -> float:
    """Higher = more overdue. Every term is explained in the README."""
    pending = sum(
        math.exp(-(as_of - s.timestamp).total_seconds() / 86400 / 14)
        for s in report.pending_shares
    )
    waiting = 0.0
    if report.unanswered_streak and report.waiting_since:
        waiting_days = (as_of - report.waiting_since).total_seconds() / 86400
        waiting = 1.5 * math.log1p(report.unanswered_streak) * math.exp(-waiting_days / 30)
    imbalance = 0.3 * max(0, report.their_starts - report.my_starts)
    neglect = (report.shares_missed / report.shares_received) if report.shares_received >= 3 else 0.0
    return round(pending + waiting + imbalance + neglect, 2)


def _pick(seed_text: str, options: list[str]) -> str:
    """Deterministic variety so every friend doesn't get the identical opener."""
    return options[sum(map(ord, seed_text)) % len(options)]


def _days_ago(moment: datetime | None, as_of: datetime) -> int | None:
    return None if moment is None else max(0, (as_of - moment).days)


def _suggest(report: FriendReport, as_of: datetime) -> tuple[str, str]:
    name = report.friend.split()[0] if report.friend else "them"
    waiting_days = _days_ago(report.waiting_since, as_of)
    pending = len(report.pending_shares)

    if pending:
        newest = report.pending_shares[-1]
        nudge = (
            f"{name} sent you {pending} thing{'s' * (pending > 1)} you never answered. "
            f"Watch the newest {newest.share_kind} and say what it reminded you of. "
            "Something more than 😂."
        )
        opener = _pick(report.friend, [
            f"ok finally caught up on what you sent 😅 the latest {newest.share_kind} is SO us. how've you been?",
            f"just binged everything you sent me lol. that last {newest.share_kind} 💀 when are we hanging out?",
            f"sorry I ghosted your {newest.share_kind}s. watched them all now, you have elite taste. how are you actually doing?",
        ])
    elif report.unanswered_streak and waiting_days is not None:
        nudge = (
            f"{name} has been waiting {waiting_days} day{'s' * (waiting_days != 1)} "
            f"({report.unanswered_streak} unanswered message{'s' * (report.unanswered_streak > 1)}). "
            "Even a two-line reply counts."
        )
        opener = "sorry I went quiet, got lost in my phone 🙈 what's new with you?"
    elif report.their_starts > report.my_starts:
        nudge = (
            f"{name} starts most of your chats ({report.their_starts} vs {report.my_starts}). "
            "Next time, you start it."
        )
        opener = "saw something today that made me think of you. free for a call this week?"
    else:
        nudge = f"You and {name} are in a good rhythm. Keep it up."
        opener = ""
    return nudge, opener
