// nudge web app: UI, on-device persistence, auto-refresh from a folder, share target, install + offline.
import { analyze, headline, isWaiting, lastActivity, responseRate, senderNamesBySource } from "./engine.js";
import { canRead, connectFolder, folderSupported, forgetFolder, savedFolder, scanFolder } from "./folder.js";
import { loadFiles } from "./loader.js";
import { compactThread, idbClear, idbDelete, idbGet, idbSet, mergeThreads, reviveThread } from "./store.js";

const STORE_KEY = "nudge:v1";
const WINDOWS = [7, 30, 90];
const DAY = 24 * 3600 * 1000;
const STALE_DAYS = 7;
const IS_TOUCH = matchMedia("(pointer: coarse)").matches;
const IS_ANDROID = /android/i.test(navigator.userAgent);
const IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

const APP_LINKS = {
  instagram: { label: "Instagram", url: "https://www.instagram.com/direct/inbox/" },
  messenger: { label: "Messenger", url: "https://www.messenger.com/" },
  whatsapp: { label: "WhatsApp", url: IS_TOUCH ? "whatsapp://" : "https://web.whatsapp.com/" },
  telegram: { label: "Telegram", url: IS_TOUCH ? "tg://" : "https://web.telegram.org/" },
  imessage: { label: "Messages", url: "sms:" },
};

const state = {
  threads: null, // parsed chats; kept on this device in IndexedDB (no message text)
  me: null, // { source: "your name on that app" } once the user picks; null = auto-detect
  days: 30,
  summaries: null,
  savedAt: null,
  done: {},
  isDemo: false,
  folderName: null,
  folderCheckedAt: null,
  folderSignature: null,
  folderNeedsClick: false,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ storage

function save() {
  if (state.isDemo) {
    return;
  }
  const payload = {
    savedAt: state.savedAt,
    days: state.days,
    me: state.me,
    summaries: state.summaries,
    done: state.done,
    folderName: state.folderName,
    folderCheckedAt: state.folderCheckedAt,
    folderSignature: state.folderSignature,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    toast("Couldn't save on this device (storage full?)");
  }
}

function restore() {
  try {
    const payload = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (payload && payload.summaries) {
      Object.assign(state, payload);
      return true;
    }
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
  return false;
}

async function saveThreads() {
  if (state.isDemo || !state.threads) {
    return;
  }
  try {
    await idbSet("threads", state.threads.map(compactThread));
  } catch (error) {
    console.warn("Could not store chats on this device", error);
  }
}

async function restoreThreads() {
  try {
    const stored = await idbGet("threads");
    if (Array.isArray(stored) && stored.length) {
      state.threads = stored.map(reviveThread);
      return true;
    }
  } catch (error) {
    console.warn("Could not read stored chats", error);
  }
  return false;
}

// ------------------------------------------------------------------ helpers

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function daysAgo(ts, reference = Date.now()) {
  if (ts == null) {
    return "never";
  }
  const days = Math.floor((reference - ts) / DAY);
  if (days <= 0) {
    return "today";
  }
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function initials(name) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function hue(name) {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)) % 360;
  }
  return hash;
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 2200);
}

function show(view) {
  for (const id of ["welcome-view", "busy-view", "results-view"]) {
    $(id).hidden = id !== view;
  }
  window.scrollTo({ top: 0 });
}

function isDone(friend) {
  const doneAt = state.done[friend.key];
  return doneAt != null && doneAt >= lastActivity(friend);
}

// ------------------------------------------------------------------ analysis

function runAnalysis() {
  const me = state.me ? Object.values(state.me) : null;
  state.summaries = {};
  for (const days of WINDOWS) {
    state.summaries[days] = analyze(state.threads, { days, me });
  }
  state.savedAt = Date.now();
  save();
}

// New chats are merged with what's already on this device, so sharing one WhatsApp chat
// today doesn't throw away last week's Instagram export.
async function importFiles(fileList, { quiet = false } = {}) {
  const items = [...fileList];
  if (!items.length) {
    return 0;
  }
  if (!quiet) {
    show("busy-view");
  }
  try {
    const { threads, skipped } = await loadFiles(items, (text) => {
      $("busy-text").textContent = text;
    });
    if (!threads.length) {
      show(state.summaries ? "results-view" : "welcome-view");
      if (!quiet) {
        toast(skipped.length ? "Couldn't find any chats in those files" : "No chats found");
      }
      return 0;
    }
    const base = state.isDemo || !state.threads ? [] : state.threads;
    state.isDemo = false;
    state.threads = mergeThreads(base, threads);
    await saveThreads();
    runAnalysis();
    renderResults();
    show("results-view");
    toast(`Updated with ${threads.length} chat${threads.length === 1 ? "" : "s"}`);
    return threads.length;
  } catch (error) {
    console.error(error);
    show(state.summaries ? "results-view" : "welcome-view");
    toast(`Something went wrong: ${error.message}`);
    return 0;
  }
}

// ------------------------------------------------------------------ connected folder

async function refreshFromFolder({ ask = false, quiet = false } = {}) {
  const handle = await savedFolder();
  if (!handle) {
    return;
  }
  if (!(await canRead(handle, ask))) {
    state.folderNeedsClick = true;
    renderSourceBar();
    return;
  }
  state.folderNeedsClick = false;
  state.folderName = handle.name;
  const { items, signature } = await scanFolder(handle, (text) => {
    $("busy-text").textContent = text;
  });
  state.folderCheckedAt = Date.now();
  if (signature && signature === state.folderSignature && state.threads) {
    save();
    renderSourceBar();
    if (!quiet) {
      toast("No new exports since last time");
    }
    return;
  }
  state.folderSignature = signature;
  if (!items.length) {
    save();
    renderSourceBar();
    toast(`No chat exports in “${handle.name}” yet`);
    return;
  }
  await importFiles(items, { quiet });
  save();
  renderSourceBar();
}

async function onConnectFolder() {
  try {
    const handle = await connectFolder();
    state.folderName = handle.name;
    state.folderSignature = null;
    show("busy-view");
    await refreshFromFolder({ ask: true });
    if (!state.summaries) {
      show("welcome-view");
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      toast(`Couldn't connect the folder: ${error.message}`);
    }
  }
}

function renderSourceBar() {
  const bar = $("source-bar");
  const refresh = $("refresh-folder");
  const connect = $("connect-folder-2");
  if (state.isDemo) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (state.folderName) {
    refresh.hidden = false;
    connect.hidden = true;
    if (state.folderNeedsClick) {
      $("source-text").textContent = `📁 ${state.folderName} · tap to check for new chats`;
      refresh.textContent = "Check now";
      refresh.classList.add("primary");
    } else {
      const checked = state.folderCheckedAt ? daysAgoOrTime(state.folderCheckedAt) : "not yet";
      $("source-text").textContent = `📁 Auto-refresh from “${state.folderName}” · checked ${checked}`;
      refresh.textContent = "Check for new chats";
      refresh.classList.remove("primary");
    }
  } else {
    refresh.hidden = true;
    connect.hidden = !folderSupported;
    $("source-text").textContent = IS_ANDROID ? "📱 Tip: in WhatsApp, Export chat → nudge" : "";
  }
}

function daysAgoOrTime(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return daysAgo(ts).replace("today", new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
}

// ------------------------------------------------------------------ shared files (Android share target)

async function importShared() {
  const files = (await idbGet("sharedInbox")) || [];
  await idbDelete("sharedInbox");
  history.replaceState(null, "", location.pathname);
  if (files.length) {
    await importFiles(files);
  } else if (state.summaries) {
    renderResults();
    show("results-view");
  }
}

async function loadDemo() {
  show("busy-view");
  $("busy-text").textContent = "Loading demo chats…";
  const response = await fetch("demo/nudge-demo.zip");
  const blob = await response.blob();
  const { threads } = await loadFiles([new File([blob], "instagram-demo.zip")]);
  state.threads = threads;
  state.isDemo = true;
  state.me = null;
  state.done = {};
  runAnalysis();
  renderResults();
  show("results-view");
}

function renderWelcomeExtras() {
  const card = $("auto-card");
  const text = $("auto-card-text");
  const button = $("connect-folder");
  if (folderSupported) {
    text.textContent = "Connect your Downloads folder once. Each time you open nudge, it picks up new Instagram, WhatsApp and Telegram exports by itself.";
    button.hidden = false;
  } else if (IS_ANDROID) {
    text.textContent = "Install nudge (browser menu → Install app). Then in WhatsApp: Export chat → nudge. It lands here directly.";
    button.hidden = true;
  } else if (IS_IOS) {
    text.textContent = "Save exports to Files and tap Choose files. nudge remembers every chat, so you only add what's new.";
    button.hidden = true;
  } else {
    text.textContent = "nudge remembers every chat you add, so next time you only add what's new.";
    button.hidden = true;
  }
  card.hidden = false;
}

// ------------------------------------------------------------------ rendering

function renderResults() {
  const summary = state.summaries[state.days];
  const friends = summary.friends;
  const waiting = friends.filter((f) => isWaiting(f) && !isDone(f));
  const hello = friends.filter((f) => !isWaiting(f) && !isDone(f) && f.theirStarts > f.myStarts);
  const caughtUp = friends.filter((f) => !waiting.includes(f) && !hello.includes(f));

  $("demo-banner").hidden = !state.isDemo;
  renderSourceBar();

  const shares = friends.reduce((sum, f) => sum + f.sharesReceived, 0);
  const answered = friends.reduce((sum, f) => sum + f.sharesReplied + f.sharesReactedOnly, 0);
  const pending = waiting.reduce((sum, f) => sum + f.pending.length, 0);
  $("hero-kicker").textContent = `Last ${state.days} days · up to ${new Date(summary.asOf).toLocaleDateString()}`;
  $("hero-headline").textContent = headline(waiting);
  $("hero-stats").textContent = shares
    ? `Friends shared ${shares} reels & links with you. You answered ${answered} (${Math.round((answered / shares) * 100)}%). ${pending} still unanswered.`
    : "Every message is someone thinking of you.";

  const ageDays = Math.floor((Date.now() - summary.asOf) / DAY);
  const stale = $("stale-note");
  stale.hidden = state.isDemo || ageDays < STALE_DAYS;
  stale.textContent = `Your newest message is ${ageDays} days old. Add a fresh export to see who's waiting now.`;

  $("window-chips").innerHTML = WINDOWS.map(
    (days) => `<button data-days="${days}" aria-pressed="${days === state.days}">${days} days</button>`,
  ).join("");

  renderMePicker(summary);

  $("waiting-title").hidden = false;
  $("waiting-list").innerHTML = waiting.length
    ? waiting.map((f) => cardHtml(f, summary.asOf)).join("")
    : `<p class="muted">Nobody's waiting on you in this window. 🎉</p>`;
  $("hello-title").hidden = !hello.length;
  $("hello-list").innerHTML = hello.map((f) => cardHtml(f, summary.asOf)).join("");

  const caught = $("caught-up");
  caught.hidden = !caughtUp.length;
  $("caught-up-summary").textContent = `Caught up (${caughtUp.length})`;
  $("caught-up-list").innerHTML = caughtUp
    .map((f) => {
      const undo = state.done[f.key] != null ? `<button class="link-button" data-undo="${esc(f.key)}">undo</button>` : "";
      return `<div class="caught-row"><span>${esc(f.friend)} <span class="muted">· ${esc(f.source)}</span></span>${undo}</div>`;
    })
    .join("");
}

function renderMePicker(summary) {
  const picker = $("me-picker");
  const warning = $("me-warning");
  if (!state.threads) {
    picker.hidden = true;
    warning.hidden = true;
    return;
  }
  const bySource = senderNamesBySource(state.threads);
  const multipleApps = bySource.size > 1;
  const rows = [];
  for (const [source, allNames] of bySource) {
    const names = allNames.slice(0, 12);
    if (names.length < 2) {
      continue;
    }
    const current = names.find((name) => summary.me.includes(name)) || names[0];
    const label = multipleApps ? `You on ${(APP_LINKS[source] || { label: source }).label}` : "You are";
    const options = names
      .map((name) => `<option value="${esc(name)}" ${name === current ? "selected" : ""}>${esc(name)}</option>`)
      .join("");
    rows.push(`<label><span>${esc(label)}</span><select data-me-source="${esc(source)}">${options}</select></label>`);
  }
  picker.innerHTML = rows.join("");
  picker.hidden = !rows.length;
  warning.hidden = !(summary.warnings.length && !state.me);
}

function cardHtml(friend, asOf) {
  const app = APP_LINKS[friend.source] || { label: "chat", url: "#" };
  const rate = responseRate(friend);
  const tags = [`<span class="tag">${esc(app.label)}</span>`];
  if (friend.pending.length) {
    tags.push(`<span class="tag hot">${friend.pending.length} unseen</span>`);
  }
  if (friend.unansweredStreak) {
    tags.push(`<span class="tag hot">waiting ${esc(daysAgo(friend.waitingSince, asOf).replace(" ago", ""))}</span>`);
  }
  tags.push(`<span class="tag">you last wrote ${esc(daysAgo(friend.lastFromMe, asOf))}</span>`);

  const meter =
    rate == null
      ? ""
      : `<div class="meter"><i style="width:${Math.round(rate * 100)}%"></i></div>
         <div class="meter-label">You answered ${Math.round(rate * 100)}% of what they shared · they started ${friend.theirStarts} chats, you ${friend.myStarts}</div>`;

  const links = [...friend.pending]
    .reverse()
    .slice(0, 6)
    .map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.kind)}</a> <span class="muted">· ${esc(daysAgo(p.ts, asOf))}</span></li>`)
    .join("");
  const pendingBlock = links
    ? `<details class="pending"><summary>What they sent (${friend.pending.length})</summary><ul>${links}</ul></details>`
    : "";

  const opener = friend.opener ? `<p class="bubble">${esc(friend.opener)}</p>` : "";
  const copy = friend.opener ? `<button class="small" data-copy="${esc(friend.opener)}">Copy message</button>` : "";

  return `
  <article class="card" data-key="${esc(friend.key)}">
    <div class="card-head">
      <div class="avatar" style="background:hsl(${hue(friend.friend)} 65% 55%)">${esc(initials(friend.friend))}</div>
      <div class="who"><strong>${esc(friend.friend)}</strong><div class="tags">${tags.join("")}</div></div>
    </div>
    <p class="nudge-text">${esc(friend.nudge)}</p>
    ${opener}
    <div class="card-actions">
      ${copy}
      <a class="button small" href="${esc(app.url)}" target="_blank" rel="noopener">Open ${esc(app.label)}</a>
      <button class="small done" data-done="${esc(friend.key)}">✓ Replied</button>
    </div>
    ${meter}
    ${pendingBlock}
  </article>`;
}

// ------------------------------------------------------------------ events

function wireEvents() {
  const fileInput = $("file-input");
  const folderInput = $("folder-input");
  fileInput.addEventListener("change", () => {
    importFiles(fileInput.files);
    fileInput.value = "";
  });
  folderInput.addEventListener("change", () => {
    importFiles(folderInput.files);
    folderInput.value = "";
  });

  const dropZone = $("drop-zone");
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  for (const type of ["dragenter", "dragover"]) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  }
  document.addEventListener("drop", (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) {
      importFiles(event.dataTransfer.files);
    }
  });

  $("demo-button").addEventListener("click", loadDemo);

  $("connect-folder").addEventListener("click", onConnectFolder);
  $("connect-folder-2").addEventListener("click", onConnectFolder);
  $("refresh-folder").addEventListener("click", async () => {
    const button = $("refresh-folder");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      await refreshFromFolder({ ask: true, quiet: false });
    } finally {
      button.disabled = false;
      renderSourceBar();
    }
  });

  $("forget-button").addEventListener("click", async () => {
    if (!confirm("Delete nudge's saved results from this device?")) {
      return;
    }
    localStorage.removeItem(STORE_KEY);
    await forgetFolder().catch(() => {});
    await idbClear().catch(() => {});
    Object.assign(state, {
      threads: null,
      me: null,
      summaries: null,
      savedAt: null,
      done: {},
      isDemo: false,
      folderName: null,
      folderCheckedAt: null,
      folderSignature: null,
      folderNeedsClick: false,
    });
    show("welcome-view");
    toast("Forgotten. Nothing left on this device.");
  });

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button, a");
    if (!target) {
      return;
    }
    if (target.dataset.action === "import") {
      state.isDemo = false;
      renderWelcomeExtras();
      show("welcome-view");
      return;
    }
    if (target.dataset.days) {
      state.days = Number(target.dataset.days);
      save();
      renderResults();
      return;
    }
    if (target.dataset.copy) {
      try {
        await navigator.clipboard.writeText(target.dataset.copy);
        toast("Copied. Now paste it to them 💌");
      } catch {
        toast("Couldn't copy. Long-press the message instead");
      }
      return;
    }
    if (target.dataset.done) {
      const card = target.closest(".card");
      state.done[target.dataset.done] = Date.now();
      save();
      card.classList.add("leaving");
      setTimeout(renderResults, 280);
      toast("Nice. That's how friendships stay alive.");
      return;
    }
    if (target.dataset.undo) {
      delete state.done[target.dataset.undo];
      save();
      renderResults();
    }
  });

  $("me-picker").addEventListener("change", (event) => {
    if (!event.target.matches("select[data-me-source]")) {
      return;
    }
    state.me = {};
    for (const select of $("me-picker").querySelectorAll("select[data-me-source]")) {
      state.me[select.dataset.meSource] = select.value;
    }
    runAnalysis();
    renderResults();
  });
}

// ------------------------------------------------------------------ install / offline

function setupInstall() {
  let deferredPrompt = null;
  const button = $("install-button");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!deferredPrompt) {
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    button.hidden = true;
  });
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("ios-hint").hidden = !(IS_IOS && !standalone);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Installed app on Windows/ChromeOS: "Open with nudge" on a .zip / .json / .txt lands here.
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || !launchParams.files.length) {
        return;
      }
      const files = await Promise.all(launchParams.files.map((handle) => handle.getFile()));
      importFiles(files);
    });
  }
}

// ------------------------------------------------------------------ start

async function start() {
  wireEvents();
  setupInstall();
  renderWelcomeExtras();

  const params = new URLSearchParams(location.search);
  if (params.has("demo")) {
    await loadDemo();
    return;
  }

  // 1. Show the last results instantly, then load the stored chats behind them.
  const hadResults = restore();
  if (hadResults) {
    renderResults();
    show("results-view");
  } else {
    show("welcome-view");
  }
  if (await restoreThreads()) {
    runAnalysis();
    renderResults();
    show("results-view");
  }

  // 2. Files shared from another app (Android share sheet).
  if (params.has("shared")) {
    await importShared();
  }

  // 3. Connected folder: pick up new exports on every open (silently if allowed).
  if (folderSupported && (await savedFolder())) {
    await refreshFromFolder({ ask: false, quiet: true });
  }
}

start();

// Exposed for automated tests only.
window.__nudge = { state, importFiles, loadDemo, refreshFromFolder };
