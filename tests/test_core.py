import json
from datetime import datetime, timedelta
from pathlib import Path

from nudge.analyze import Settings, analyze
from nudge.parsers import load
from nudge.parsers.instagram import fix_text
from nudge.report import to_html, to_json, to_text
from nudge.sample import ME, write_sample_export

AS_OF = datetime(2026, 10, 31, 22, 0)


def _ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


def _write_instagram_thread(root: Path, friend: str, messages: list[dict]) -> None:
    folder = root / "messages" / "inbox" / f"{friend.lower()}_1"
    folder.mkdir(parents=True)
    (folder / "message_1.json").write_text(json.dumps({
        "participants": [{"name": friend}, {"name": "Me"}],
        "messages": messages,
        "title": friend,
    }), encoding="utf-8")


def test_mojibake_is_repaired():
    assert fix_text("ð\x9f\x98\x82") == "😂"
    assert fix_text("plain") == "plain"


def test_share_reply_reaction_and_pending(tmp_path):
    t0 = AS_OF - timedelta(days=5)
    _write_instagram_thread(tmp_path, "Ana", [
        # replied within 48h
        {"sender_name": "Ana", "timestamp_ms": _ms(t0), "share": {"link": "https://www.instagram.com/reel/A/"}},
        {"sender_name": "Me", "timestamp_ms": _ms(t0 + timedelta(hours=1)), "content": "haha"},
        # reacted only
        {"sender_name": "Ana", "timestamp_ms": _ms(t0 + timedelta(days=3)),
         "share": {"link": "https://www.instagram.com/reel/B/"},
         "reactions": [{"reaction": "❤", "actor": "Me"}]},
        # never answered -> pending
        {"sender_name": "Ana", "timestamp_ms": _ms(t0 + timedelta(days=4)),
         "share": {"link": "https://www.tiktok.com/@x/video/1"}},
        {"sender_name": "Ana", "timestamp_ms": _ms(t0 + timedelta(days=4, hours=1)), "content": "hello??"},
    ])
    _write_instagram_thread(tmp_path, "Ben", [
        {"sender_name": "Ben", "timestamp_ms": _ms(t0), "content": "yo"},
        {"sender_name": "Me", "timestamp_ms": _ms(t0 + timedelta(hours=2)), "content": "yo!"},
    ])

    threads = load(tmp_path)
    summary = analyze(threads, settings=Settings(as_of=AS_OF))
    assert summary.me == {"Me"}

    ana = next(f for f in summary.friends if f.friend == "Ana")
    assert ana.shares_received == 3
    assert ana.shares_replied == 1
    assert ana.shares_reacted_only == 1
    assert [s.share_kind for s in ana.pending_shares] == ["TikTok"]
    assert ana.unanswered_streak == 3  # reacted reel, TikTok, "hello??"
    assert summary.friends[0].friend == "Ana"  # most overdue ranks first


def test_whatsapp_android_and_ios_formats(tmp_path):
    android = tmp_path / "WhatsApp Chat with Kai.txt"
    android.write_text(
        "12/31/23, 9:15 PM - Messages and calls are end-to-end encrypted.\n"
        "12/31/23, 9:15 PM - Kai: look https://www.instagram.com/reel/XYZ/\n"
        "12/31/23, 9:20 PM - Sam: lol\n"
        "1/2/24, 8:00 AM - Kai: line one\nline two\n",
        encoding="utf-8",
    )
    ios = tmp_path / "ios.txt"
    ios.write_text(
        "[31/12/2023, 21:15:03] Kai: https://youtube.com/shorts/abc\n"
        "[31/12/2023, 21:16:00] Sam: haha\n",
        encoding="utf-8",
    )
    [android_thread] = load(android)
    assert android_thread.title == "Kai"
    assert android_thread.messages[0].share_kind == "reel"
    assert android_thread.messages[0].timestamp == datetime(2023, 12, 31, 21, 15)
    assert android_thread.messages[-1].text == "line one\nline two"

    [ios_thread] = load(ios)
    assert ios_thread.messages[0].share_kind == "Short"
    assert ios_thread.messages[0].timestamp == datetime(2023, 12, 31, 21, 15, 3)


def test_telegram_result_json(tmp_path):
    path = tmp_path / "result.json"
    path.write_text(json.dumps({"chats": {"list": [{
        "name": "Nia", "type": "personal_chat", "id": 1,
        "messages": [
            {"type": "message", "date": "2026-10-30T10:00:00", "from": "Nia",
             "text": [{"type": "link", "text": "https://vm.tiktok.com/abc"}]},
            {"type": "message", "date": "2026-10-30T11:00:00", "from": "Me", "text": "ha"},
        ],
    }]}}), encoding="utf-8")
    [thread] = load(path)
    assert thread.messages[0].share_kind == "TikTok"


def test_demo_pipeline_end_to_end(tmp_path):
    threads = load(write_sample_export(tmp_path, as_of=AS_OF))
    summary = analyze(threads, settings=Settings(as_of=AS_OF))
    assert summary.me == {ME}
    assert len(summary.friends) == 5
    assert summary.total_shares > 0
    assert "Who's waiting on you" in to_html(summary)
    assert json.loads(to_json(summary))["friends"]
    assert "Reach back today" in to_text(summary)
