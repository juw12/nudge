"""Auto-detect and load chat exports from files, folders, zip archives or the "imessage" keyword."""
from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

from ..models import Thread
from . import imessage, instagram, telegram, whatsapp

_temp_dirs: list[tempfile.TemporaryDirectory] = []
IMESSAGE_KEYWORD = "imessage"


def _unzip(path: Path) -> Path:
    temp_dir = tempfile.TemporaryDirectory(prefix="seen_")
    _temp_dirs.append(temp_dir)  # keep alive for the process lifetime
    with zipfile.ZipFile(path) as archive:
        archive.extractall(temp_dir.name)
    return Path(temp_dir.name)


def _load_imessage_default() -> list[Thread]:
    for location in imessage.default_locations():
        try:
            if imessage.find_database(location):
                return imessage.parse(location)
        except imessage.EncryptedBackupError:
            raise
    raise FileNotFoundError(
        "No iMessage database found. On Windows, make an unencrypted iPhone backup with "
        "iTunes / Apple Devices first. On macOS, give your terminal Full Disk Access."
    )


def load(path: str | Path, whatsapp_date_order: str = "auto") -> list[Thread]:
    if str(path).strip().lower() == IMESSAGE_KEYWORD:
        return _load_imessage_default()

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
        if imessage.find_database(path):
            return imessage.parse(path)
        raise ValueError(f"Unrecognised export file: {path}")

    if imessage.find_database(path):  # an iPhone backup folder
        return imessage.parse(path)

    threads: list[Thread] = []
    if instagram.looks_like_export(path):
        threads += instagram.parse(path)
    for result_json in path.rglob("result*.json"):
        threads += telegram.parse(result_json)
    for txt in path.rglob("*.txt"):
        if whatsapp.looks_like_export(txt):
            threads += whatsapp.parse(txt, whatsapp_date_order)
    for candidate in list(path.rglob("chat.db")) + list(path.rglob("sms.db")):
        if imessage.find_database(candidate):
            threads += imessage.parse(candidate)
    return threads
