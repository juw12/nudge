"""Auto-detect and load chat exports from files, folders or zip archives."""
from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

from ..models import Thread
from . import instagram, telegram, whatsapp

_temp_dirs: list[tempfile.TemporaryDirectory] = []


def _unzip(path: Path) -> Path:
    temp_dir = tempfile.TemporaryDirectory(prefix="reachback_")
    _temp_dirs.append(temp_dir)  # keep alive for the process lifetime
    with zipfile.ZipFile(path) as archive:
        archive.extractall(temp_dir.name)
    return Path(temp_dir.name)


def load(path: str | Path, whatsapp_date_order: str = "auto") -> list[Thread]:
    path = Path(path).expanduser()
    if not path.exists():
        raise FileNotFoundError(path)
    if path.is_file() and path.suffix.lower() == ".zip":
        path = _unzip(path)

    if path.is_file():
        if telegram.looks_like_export(path):
            return telegram.parse(path)
        if whatsapp.looks_like_export(path):
            return whatsapp.parse(path, whatsapp_date_order)
        raise ValueError(f"Unrecognised export file: {path}")

    threads: list[Thread] = []
    if instagram.looks_like_export(path):
        threads += instagram.parse(path)
    for result_json in path.rglob("result*.json"):
        threads += telegram.parse(result_json)
    for txt in path.rglob("*.txt"):
        if whatsapp.looks_like_export(txt):
            threads += whatsapp.parse(txt, whatsapp_date_order)
    return threads
