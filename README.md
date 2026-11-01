# reachback 💌

**Your friends keep sending you reels. You keep scrolling past them.**

`reachback` reads your own chat exports (Instagram, Messenger, WhatsApp, Telegram) and shows you
who has been reaching out while you weren't really there. You get a short, kind to-do list for
your friendships:

```
  Friends sent you 54 reels/posts/links. You responded to 36 (67%).
  12 still unanswered · 4 people waiting on a reply.

   #  friend           app        shared you resp. pending  waiting  you last
   1  Maya Chen        instagram      27       52%       8   12 msg   10d ago
   2  Priya Nair       instagram       3        0%       3    9 msg     never
   ...
  Reach back today:
   → Maya sent you 8 things you never answered. Watch the newest reel and say what it
     reminded you of. Something more than 😂.
     try: "just binged everything you sent me lol. that last reel 💀 when are we hanging out?"
```

It also writes a self-contained HTML page ("Who's waiting on you") with clickable links to every
unanswered reel and a copy button for the opener.

## Why

Tech keeps getting better at connecting us, but people feel more disconnected than ever. A reel
sent in a DM is often a small *"I thought of you."* It gets buried under the same infinite feed it
came from. Existing tools don't cover this:

| Project | What it does | What's missing |
|---|---|---|
| [Monica](https://github.com/monicahq/monica) (~25k ★) | Personal CRM, reminders to call people | Manual data entry; never sees who actually messaged you |
| PingCRM | AI follow-ups for professional networking | Built for contacts and leads, not friends |
| Scrolless and other blockers | Block Reels and Shorts | Cut the scrolling but don't point you back to people |

reachback measures one thing: **attention people gave you that you never returned.**

## Privacy

* 100% local. No network calls, no accounts, no telemetry. Pure Python standard library.
* It only reads exports **you** download from your own accounts.
* There's no scraping and no unofficial APIs, so it doesn't break any platform's terms.

## Install

```bash
git clone https://github.com/<you>/reachback && cd reachback
pip install .          # or run in place with: python -m reachback ...
reachback demo --open  # try it on fake data first
```

Requires Python 3.10+.

## Get your data

| App | How to export | Pass to reachback |
|---|---|---|
| Instagram | Settings → Accounts Center → Your information and permissions → Download your information → **Messages**, format **JSON** | the `.zip` or unzipped folder |
| Messenger | Same flow under Facebook, format **JSON** | the `.zip` or folder |
| WhatsApp | Open a chat → ⋮ / contact name → **Export chat** → *Without media* | each `.txt` (or a folder of them) |
| Telegram | Telegram Desktop → Settings → Advanced → **Export Telegram data** → *Machine-readable JSON* | `result.json` |

```bash
reachback scan ~/Downloads/instagram-export.zip "~/Downloads/WhatsApp Chat with Maya.txt" \
    --me "Sam Rivera" --days 30 --html report.html --open
```

`--me` is optional for Instagram, Messenger and Telegram, where you're auto-detected as the person in
the most threads. It's **needed for a single WhatsApp chat**, because both people appear exactly once.
You can repeat it if your name differs between apps.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 30 | Look-back window |
| `--reply-window-hours` | 48 | A reply within this time counts as responding to a share |
| `--include-groups` | off | Analyse group chats too (1:1 only by default) |
| `--as-of YYYY-MM-DD` | newest message | Pretend "today" is this date |
| `--whatsapp-date-order` | auto | `dmy` / `mdy` / `ymd` if auto-detection guesses wrong |
| `--json FILE` | | Machine-readable output for widgets, bots or dashboards |

## How it decides

For every reel, post, TikTok, Short or link a friend sends you in the window:

* **Responded:** you sent a message in that chat within `--reply-window-hours`.
* **Reacted only:** you only left an emoji reaction (Instagram, Messenger, Telegram).
* **Pending:** you haven't written anything in that chat since. These go on the catch-up list.

Each friend gets a priority score (higher = more overdue):

\[
\text{score} = \sum_{\text{pending}} e^{-\text{age}_\text{days}/14}
\;+\; 1.5\,\ln(1+\text{streak})\,e^{-\text{wait}_\text{days}/30}
\;+\; 0.3\,\max(0,\ \text{their starts} - \text{your starts})
\;+\; \frac{\text{missed}}{\text{shared}}\Big|_{\text{shared}\ge 3}
\]

* **streak** is how many messages they've sent in a row at the end of the chat with no answer.
* **starts** is who opens a conversation after 8+ hours of silence.
* Recent neglect counts more than old neglect, so the list stays short and doable.

## Roadmap ideas (PRs welcome)

- [ ] iMessage (`chat.db`) and Discord DM exports
- [ ] Weekly scheduled digest instead of a manual run
- [ ] Android widget or iOS Shortcut that shows "3 people are waiting on you" *before* you open a feed
- [ ] "Watch together" mode: open all of a friend's pending reels in one tab, then reply
- [ ] Opt-in, two-sided "seen with love" receipts between friends

## Development

```bash
python -m pytest        # tests are in tests/
```

MIT licensed. Be the friend who replies. 💛
