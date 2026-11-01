"""Terminal, JSON and self-contained HTML output."""
from __future__ import annotations

import html
import json
from datetime import datetime

from .analyze import FriendReport, Summary


def _days(moment: datetime | None, as_of: datetime) -> str:
    if moment is None:
        return "never"
    days = (as_of - moment).days
    return "today" if days <= 0 else f"{days}d ago"


def _rate(friend: FriendReport) -> str:
    rate = friend.response_rate
    return "-" if rate is None else f"{rate:.0%}"


def to_text(summary: Summary, top: int = 15) -> str:
    lines = [
        f"reachback · last {summary.days} days up to {summary.as_of:%Y-%m-%d} · you = {', '.join(sorted(summary.me))}",
        "",
        f"  Friends sent you {summary.total_shares} reels/posts/links. "
        f"You responded to {summary.total_acknowledged} "
        f"({summary.total_acknowledged / summary.total_shares:.0%})." if summary.total_shares
        else "  No shared reels/links found in this window.",
        f"  {summary.total_pending} still unanswered · {summary.people_waiting} people waiting on a reply.",
        "",
        f"  {'#':>2}  {'friend':<22} {'app':<10} {'shared':>6} {'you resp.':>9} {'pending':>7} {'waiting':>8} {'you last':>9}",
    ]
    for index, friend in enumerate(summary.friends[:top], 1):
        waiting = f"{friend.unanswered_streak} msg" if friend.unanswered_streak else "-"
        lines.append(
            f"  {index:>2}  {friend.friend[:22]:<22} {friend.source:<10} {friend.shares_received:>6} "
            f"{_rate(friend):>9} {len(friend.pending_shares):>7} {waiting:>8} "
            f"{_days(friend.last_from_me, summary.as_of):>9}"
        )
    lines.append("")
    for warning in summary.warnings:
        lines.append(f"  ! {warning}")
    lines.append("  Reach back today:")
    for friend in [f for f in summary.friends if f.score > 0][:3]:
        lines.append(f"   → {friend.nudge}")
        if friend.opener:
            lines.append(f"     try: “{friend.opener}”")
    return "\n".join(lines)


def to_json(summary: Summary) -> str:
    payload = {
        "as_of": summary.as_of.isoformat(),
        "days": summary.days,
        "me": sorted(summary.me),
        "friends": [
            {
                "friend": f.friend,
                "source": f.source,
                "score": f.score,
                "shares_received": f.shares_received,
                "shares_replied": f.shares_replied,
                "shares_reacted_only": f.shares_reacted_only,
                "shares_missed": f.shares_missed,
                "pending": [
                    {"url": s.share_url, "kind": s.share_kind, "sent": s.timestamp.isoformat()}
                    for s in f.pending_shares
                ],
                "their_starts": f.their_starts,
                "my_starts": f.my_starts,
                "unanswered_streak": f.unanswered_streak,
                "waiting_since": f.waiting_since.isoformat() if f.waiting_since else None,
                "last_from_me": f.last_from_me.isoformat() if f.last_from_me else None,
                "nudge": f.nudge,
                "opener": f.opener,
            }
            for f in summary.friends
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


CSS = """
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e8e8ea;margin:0;padding:32px;}
main{max-width:820px;margin:auto} h1{font-size:28px;margin:0 0 4px} .muted{color:#9aa0aa}
.hero{background:linear-gradient(135deg,#ff5f6d,#ffc371);color:#1b1b1b;border-radius:18px;padding:22px 26px;margin:20px 0 28px}
.hero b{font-size:34px;display:block}
.card{background:#181b22;border:1px solid #262a33;border-radius:16px;padding:18px 20px;margin:14px 0}
.card h2{font-size:19px;margin:0} .tag{font-size:12px;background:#262a33;border-radius:99px;padding:2px 9px;margin-left:8px;color:#b9bec8}
.stats{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0;font-size:14px} .stats span b{color:#fff}
.nudge{margin:10px 0 6px} .opener{background:#22324a;border-radius:14px 14px 14px 4px;padding:9px 13px;display:inline-block;font-size:14px}
.copy{margin-left:8px;font-size:12px;cursor:pointer;background:none;border:1px solid #3a4150;color:#cfd3da;border-radius:8px;padding:3px 8px}
ul{margin:8px 0 0;padding-left:18px;font-size:14px} a{color:#7cb7ff}
.bar{height:6px;background:#262a33;border-radius:9px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:#4ade80}
"""


def to_html(summary: Summary, top: int = 30) -> str:
    esc = html.escape
    acknowledged_pct = (
        f"{summary.total_acknowledged / summary.total_shares:.0%}" if summary.total_shares else "-"
    )
    cards = []
    for friend in summary.friends[:top]:
        rate = friend.response_rate
        pending_items = "".join(
            f'<li><a href="{esc(s.share_url)}" target="_blank">{esc(s.share_kind)}</a> '
            f'<span class="muted">· {_days(s.timestamp, summary.as_of)}</span></li>'
            for s in reversed(friend.pending_shares[-8:])
        )
        more = len(friend.pending_shares) - 8
        if more > 0:
            pending_items += f'<li class="muted">+{more} more</li>'
        opener = (
            f'<div><span class="opener">{esc(friend.opener)}</span>'
            f'<button class="copy" onclick="navigator.clipboard.writeText(this.dataset.t)" '
            f'data-t="{esc(friend.opener)}">copy</button></div>'
            if friend.opener else ""
        )
        cards.append(f"""
<div class="card">
  <h2>{esc(friend.friend)}<span class="tag">{esc(friend.source)}</span></h2>
  <div class="stats">
    <span>shared with you <b>{friend.shares_received}</b></span>
    <span>you responded <b>{_rate(friend)}</b></span>
    <span>they started <b>{friend.their_starts}</b> chats · you <b>{friend.my_starts}</b></span>
    <span>you last wrote <b>{_days(friend.last_from_me, summary.as_of)}</b></span>
  </div>
  <div class="bar"><i style="width:{0 if rate is None else round(rate * 100)}%"></i></div>
  <p class="nudge">{esc(friend.nudge)}</p>
  {opener}
  {f'<ul>{pending_items}</ul>' if pending_items else ''}
</div>""")

    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>reachback · who's waiting on you</title><style>{CSS}</style></head><body><main>
<h1>Who's waiting on you</h1>
<div class="muted">Last {summary.days} days up to {summary.as_of:%d %b %Y} · generated locally, nothing uploaded</div>
<div class="hero">
  <b>{summary.total_shares} things shared with you · {acknowledged_pct} answered</b>
  {summary.total_pending} reels/links still unanswered · {summary.people_waiting} people waiting on a reply.<br>
  Every one of those was someone thinking of you.
</div>
{''.join(cards) or '<p>No 1:1 conversations found in this window.</p>'}
<p class="muted">Close this tab and message one person before opening a feed.</p>
</main></body></html>"""
