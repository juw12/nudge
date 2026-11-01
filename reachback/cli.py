"""Command-line entry point.

  reachback scan     <export...>   full report
  reachback digest   <export...>   short weekly summary + status.json for the phone widget
  reachback schedule <export...>   run the digest automatically every week
  reachback demo                   try it on generated data
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import webbrowser
from datetime import datetime
from pathlib import Path

from . import __version__, contacts, digest
from .analyze import Settings, Summary, analyze
from .parsers import IMESSAGE_KEYWORD, load
from .report import to_html, to_json, to_text
from .sample import write_sample_export


def _add_analysis_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--days", type=int, default=30, help="look-back window in days (default 30)")
    parser.add_argument("--reply-window-hours", type=int, default=48,
                        help="a reply within this many hours counts as responding (default 48)")
    parser.add_argument("--include-groups", action="store_true", help="also analyse group chats")
    parser.add_argument("--as-of", help="analyse as if today were YYYY-MM-DD (default: newest message)")


def _add_source_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("paths", nargs="+",
                        help="export folders, .zip, .txt, result.json, chat.db, iPhone backup folder, or 'imessage'")
    parser.add_argument("--me", action="append", default=[],
                        help="your display name in the export (repeatable; auto-detected if omitted)")
    parser.add_argument("--contacts", metavar="VCF", help="contacts .vcf to turn phone numbers into names")
    parser.add_argument("--whatsapp-date-order", choices=["auto", "dmy", "mdy", "ymd"], default="auto")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="reachback",
        description="See which friends you've been leaving on read. Runs locally on your own chat exports.",
    )
    parser.add_argument("--version", action="version", version=f"reachback {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="full report for one or more exports")
    _add_source_options(scan)
    _add_analysis_options(scan)
    scan.add_argument("--top", type=int, default=15, help="rows to show in the terminal")
    scan.add_argument("--html", metavar="FILE", help="write an HTML report here")
    scan.add_argument("--json", metavar="FILE", help="write machine-readable results here")
    scan.add_argument("--status", metavar="FILE", help="write the small status.json used by the phone widget")
    scan.add_argument("--open", action="store_true", help="open the HTML report in your browser")

    digest_cmd = sub.add_parser("digest", help="short weekly summary, status.json for the widget, notification")
    _add_source_options(digest_cmd)
    _add_analysis_options(digest_cmd)
    digest_cmd.set_defaults(days=7)
    digest_cmd.add_argument("--out", metavar="DIR", help=f"output folder (default {digest.default_output_dir()})")
    digest_cmd.add_argument("--notify", action="store_true", help="show a desktop notification")
    digest_cmd.add_argument("--open", action="store_true", help="open the digest page in your browser")

    schedule = sub.add_parser("schedule", help="run the digest automatically every week")
    _add_source_options(schedule)
    _add_analysis_options(schedule)
    schedule.set_defaults(days=7)
    schedule.add_argument("--day", default="SUN", help="MON..SUN (default SUN)")
    schedule.add_argument("--time", default="19:00", help="24h HH:MM (default 19:00)")
    schedule.add_argument("--out", metavar="DIR", help="digest output folder (point it at a cloud folder for the widget)")
    schedule.add_argument("--dry-run", action="store_true", help="show what would be scheduled without doing it")

    unschedule = sub.add_parser("unschedule", help="remove the weekly digest")
    unschedule.add_argument("--dry-run", action="store_true")

    demo = sub.add_parser("demo", help="run on generated sample data")
    _add_analysis_options(demo)
    demo.add_argument("--top", type=int, default=15)
    demo.add_argument("--html", metavar="FILE")
    demo.add_argument("--json", metavar="FILE")
    demo.add_argument("--status", metavar="FILE")
    demo.add_argument("--open", action="store_true")
    return parser


def _load_threads(args) -> list:
    threads = []
    for path in args.paths:
        try:
            threads += load(path, args.whatsapp_date_order)
        except (FileNotFoundError, ValueError) as error:
            print(f"skipping {path}: {error}", file=sys.stderr)
    if getattr(args, "contacts", None):
        contacts.apply(threads, contacts.load_vcf(args.contacts))
    return threads


def _settings(args) -> Settings:
    return Settings(
        days=args.days,
        reply_window_hours=args.reply_window_hours,
        include_groups=args.include_groups,
        as_of=datetime.fromisoformat(args.as_of) if args.as_of else None,
    )


def _write_status(summary: Summary, path: str) -> None:
    import json

    Path(path).write_text(json.dumps(digest.build_status(summary), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  status → {Path(path).resolve()}")


def _report(summary: Summary, args) -> None:
    print(to_text(summary, top=args.top))
    if args.json:
        Path(args.json).write_text(to_json(summary), encoding="utf-8")
        print(f"\n  JSON  → {Path(args.json).resolve()}")
    if args.status:
        _write_status(summary, args.status)
    html_path = args.html or (Path(tempfile.gettempdir()) / "reachback.html" if args.open else None)
    if html_path:
        Path(html_path).write_text(to_html(summary), encoding="utf-8")
        print(f"  HTML  → {Path(html_path).resolve()}")
        if args.open:
            webbrowser.open(Path(html_path).resolve().as_uri())


def _absolute_source_args(args) -> list[str]:
    """Rebuild digest arguments with absolute paths so the scheduler can run from anywhere."""
    result = []
    for path in args.paths:
        result.append(path if path.lower() == IMESSAGE_KEYWORD else str(Path(path).expanduser().resolve()))
    for name in args.me:
        result += ["--me", name]
    if args.contacts:
        result += ["--contacts", str(Path(args.contacts).expanduser().resolve())]
    if args.whatsapp_date_order != "auto":
        result += ["--whatsapp-date-order", args.whatsapp_date_order]
    result += ["--days", str(args.days), "--reply-window-hours", str(args.reply_window_hours)]
    if args.include_groups:
        result.append("--include-groups")
    return result


def _run_schedule(args) -> int:
    out_dir = Path(args.out).expanduser().resolve() if args.out else digest.default_output_dir()
    digest_args = _absolute_source_args(args) + ["--out", str(out_dir), "--notify"]
    if args.dry_run:
        launcher = digest.launcher_path(out_dir)
    else:
        launcher = digest.write_launcher(out_dir, digest_args)
    command = digest.schedule_command(launcher, args.day, args.time)

    if isinstance(command, str):  # macOS / Linux: crontab line
        print("Add this line with `crontab -e`:\n")
        print(f"  {command}")
        return 0
    print("Scheduler command:\n  " + subprocess.list2cmdline(command))
    print("Digest command:\n  reachback digest " + subprocess.list2cmdline(digest_args))
    if args.dry_run:
        print("\n(dry run, nothing scheduled)")
        return 0
    result = subprocess.run(command, capture_output=True, text=True)
    print(result.stdout or result.stderr)
    return result.returncode


def _run_unschedule(args) -> int:
    command = digest.unschedule_command()
    if isinstance(command, str):
        print(f"Run:  {command}")
        return 0
    if args.dry_run:
        print(subprocess.list2cmdline(command))
        return 0
    return subprocess.run(command).returncode


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure") and sys.stdout:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = _build_parser().parse_args(argv)

    if args.command == "unschedule":
        return _run_unschedule(args)
    if args.command == "schedule":
        return _run_schedule(args)

    if args.command == "demo":
        root = Path(tempfile.mkdtemp(prefix="reachback_demo_"))
        threads = load(write_sample_export(root))
        me = None
    else:
        threads = _load_threads(args)
        me = set(args.me) or None

    if not threads:
        print("No conversations found. See README for how to export your chats.", file=sys.stderr)
        return 1

    summary = analyze(threads, me=me, settings=_settings(args))

    if args.command == "digest":
        out_dir = Path(args.out).expanduser() if args.out else digest.default_output_dir()
        paths = digest.write_outputs(summary, out_dir, to_html(summary))
        print(digest.to_digest_text(summary))
        print(f"\n  page   → {paths['html'].resolve()}\n  status → {paths['status'].resolve()}")
        if args.notify:
            status = digest.build_status(summary)
            body = status["top"][0]["nudge"] if status["top"] else "Everyone's heard back from you this week."
            digest.notify(f"reachback: {status['headline']}", body, paths["html"])
        if args.open:
            webbrowser.open(paths["html"].resolve().as_uri())
        return 0

    _report(summary, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
