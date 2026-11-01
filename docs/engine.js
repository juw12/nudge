// nudge engine: chat-export parsing + "who's waiting on you" analysis.
// A browser port of the Python package (nudge/models.py, parsers/, analyze.py, digest.py).
// Everything runs locally; nothing here touches the network.

// ------------------------------------------------------------------ shares

const URL_RE = /https?:\/\/[^\s<>"']+/i;

const SHARE_KINDS = [
  ["instagram.com/reel", "reel"],
  ["instagram.com/p/", "post"],
  ["instagram.com/stories", "story"],
  ["instagram.com", "Instagram link"],
  ["tiktok.com", "TikTok"],
  ["youtube.com/shorts", "Short"],
  ["youtube.com", "YouTube video"],
  ["youtu.be", "YouTube video"],
  ["x.com", "tweet"],
  ["twitter.com", "tweet"],
  ["facebook.com", "Facebook post"],
  ["fb.watch", "Facebook video"],
  ["reddit.com", "Reddit post"],
  ["spotify.com", "song"],
];

export function classifyShare(url) {
  const lowered = url.toLowerCase();
  for (const [fragment, label] of SHARE_KINDS) {
    if (lowered.includes(fragment)) {
      return label;
    }
  }
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    return host ? `link (${host})` : "link";
  } catch {
    return "link";
  }
}

export function firstUrl(text) {
  const match = (text || "").match(URL_RE);
  return match ? match[0].replace(/[).,!?]+$/, "") : null;
}

function makeThread(id, title, source, participants = [], me = null) {
  return { id, title, source, participants: new Set(participants), messages: [], me };
}

function finalizeThread(thread) {
  thread.messages.sort((a, b) => a.ts - b.ts);
  for (const message of thread.messages) {
    if (message.sender) {
      thread.participants.add(message.sender);
    }
  }
  return thread;
}

function isGroup(thread) {
  return thread.participants.size > 2;
}

// ------------------------------------------------------------------ Instagram / Messenger

const SYSTEM_PHRASES = [
  "reacted ",
  "liked a message",
  "changed the group",
  "named the group",
  "started a video chat",
  "sent an attachment.",
];

// Instagram stores UTF-8 bytes as latin-1 code points ("mojibake"); undo that.
export function fixText(value) {
  if (!value) {
    return "";
  }
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) {
      return value;
    }
    bytes[i] = code;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

export function isInstagramFile(name) {
  return /(^|\/)message_\d+\.json$/i.test(name);
}

function parseInstagramMessage(raw) {
  const sender = fixText(raw.sender_name);
  if (!sender || raw.timestamp_ms == null) {
    return null;
  }
  const text = fixText(raw.content);
  const share = raw.share || {};
  let shareUrl = share.link || firstUrl(text);
  if (!shareUrl && (share.share_text || raw.clips)) {
    shareUrl = "https://www.instagram.com/reel/";
  }
  if (!shareUrl && SYSTEM_PHRASES.some((phrase) => text.toLowerCase().startsWith(phrase))) {
    return null;
  }
  const reactions = (raw.reactions || []).map((r) => [fixText(r.actor), fixText(r.reaction)]);
  return {
    sender,
    ts: raw.timestamp_ms,
    text: text || fixText(share.share_text),
    shareUrl: shareUrl || null,
    reactions,
  };
}

// files: [{ name, text }] — every message_N.json found.
export function parseInstagram(files) {
  const threads = new Map();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let data;
    try {
      data = JSON.parse(file.text);
    } catch {
      continue;
    }
    if (!data || !Array.isArray(data.messages) || !Array.isArray(data.participants)) {
      continue;
    }
    const folder = file.name.includes("/") ? file.name.slice(0, file.name.lastIndexOf("/")) : `title:${data.title}`;
    const source = file.name.toLowerCase().includes("facebook") ? "messenger" : "instagram";
    let thread = threads.get(folder);
    if (!thread) {
      const folderName = folder.split("/").pop();
      thread = makeThread(
        `${source}:${folderName}`,
        fixText(data.title) || folderName,
        source,
        data.participants.map((p) => fixText(p.name)),
      );
      threads.set(folder, thread);
    }
    for (const raw of data.messages) {
      if (raw.is_unsent) {
        continue;
      }
      const message = parseInstagramMessage(raw);
      if (message) {
        thread.messages.push(message);
      }
    }
  }
  return [...threads.values()].filter((t) => t.messages.length).map(finalizeThread);
}

// ------------------------------------------------------------------ WhatsApp

const WA_TIME = String.raw`\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?`;
const WA_DATE = String.raw`\d{1,4}[./-]\d{1,2}[./-]\d{1,4}`;
const WA_PATTERNS = [
  // iOS:     [31/12/2023, 21:15:03] Alex: hey
  new RegExp(String.raw`^\[(?<date>${WA_DATE}),?\s+(?<time>${WA_TIME})\]\s(?<sender>[^:]+?):\s?(?<text>.*)$`),
  // Android: 12/31/23, 9:15 PM - Alex: hey
  new RegExp(String.raw`^(?<date>${WA_DATE}),?\s+(?<time>${WA_TIME})\s[-–]\s(?<sender>[^:]+?):\s?(?<text>.*)$`),
];
const INVISIBLE = /[\u200e\u200f\u202a\u202c\ufeff]/g;

function matchWhatsAppLine(line) {
  for (const pattern of WA_PATTERNS) {
    const match = line.trim().match(pattern);
    if (match) {
      return match.groups;
    }
  }
  return null;
}

export function looksLikeWhatsApp(text) {
  return text
    .split(/\r?\n/)
    .slice(0, 20)
    .some((line) => matchWhatsAppLine(line.replace(INVISIBLE, "")));
}

function detectDateOrder(dates, preference) {
  if (["dmy", "mdy", "ymd"].includes(preference)) {
    return preference;
  }
  let maxFirst = 0;
  let maxSecond = 0;
  for (const value of dates) {
    const parts = value.split(/[./-]/);
    if (parts[0].length === 4) {
      return "ymd";
    }
    maxFirst = Math.max(maxFirst, Number(parts[0]));
    maxSecond = Math.max(maxSecond, Number(parts[1]));
  }
  if (maxFirst > 12) {
    return "dmy";
  }
  if (maxSecond > 12) {
    return "mdy";
  }
  return "dmy";
}

function parseClock(timeText) {
  const clean = timeText.replace(/\u202f/g, " ").toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(A\.?M\.?|P\.?M\.?)?$/);
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  if (match[4]) {
    const pm = match[4][0] === "P";
    if (hour === 12) {
      hour = pm ? 12 : 0;
    } else if (pm) {
      hour += 12;
    }
  }
  return [hour, minute, second];
}

function whatsAppTimestamp(dateText, timeText, order) {
  const parts = dateText.split(/[./-]/).map(Number);
  let day;
  let month;
  let year;
  if (order === "dmy") {
    [day, month, year] = parts;
  } else if (order === "mdy") {
    [month, day, year] = parts;
  } else {
    [year, month, day] = parts;
  }
  if (year < 100) {
    year += 2000;
  }
  const clock = parseClock(timeText);
  if (!clock || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return new Date(year, month - 1, day, clock[0], clock[1], clock[2]).getTime();
}

export function whatsAppTitle(fileName) {
  return fileName
    .split("/")
    .pop()
    .replace(/\.(txt|zip)$/i, "")
    .replace("WhatsApp Chat with ", "")
    .replace("WhatsApp Chat - ", "");
}

export function parseWhatsApp(text, title, dateOrder = "auto") {
  const entries = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(INVISIBLE, "").replace(/\u202f/g, " ");
    const groups = matchWhatsAppLine(line);
    if (groups) {
      entries.push({ ...groups });
    } else if (entries.length) {
      entries[entries.length - 1].text += "\n" + line;
    }
  }
  const order = detectDateOrder(entries.map((e) => e.date), dateOrder);
  const thread = makeThread(`whatsapp:${title}`, title, "whatsapp");
  for (const entry of entries) {
    const ts = whatsAppTimestamp(entry.date, entry.time, order);
    if (ts == null) {
      continue;
    }
    const body = entry.text.trim();
    thread.messages.push({ sender: entry.sender.trim(), ts, text: body, shareUrl: firstUrl(body), reactions: [] });
  }
  return thread.messages.length ? [finalizeThread(thread)] : [];
}

// ------------------------------------------------------------------ Telegram

function flattenTelegramText(value) {
  if (typeof value === "string") {
    return [value, firstUrl(value)];
  }
  const pieces = [];
  let link = null;
  for (const item of value || []) {
    if (typeof item === "string") {
      pieces.push(item);
      continue;
    }
    pieces.push(item.text || "");
    if (!link && (item.type === "link" || item.type === "text_link")) {
      link = item.href || item.text;
    }
  }
  const text = pieces.join("");
  return [text, link || firstUrl(text)];
}

function parseTelegramChat(chat) {
  const type = chat.type || "personal_chat";
  if (!["personal_chat", "private_group", "private_supergroup"].includes(type)) {
    return null;
  }
  const thread = makeThread(`telegram:${chat.id ?? chat.name}`, chat.name || "Telegram chat", "telegram");
  for (const raw of chat.messages || []) {
    if (raw.type !== "message" || !raw.from) {
      continue;
    }
    const [text, link] = flattenTelegramText(raw.text);
    const reactions = [];
    for (const reaction of raw.reactions || []) {
      for (const recent of reaction.recent || []) {
        reactions.push([recent.from || "", reaction.emoji || ""]);
      }
    }
    thread.messages.push({ sender: raw.from, ts: new Date(raw.date).getTime(), text, shareUrl: link, reactions });
  }
  if (type !== "personal_chat") {
    thread.participants.add("__group__");
  }
  return thread.messages.length ? finalizeThread(thread) : null;
}

export function isTelegramData(data) {
  return Boolean(data && ((data.chats && Array.isArray(data.chats.list)) || (Array.isArray(data.messages) && "name" in data && !data.participants)));
}

export function parseTelegram(data) {
  const chats = data.chats ? data.chats.list : [data];
  return chats.map(parseTelegramChat).filter(Boolean);
}

// ------------------------------------------------------------------ analysis

export const DEFAULTS = { days: 30, replyWindowHours: 48, gapHours: 8, includeGroups: false };
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function sameperson(a, b) {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.split(/\s+/)[0] === y.split(/\s+/)[0];
}

// You are the sender who appears in the most threads, per platform. When a platform is a tie
// (e.g. one WhatsApp chat), prefer the candidate whose name matches "you" on another platform.
export function detectMe(threads, warnings = null) {
  const bySource = new Map();
  for (const thread of threads) {
    const counter = bySource.get(thread.source) || new Map();
    for (const sender of new Set(thread.messages.map((m) => m.sender))) {
      counter.set(sender, (counter.get(sender) || 0) + 1);
    }
    bySource.set(thread.source, counter);
  }
  const confident = new Map();
  const tied = new Map();
  for (const [source, counter] of bySource) {
    const ranked = [...counter.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) {
      continue;
    }
    const candidates = ranked.filter((r) => r[1] === ranked[0][1]).map((r) => r[0]).sort();
    if (candidates.length === 1) {
      confident.set(source, candidates[0]);
    } else {
      tied.set(source, candidates);
    }
  }
  const me = new Set(confident.values());
  for (const [source, candidates] of tied) {
    const match = candidates.find((candidate) => [...confident.values()].some((name) => sameperson(candidate, name)));
    me.add(match || candidates[0]);
    if (!match && warnings) {
      warnings.push({ source, guess: candidates[0], candidates });
    }
  }
  return me;
}

// Senders per platform, most threads first — used for the "which one is you?" pickers.
export function senderNamesBySource(threads) {
  const bySource = new Map();
  for (const thread of threads) {
    const counter = bySource.get(thread.source) || new Map();
    for (const sender of new Set(thread.messages.map((m) => m.sender))) {
      counter.set(sender, (counter.get(sender) || 0) + 1);
    }
    bySource.set(thread.source, counter);
  }
  const result = new Map();
  for (const [source, counter] of bySource) {
    result.set(source, [...counter.entries()].sort((a, b) => b[1] - a[1]).map((entry) => entry[0]));
  }
  return result;
}

export function analyze(threads, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const warnings = [];
  let me;
  if (settings.me && settings.me.length) {
    me = new Set([...settings.me, ...threads.filter((t) => t.me).map((t) => t.me)]);
  } else {
    const known = new Set(threads.filter((t) => t.me).map((t) => t.me));
    const unknown = threads.filter((t) => !t.me);
    me = new Set([...known, ...(unknown.length ? detectMe(unknown, warnings) : [])]);
  }
  const meFolded = new Set([...me].map((name) => name.toLowerCase()));
  const isMe = (name) => meFolded.has((name || "").toLowerCase());

  let asOf = settings.asOf;
  if (asOf == null) {
    asOf = 0;
    for (const thread of threads) {
      for (const message of thread.messages) {
        asOf = Math.max(asOf, message.ts);
      }
    }
    asOf = asOf || Date.now();
  }

  const friends = [];
  for (const thread of threads) {
    if (isGroup(thread) && !settings.includeGroups) {
      continue;
    }
    const others = [...thread.participants].filter((p) => !isMe(p) && p !== "__group__");
    if (!others.length) {
      continue;
    }
    const friend = isGroup(thread) ? thread.title : others[0];
    const report = analyzeThread(thread, friend, isMe, asOf, settings);
    if (report.messagesFromThem) {
      friends.push(report);
    }
  }
  friends.sort((a, b) => b.score - a.score);
  return { asOf, days: settings.days, me: [...me], friends, warnings };
}

function analyzeThread(thread, friend, isMe, asOf, settings) {
  const windowStart = asOf - settings.days * DAY;
  const replyWindow = settings.replyWindowHours * HOUR;
  const gap = settings.gapHours * HOUR;

  const report = {
    key: `${thread.source}:${friend}`,
    friend,
    source: thread.source,
    sharesReceived: 0,
    sharesReplied: 0,
    sharesReactedOnly: 0,
    pending: [],
    messagesFromThem: 0,
    messagesFromMe: 0,
    theirStarts: 0,
    myStarts: 0,
    unansweredStreak: 0,
    waitingSince: null,
    lastFromMe: null,
    score: 0,
    nudge: "",
    opener: "",
  };
  const myTimes = thread.messages.filter((m) => isMe(m.sender)).map((m) => m.ts);
  report.lastFromMe = myTimes.length ? myTimes[myTimes.length - 1] : null;

  let previous = null;
  for (const message of thread.messages) {
    const mine = isMe(message.sender);
    const inWindow = message.ts >= windowStart && message.ts <= asOf;
    if (inWindow) {
      const starts = previous == null || message.ts - previous >= gap ? 1 : 0;
      if (mine) {
        report.messagesFromMe += 1;
        report.myStarts += starts;
      } else {
        report.messagesFromThem += 1;
        report.theirStarts += starts;
        if (message.shareUrl) {
          scoreShare(report, message, myTimes, replyWindow, isMe);
        }
      }
    }
    previous = message.ts;
  }

  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i];
    if (isMe(message.sender)) {
      break;
    }
    report.unansweredStreak += 1;
    report.waitingSince = message.ts;
  }

  report.score = priority(report, asOf);
  [report.nudge, report.opener] = suggest(report, asOf);
  return report;
}

function firstAfter(sortedTimes, ts) {
  let low = 0;
  let high = sortedTimes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedTimes[mid] <= ts) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low < sortedTimes.length ? sortedTimes[low] : null;
}

function scoreShare(report, share, myTimes, replyWindow, isMe) {
  report.sharesReceived += 1;
  const nextReply = firstAfter(myTimes, share.ts);
  if (nextReply != null && nextReply - share.ts <= replyWindow) {
    report.sharesReplied += 1;
  } else if (share.reactions.some(([actor]) => isMe(actor))) {
    report.sharesReactedOnly += 1;
  } else if (nextReply == null) {
    report.pending.push({ url: share.shareUrl, kind: classifyShare(share.shareUrl), ts: share.ts });
  }
}

export function sharesMissed(report) {
  return report.sharesReceived - report.sharesReplied - report.sharesReactedOnly;
}

export function responseRate(report) {
  if (!report.sharesReceived) {
    return null;
  }
  return (report.sharesReplied + report.sharesReactedOnly) / report.sharesReceived;
}

function priority(report, asOf) {
  const pendingWeight = report.pending.reduce((sum, share) => sum + Math.exp(-(asOf - share.ts) / DAY / 14), 0);
  let waiting = 0;
  if (report.unansweredStreak && report.waitingSince != null) {
    const waitingDays = (asOf - report.waitingSince) / DAY;
    waiting = 1.5 * Math.log1p(report.unansweredStreak) * Math.exp(-waitingDays / 30);
  }
  const imbalance = 0.3 * Math.max(0, report.theirStarts - report.myStarts);
  const neglect = report.sharesReceived >= 3 ? sharesMissed(report) / report.sharesReceived : 0;
  return Math.round((pendingWeight + waiting + imbalance + neglect) * 100) / 100;
}

function pick(seed, options) {
  let sum = 0;
  for (const char of seed) {
    sum += char.codePointAt(0);
  }
  return options[sum % options.length];
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function suggest(report, asOf) {
  const name = report.friend ? report.friend.split(/\s+/)[0] : "them";
  const waitingDays = report.waitingSince != null ? Math.max(0, Math.floor((asOf - report.waitingSince) / DAY)) : null;
  const pendingCount = report.pending.length;

  if (pendingCount) {
    const newest = report.pending[pendingCount - 1];
    return [
      `${name} sent you ${pendingCount} thing${pendingCount > 1 ? "s" : ""} you never answered. ` +
        `Watch the newest ${newest.kind} and say what it reminded you of. Something more than 😂.`,
      pick(report.friend, [
        `ok finally caught up on what you sent 😅 the latest ${newest.kind} is SO us. how've you been?`,
        `just binged everything you sent me lol. that last ${newest.kind} 💀 when are we hanging out?`,
        `sorry I ghosted your ${newest.kind}s. watched them all now, you have elite taste. how are you actually doing?`,
      ]),
    ];
  }
  if (report.unansweredStreak && waitingDays != null) {
    return [
      `${name} has been waiting ${plural(waitingDays, "day")} ` +
        `(${report.unansweredStreak} unanswered message${report.unansweredStreak > 1 ? "s" : ""}). Even a two-line reply counts.`,
      "sorry I went quiet, got lost in my phone 🙈 what's new with you?",
    ];
  }
  if (report.theirStarts > report.myStarts) {
    return [
      `${name} starts most of your chats (${report.theirStarts} vs ${report.myStarts}). Next time, you start it.`,
      "saw something today that made me think of you. free for a call this week?",
    ];
  }
  return [`You and ${name} are in a good rhythm. Keep it up.`, ""];
}

export function isWaiting(report) {
  return report.unansweredStreak > 0 || report.pending.length > 0;
}

// Newest moment this friend reached out; used to bring a "done" friend back when they message again.
export function lastActivity(report) {
  const times = report.pending.map((p) => p.ts);
  if (report.waitingSince != null) {
    times.push(report.waitingSince);
  }
  return times.length ? Math.max(...times) : 0;
}

export function headline(waitingFriends) {
  if (!waitingFriends.length) {
    return "Nobody is waiting on you. Nice.";
  }
  const first = waitingFriends[0].friend.split(/\s+/)[0];
  if (waitingFriends.length === 1) {
    return `${first} is waiting on you`;
  }
  const others = waitingFriends.length - 1;
  return `${first} + ${others} other${others > 1 ? "s" : ""} are waiting on you`;
}
