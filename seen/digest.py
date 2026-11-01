"""Weekly digest: a short summary, a phone-widget status file, desktop notifications, scheduling."""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from .analyze import Summary

STALE_AFTER_DAYS = 7
TASK_NAME = "seen-weekly-digest"


def default_output_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "seen"


def data_age_days(summary: Summary, now: datetime | None = None) -> int:
    return max(0, ((now or datetime.now()) - summary.as_of).days)


def headline(summary: Summary) -> str:
    waiting = [f for f in summary.friends if f.unanswered_streak or f.pending_shares]
    if not waiting:
        return "Nobody is waiting on you. Nice."
    first = waiting[0].friend.split()[0]
    if len(waiting) == 1:
        return f"{first} is waiting on you"
    return f"{first} + {len(waiting) - 1} other{'s' * (len(waiting) > 2)} are waiting on you"


def build_status(summary: Summary, now: datetime | None = None, top: int = 5) -> dict:
    """Small JSON the phone widget / Shortcuts automation reads."""
    now = now or datetime.now()
    waiting = [f for f in summary.friends if f.unanswered_streak or f.pending_shares]
    return {
        "generated": now.isoformat(timespec="seconds"),
        "as_of": summary.as_of.isoformat(timespec="seconds"),
        "data_age_days": data_age_days(summary, now),
        "headline": headline(summary),
        "waiting_count": len(waiting),
        "pending_count": summary.total_pending,
        "shares_total": summary.total_shares,
        "shares_answered": summary.total_acknowledged,
        "top": [
            {
                "friend": f.friend,
                "source": f.source,
                "pending": len(f.pending_shares),
                "waiting_messages": f.unanswered_streak,
                "waiting_days": (summary.as_of - f.waiting_since).days if f.waiting_since else None,
                "nudge": f.nudge,
                "opener": f.opener,
                "links": [s.share_url for s in f.pending_shares[-3:]],
            }
            for f in waiting[:top]
        ],
    }


def to_digest_text(summary: Summary, now: datetime | None = None) -> str:
    status = build_status(summary, now, top=3)
    lines = [f"seen weekly · {status['headline']}"]
    if status["shares_total"]:
        lines.append(
            f"  {status['shares_total']} things shared with you in {summary.days} days, "
            f"{status['shares_answered']} answered, {status['pending_count']} still unanswered."
        )
    for friend in status["top"]:
        lines.append(f"  • {friend['nudge']}")
    if status["data_age_days"] >= STALE_AFTER_DAYS:
        lines.append(
            f"  ! Your newest message is {status['data_age_days']} days old. Download a fresh export "
            "(iMessage via iPhone backup refreshes on its own)."
        )
    return "\n".join(lines)


def write_outputs(summary: Summary, out_dir: Path, html: str, now: datetime | None = None) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "html": out_dir / "digest.html",
        "status": out_dir / "status.json",
    }
    paths["html"].write_text(html, encoding="utf-8")
    paths["status"].write_text(
        json.dumps(build_status(summary, now), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return paths


# ---------------------------------------------------------------- notifications

def _ps_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def windows_toast_script(title: str, body: str, open_path: Path | None = None) -> str:
    # Single-quoted XML attributes: the XML sits inside a double-quoted PowerShell string.
    launch = f" activationType='protocol' launch='{open_path.resolve().as_uri()}'" if open_path else ""
    return f"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape({_ps_quote(title)})
$body = [System.Security.SecurityElement]::Escape({_ps_quote(body)})
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast{launch}><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$appId = '{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
"""


def notify(title: str, body: str, open_path: Path | None = None) -> bool:
    """Best-effort desktop notification. Returns True if a notifier ran."""
    try:
        if sys.platform == "win32":
            command = ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                       windows_toast_script(title, body, open_path)]
        elif sys.platform == "darwin":
            script = f"display notification {json.dumps(body)} with title {json.dumps(title)}"
            command = ["osascript", "-e", script]
        else:
            command = ["notify-send", title, body]
        return subprocess.run(command, capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ---------------------------------------------------------------- scheduling

def launcher_path(out_dir: Path) -> Path:
    return out_dir / ("run-digest.cmd" if sys.platform == "win32" else "run-digest.sh")


def write_launcher(out_dir: Path, digest_args: list[str]) -> Path:
    """A tiny script the scheduler runs (Windows /TR is limited to 261 characters)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    python = sys.executable
    if sys.platform == "win32":
        windowless = Path(sys.executable).with_name("pythonw.exe")
        if windowless.exists():
            python = str(windowless)  # no console window flashing up every week
    if sys.platform == "win32":
        launcher = launcher_path(out_dir)
        args = subprocess.list2cmdline([python, "-m", "seen", "digest", *digest_args])
        launcher.write_text(f"@echo off\r\n{args}\r\n", encoding="utf-8")
    else:
        launcher = launcher_path(out_dir)
        args = shlex.join([python, "-m", "seen", "digest", *digest_args])
        launcher.write_text(f"#!/bin/sh\n{args}\n", encoding="utf-8")
        launcher.chmod(0o755)
    return launcher


def schedule_command(launcher: Path, day: str, time: str) -> list[str] | str:
    """Return the scheduler command (list for Windows schtasks, crontab line otherwise)."""
    if sys.platform == "win32":
        return ["schtasks", "/Create", "/F", "/SC", "WEEKLY", "/D", day.upper()[:3],
                "/ST", time, "/TN", TASK_NAME, "/TR", f'"{launcher}"']
    days = {"SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6}
    hour, minute = time.split(":")
    return f"{int(minute)} {int(hour)} * * {days[day.upper()[:3]]} {shlex.quote(str(launcher))}  # {TASK_NAME}"


def unschedule_command() -> list[str] | str:
    if sys.platform == "win32":
        return ["schtasks", "/Delete", "/F", "/TN", TASK_NAME]
    return f"crontab -l | grep -v {TASK_NAME} | crontab -"
