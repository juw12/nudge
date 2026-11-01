"""iMessage / SMS from Apple's Messages database.

Works with:
  * macOS:   ~/Library/Messages/chat.db  (needs Full Disk Access for your terminal)
  * Windows: an *unencrypted* iPhone backup made by iTunes / Apple Devices.
             The database is the file 3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28 inside the
             backup folder. Pass the backup folder or the keyword "imessage".

The database is copied to a temp folder first so a running Messages app is never touched.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from ..models import Message, Thread, first_url

SMS_DB_BACKUP_NAME = "3d0d7e5fb2ce288813306e4d4636395e047a3d28"
APPLE_EPOCH = 978307200  # 2001-01-01 in Unix seconds
ME = "Me"
TAPBACK_EMOJI = {0: "❤️", 1: "👍", 2: "👎", 3: "😂", 4: "‼️", 5: "❓", 6: "👍"}


class EncryptedBackupError(ValueError):
    pass


def default_locations() -> list[Path]:
    """Places the Messages database usually lives, newest first."""
    candidates: list[Path] = []
    home = Path.home()
    if sys.platform == "darwin":
        candidates.append(home / "Library" / "Messages" / "chat.db")
        backup_roots = [home / "Library" / "Application Support" / "MobileSync" / "Backup"]
    else:
        backup_roots = [
            Path(os.environ.get("APPDATA", home)) / "Apple Computer" / "MobileSync" / "Backup",
            home / "Apple" / "MobileSync" / "Backup",  # Microsoft Store iTunes / Apple Devices
        ]
    backups = []
    for root in backup_roots:
        if root.is_dir():
            backups += [p for p in root.iterdir() if p.is_dir()]
    backups.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    candidates += backups
    return [c for c in candidates if c.exists()]


def find_database(path: Path) -> Path | None:
    if path.is_file():
        return path if _is_messages_db(path) else None
    nested = path / SMS_DB_BACKUP_NAME[:2] / SMS_DB_BACKUP_NAME
    if nested.is_file():
        if not _is_messages_db(nested):
            raise EncryptedBackupError(
                f"{path} looks like an encrypted iPhone backup. Turn off 'Encrypt local backup' "
                "in iTunes / Apple Devices, back up again, then retry."
            )
        return nested
    flat = path / SMS_DB_BACKUP_NAME
    if flat.is_file() and _is_messages_db(flat):
        return flat
    return None


def _is_messages_db(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            if handle.read(16) != b"SQLite format 3\x00":
                return False
        with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {"message", "handle", "chat", "chat_message_join"} <= tables
    except (OSError, sqlite3.DatabaseError):
        return False


def decode_attributed_body(blob: bytes | None) -> str:
    """Pull the plain text out of an NSAttributedString 'typedstream' blob (macOS 13+ / iOS 16+)."""
    if not blob:
        return ""
    marker = blob.find(b"NSString")
    if marker == -1:
        return ""
    data = blob[marker + len(b"NSString"):]
    plus = data.find(b"+")
    if plus == -1 or plus + 1 >= len(data):
        return ""
    data = data[plus + 1:]
    length, start = data[0], 1
    if length == 0x81:
        length, start = int.from_bytes(data[1:3], "little"), 3
    elif length == 0x82:
        length, start = int.from_bytes(data[1:4], "little"), 4
    return data[start:start + length].decode("utf-8", errors="replace")


def _apple_time(value: int | None) -> datetime | None:
    if not value:
        return None
    seconds = value / 1e9 if value > 1e11 else value  # nanoseconds since iOS 11 / High Sierra
    return datetime.fromtimestamp(seconds + APPLE_EPOCH)


def _guid_from_association(value: str | None) -> str | None:
    """'p:0/ABC-123' or 'bp:ABC-123' -> 'ABC-123'."""
    if not value:
        return None
    return value.split("/", 1)[1] if "/" in value else value.split(":", 1)[-1]


def _columns(connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def parse(path: Path) -> list[Thread]:
    database = find_database(path)
    if database is None:
        raise ValueError(f"No Messages database found at {path}")

    with tempfile.TemporaryDirectory(prefix="seen_imessage_") as temp_dir:
        copy = Path(temp_dir) / "chat.db"
        shutil.copy2(database, copy)
        for suffix in ("-wal", "-shm"):
            sidecar = database.with_name(database.name + suffix)
            if sidecar.exists():
                shutil.copy2(sidecar, copy.with_name(copy.name + suffix))
        connection = sqlite3.connect(copy)
        try:
            return _read_threads(connection)
        finally:
            connection.close()


def _read_threads(connection: sqlite3.Connection) -> list[Thread]:
    message_columns = _columns(connection, "message")

    def optional(column: str) -> str:
        return f"m.{column}" if column in message_columns else "NULL"

    rows = connection.execute(f"""
        SELECT m.guid, m.text, {optional('attributedBody')}, m.date, m.is_from_me,
               {optional('associated_message_type')}, {optional('associated_message_guid')},
               h.id, c.ROWID, c.chat_identifier, c.display_name, c.style
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        ORDER BY m.date
    """).fetchall()

    participants: dict[int, set[str]] = {}
    for chat_id, handle in connection.execute(
        "SELECT chj.chat_id, h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id"
    ):
        participants.setdefault(chat_id, set()).add(handle)

    threads: dict[int, Thread] = {}
    by_guid: dict[str, Message] = {}
    for (guid, text, attributed, date, from_me, assoc_type, assoc_guid,
         handle, chat_id, chat_identifier, display_name, style) in rows:
        timestamp = _apple_time(date)
        if timestamp is None:
            continue
        thread = threads.get(chat_id)
        if thread is None:
            members = participants.get(chat_id, set())
            if style == 43 and len(members) < 2:
                members = members | {"__group__"}  # style 43 = group chat
            thread = Thread(
                thread_id=f"imessage:{chat_identifier}",
                title=display_name or chat_identifier,
                source="imessage",
                participants=set(members) | {ME},
                me=ME,
            )
            threads[chat_id] = thread

        sender = ME if from_me else (handle or chat_identifier)
        assoc_type = assoc_type or 0

        if 2000 <= assoc_type < 4000:  # tapback added (2xxx) or removed (3xxx)
            target = by_guid.get(_guid_from_association(assoc_guid) or "")
            if target is not None:
                emoji = TAPBACK_EMOJI.get(assoc_type % 1000, "👍")
                if assoc_type < 3000:
                    target.reactions.append((sender, emoji))
                else:
                    target.reactions = [r for r in target.reactions if r[0] != sender]
            continue

        body = text or decode_attributed_body(attributed)
        body = body.replace("\ufffc", "").strip()  # object-replacement char = attachment
        message = Message(sender=sender, timestamp=timestamp, text=body, share_url=first_url(body))
        thread.messages.append(message)
        if guid:
            by_guid[guid] = message

    return [t.finalize() for t in threads.values() if t.messages]
