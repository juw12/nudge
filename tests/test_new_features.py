import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

from nudge import contacts, digest
from nudge.analyze import Settings, analyze
from nudge.parsers import load
from nudge.parsers.imessage import APPLE_EPOCH, SMS_DB_BACKUP_NAME, decode_attributed_body

AS_OF = datetime(2026, 10, 31, 22, 0)


def _typedstream(text: str) -> bytes:
    """Minimal NSAttributedString blob like macOS 13+ writes into message.attributedBody."""
    payload = text.encode("utf-8")
    length = bytes([len(payload)]) if len(payload) < 0x80 else b"\x81" + len(payload).to_bytes(2, "little")
    return (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
            b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+"
            + length + payload + b"\x86\x84\x02iI\x01")


def _apple_ns(moment: datetime) -> int:
    return int((moment.timestamp() - APPLE_EPOCH) * 1e9)


def _make_messages_db(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript("""
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, style INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
            handle_id INTEGER, date INTEGER, is_from_me INTEGER,
            associated_message_type INTEGER, associated_message_guid TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        INSERT INTO handle VALUES (1, '+1 (555) 010-2233');
        INSERT INTO chat VALUES (1, '+15550102233', '', 45);
        INSERT INTO chat_handle_join VALUES (1, 1);
    """)
    t0 = AS_OF - timedelta(days=3)
    rows = [
        # (guid, text, attributedBody, handle, date, from_me, assoc_type, assoc_guid)
        ("A", "https://www.instagram.com/reel/AAA/", None, 1, t0, 0, 0, None),
        ("B", None, _typedstream("haha so true"), 0, t0 + timedelta(hours=1), 1, 0, None),
        ("C", "https://www.tiktok.com/@x/video/2", None, 1, t0 + timedelta(days=1), 0, 0, None),
        ("D", None, None, 0, t0 + timedelta(days=1, hours=5), 1, 2003, "p:0/C"),  # 😂 tapback on C
        ("E", None, _typedstream("u alive?"), 1, t0 + timedelta(days=2), 0, 0, None),
    ]
    for index, (guid, text, body, handle, moment, from_me, assoc_type, assoc_guid) in enumerate(rows, 1):
        connection.execute(
            "INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?)",
            (index, guid, text, body, handle, _apple_ns(moment), from_me, assoc_type, assoc_guid),
        )
        connection.execute("INSERT INTO chat_message_join VALUES (1, ?)", (index,))
    connection.commit()
    connection.close()


def test_attributed_body_decoding():
    assert decode_attributed_body(_typedstream("hello 👋")) == "hello 👋"
    long_text = "x" * 300
    assert decode_attributed_body(_typedstream(long_text)) == long_text
    assert decode_attributed_body(None) == ""


def test_imessage_db_and_iphone_backup_layout(tmp_path):
    backup = tmp_path / "00008110-ABC"
    database = backup / SMS_DB_BACKUP_NAME[:2] / SMS_DB_BACKUP_NAME
    database.parent.mkdir(parents=True)
    _make_messages_db(database)

    [thread] = load(backup)  # backup folder is auto-detected
    assert thread.source == "imessage"
    assert thread.me == "Me"
    texts = [m.text for m in thread.messages]
    assert "haha so true" in texts and "u alive?" in texts
    assert len(thread.messages) == 4  # tapback row is folded into a reaction, not a message
    tiktok = next(m for m in thread.messages if m.share_kind == "TikTok")
    assert tiktok.reactions == [("Me", "😂")]

    vcf = tmp_path / "contacts.vcf"
    vcf.write_text("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana Lopez\r\nTEL;TYPE=CELL:555-010-2233\r\nEND:VCARD\r\n",
                   encoding="utf-8")
    contacts.apply([thread], contacts.load_vcf(vcf))

    summary = analyze([thread], settings=Settings(as_of=AS_OF))
    [ana] = summary.friends
    assert ana.friend == "Ana Lopez"
    assert (ana.shares_received, ana.shares_replied, ana.shares_reacted_only) == (2, 1, 1)
    assert ana.unanswered_streak == 2  # TikTok (only tapped) + 'u alive?'


def test_digest_status_and_text():
    from nudge.sample import write_sample_export
    import tempfile

    threads = load(write_sample_export(Path(tempfile.mkdtemp()), as_of=AS_OF))
    summary = analyze(threads, settings=Settings(as_of=AS_OF, days=7))
    status = digest.build_status(summary, now=AS_OF + timedelta(days=10))
    assert status["waiting_count"] >= 1
    assert status["headline"].endswith("waiting on you")
    assert status["data_age_days"] == 10
    assert json.dumps(status, ensure_ascii=False)
    text = digest.to_digest_text(summary, now=AS_OF + timedelta(days=10))
    assert "days old" in text  # stale-data warning


def test_schedule_command_shapes(tmp_path):
    launcher = digest.write_launcher(tmp_path, ["C:/exports/ig.zip", "--notify"])
    assert launcher.exists()
    command = digest.schedule_command(launcher, "sun", "19:00")
    if sys.platform == "win32":
        assert command[:2] == ["schtasks", "/Create"]
        assert "SUN" in command and "19:00" in command
    else:
        assert command.startswith("0 19 * * 0 ")
