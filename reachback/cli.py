"""Command-line entry point:  reachback scan <export...>   |   reachback demo"""
from __future__ import annotations

import argparse
import sys
import tempfile
import webbrowser
from datetime import datetime
from pathlib import Path

from . import __version__
from .analyze import Settings, analyze
from .parsers import load
from .report import to_html, to_json, to_text
from .sample import write_sample_export


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="reachback",
        description="See which friends you've been leaving on read. Runs locally on your own chat exports.",
    )
    parser.add_argument("--version", action="version", version=f"reachback {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p):
        p.add_argument("--days", type=int, default=30, help="look-back window in days (default 30)")
        p.add_argument("--reply-window-hours", type=int, default=48,
                       help="a reply within this many hours counts as responding (default 48)")
        p.add_argument("--include-groups", action="store_true", help="also analyse group chats")
        p.add_argument("--top", type=int, default=15, help="rows to show in the terminal")
        p.add_argument("--html", metavar="FILE", help="write an HTML report here")
        p.add_argument("--json", metavar="FILE", help="write machine-readable results here")
        p.add_argument("--open", action="store_true", help="open the HTML report in your browser")
        p.add_argument("--as-of", help="analyse as if today were YYYY-MM-DD (default: newest message)")

    scan = sub.add_parser("scan", help="analyse one or more exports (folders, .zip, .txt, result.json)")
    scan.add_argument("paths", nargs="+")
    scan.add_argument("--me", action="append", default=[],
                      help="your display name in the export (repeatable; auto-detected if omitted)")
    scan.add_argument("--whatsapp-date-order", choices=["auto", "dmy", "mdy", "ymd"], default="auto")
    add_common(scan)

    demo = sub.add_parser("demo", help="run on generated sample data")
    add_common(demo)
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = _build_parser().parse_args(argv)

    if args.command == "demo":
        root = Path(tempfile.mkdtemp(prefix="reachback_demo_"))
        threads = load(write_sample_export(root))
        me = None
    else:
        threads = []
        for path in args.paths:
            try:
                threads += load(path, args.whatsapp_date_order)
            except (FileNotFoundError, ValueError) as error:
                print(f"skipping {path}: {error}", file=sys.stderr)
        me = set(args.me) or None

    if not threads:
        print("No conversations found. See README for how to export your chats.", file=sys.stderr)
        return 1

    settings = Settings(
        days=args.days,
        reply_window_hours=args.reply_window_hours,
        include_groups=args.include_groups,
        as_of=datetime.fromisoformat(args.as_of) if args.as_of else None,
    )
    summary = analyze(threads, me=me, settings=settings)
    print(to_text(summary, top=args.top))

    if args.json:
        Path(args.json).write_text(to_json(summary), encoding="utf-8")
        print(f"\n  JSON  → {Path(args.json).resolve()}")
    html_path = args.html or (Path(tempfile.gettempdir()) / "reachback.html" if args.open else None)
    if html_path:
        Path(html_path).write_text(to_html(summary), encoding="utf-8")
        print(f"  HTML  → {Path(html_path).resolve()}")
        if args.open:
            webbrowser.open(Path(html_path).resolve().as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
