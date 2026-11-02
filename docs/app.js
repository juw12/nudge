// Nudge web app: UI, on-device persistence, auto-refresh from a folder, share target, install + offline.
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

// Line icons (Lucide-style paths), rendered inline so the app works offline.
const ICONS = {
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
};

function icon(name, size = 16) {
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`
  );
}

function hydrateIcons(root = document) {
  for (const element of root.querySelectorAll("[data-icon]")) {
    if (!element.querySelector(":scope > svg.icon")) {
      element.insertAdjacentHTML("afterbegin", icon(element.dataset.icon, element.classList.contains("btn-sm") ? 14 : 16));
    }
  }
}

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
    toast("Could not save results on this device");
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
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function duration(ts, reference) {
  const days = Math.max(0, Math.floor((reference - ts) / DAY));
  if (days === 0) {
    return "since today";
  }
  return days === 1 ? "1 day" : `${days} days`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function timeLabel(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  if (Date.now() - ts < DAY) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return daysAgo(ts);
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
  }, 2400);
}

function show(view) {
  for (const id of ["welcome-view", "busy-view", "results-view"]) {
    $(id).hidden = id !== view;
  }
  $("add-files-top").hidden = view !== "results-view" || state.isDemo;
  if (view !== "results-view") {
    $("source-bar").hidden = true;
    $("refresh-folder").hidden = true;
    $("connect-folder-2").hidden = true;
  }
  window.scrollTo({ top: 0 });
  if (view === "results-view" && state.summaries) {
    renderSourceBar();
  }
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
        toast(skipped.length ? "No chats found in the selected files" : "No chats found");
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
    toast(`Imported ${threads.length} conversation${threads.length === 1 ? "" : "s"}`);
    return threads.length;
  } catch (error) {
    console.error(error);
    show(state.summaries ? "results-view" : "welcome-view");
    toast(`Import failed: ${error.message}`);
    return 0;
  }
}

async function loadDemo() {
  show("busy-view");
  $("busy-text").textContent = "Loading sample data…";
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
      toast("No new exports found");
    }
    return;
  }
  state.folderSignature = signature;
  if (!items.length) {
    save();
    renderSourceBar();
    toast(`No chat exports found in “${handle.name}”`);
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
      toast(`Could not connect the folder: ${error.message}`);
    }
  }
}

function renderSourceBar() {
  const bar = $("source-bar");
  const refresh = $("refresh-folder");
  const connect = $("connect-folder-2");
  const onResults = !$("results-view").hidden;
  if (state.isDemo || !onResults) {
    bar.hidden = true;
    refresh.hidden = true;
    connect.hidden = true;
    return;
  }
  if (state.folderName) {
    bar.hidden = false;
    refresh.hidden = false;
    connect.hidden = true;
    if (state.folderNeedsClick) {
      $("source-text").textContent = `${state.folderName} · permission needed`;
      refresh.classList.replace("btn-secondary", "btn-attention");
      setButtonLabel(refresh, "Check now");
    } else {
      const checked = state.folderCheckedAt ? timeLabel(state.folderCheckedAt) : "not yet";
      $("source-text").textContent = `${state.folderName} · synced ${checked}`;
      refresh.classList.replace("btn-attention", "btn-secondary");
      setButtonLabel(refresh, "Check for new chats");
    }
  } else {
    bar.hidden = true;
    refresh.hidden = true;
    connect.hidden = !folderSupported;
  }
}

function setButtonLabel(button, text) {
  const svg = button.querySelector("svg.icon");
  button.textContent = text;
  if (svg) {
    button.prepend(svg);
  }
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

// ------------------------------------------------------------------ rendering

function renderWelcomeExtras() {
  const text = $("auto-card-text");
  const button = $("connect-folder");
  if (folderSupported) {
    button.hidden = false;
    text.textContent = "Connect your Downloads folder once and Nudge imports new exports automatically each time you open it.";
  } else if (IS_ANDROID) {
    button.hidden = true;
    text.textContent = "Install Nudge from your browser menu, then share WhatsApp exports directly to it via Export chat → Nudge.";
  } else if (IS_IOS) {
    button.hidden = true;
    text.textContent = "Save exports to Files, then choose them here. Nudge remembers every conversation, so you only add what's new.";
  } else {
    button.hidden = true;
    text.textContent = "Nudge remembers every conversation you add, so next time you only add what's new.";
  }
}

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
  const sources = new Set(friends.map((f) => (APP_LINKS[f.source] || { label: f.source }).label));

  $("hero-kicker").textContent = `Last ${state.days} days · data through ${formatDate(summary.asOf)}`;
  $("hero-headline").textContent = headline(waiting);

  $("metric-waiting").textContent = String(waiting.length);
  $("metric-waiting-sub").textContent = waiting.length === 1 ? "person" : "people";
  $("metric-pending").textContent = String(pending);
  $("metric-rate").textContent = shares ? `${Math.round((answered / shares) * 100)}%` : "—";
  $("metric-rate-sub").textContent = shares ? `${answered} of ${shares} shares answered` : "No shares in this period";
  $("metric-chats").textContent = String(friends.length);
  $("metric-chats-sub").textContent = [...sources].join(", ") || "None in this period";

  const ageDays = Math.floor((Date.now() - summary.asOf) / DAY);
  const stale = $("stale-note");
  stale.hidden = state.isDemo || ageDays < STALE_DAYS;
  stale.textContent = `The newest message in your data is ${ageDays} days old. Add a recent export to see who is waiting now.`;

  $("window-chips").innerHTML = WINDOWS.map(
    (days) => `<button data-days="${days}" aria-pressed="${days === state.days}">${days} days</button>`,
  ).join("");

  renderMePicker(summary);

  $("waiting-count").textContent = String(waiting.length);
  $("waiting-list").innerHTML = waiting.length
    ? waiting.map((f) => itemHtml(f, summary.asOf)).join("")
    : `<div class="empty">No one is waiting on a reply in this period.</div>`;

  $("hello-section").hidden = !hello.length;
  $("hello-count").textContent = String(hello.length);
  $("hello-list").innerHTML = hello.map((f) => itemHtml(f, summary.asOf)).join("");

  const caught = $("caught-up");
  caught.hidden = !caughtUp.length;
  $("caught-up-summary").textContent = `Up to date (${caughtUp.length})`;
  $("caught-up-list").innerHTML = caughtUp
    .map((f) => {
      const app = APP_LINKS[f.source] || { label: f.source };
      const undo = state.done[f.key] != null
        ? `<button class="btn btn-ghost btn-sm" data-undo="${esc(f.key)}">${icon("undo", 14)}Undo</button>`
        : "";
      return `<div class="caught-row"><span>${esc(f.friend)} <span class="muted">· ${esc(app.label)}</span></span>${undo}</div>`;
    })
    .join("");
  hydrateIcons(caught);
}

function renderMePicker(summary) {
  const identity = $("identity");
  const picker = $("me-picker");
  const warning = $("me-warning");
  if (!state.threads) {
    identity.hidden = true;
    warning.hidden = true;
    return;
  }
  const bySource = senderNamesBySource(state.threads);
  const rows = [];
  for (const [source, allNames] of bySource) {
    const names = allNames.slice(0, 12);
    if (names.length < 2) {
      continue;
    }
    const current = names.find((name) => summary.me.includes(name)) || names[0];
    const label = (APP_LINKS[source] || { label: source }).label;
    const options = names
      .map((name) => `<option value="${esc(name)}" ${name === current ? "selected" : ""}>${esc(name)}</option>`)
      .join("");
    rows.push(`<label><span>${esc(label)}</span><select data-me-source="${esc(source)}">${options}</select></label>`);
  }
  picker.innerHTML = rows.join("");
  identity.hidden = !rows.length;
  const needsAttention = Boolean(summary.warnings.length && !state.me);
  warning.hidden = !needsAttention;
  if (needsAttention) {
    identity.open = true;
  }
}

function itemHtml(friend, asOf) {
  const app = APP_LINKS[friend.source] || { label: friend.source, url: "#" };
  const rate = responseRate(friend);

  const meta = [];
  if (friend.unansweredStreak && friend.waitingSince != null) {
    meta.push(`<span class="pill pill-warn">${icon("clock", 12)}Waiting ${esc(duration(friend.waitingSince, asOf))}</span>`);
  }
  if (friend.pending.length) {
    meta.push(`<span class="pill pill-danger">${friend.pending.length} unanswered share${friend.pending.length === 1 ? "" : "s"}</span>`);
  }
  meta.push(`<span>Your last message: ${esc(daysAgo(friend.lastFromMe, asOf))}</span>`);

  const suggestion = friend.opener
    ? `<div class="suggestion">
         <div class="suggestion-label">Suggested message</div>
         <p class="suggestion-text">${esc(friend.opener)}</p>
         <div class="suggestion-actions">
           <button class="btn btn-ghost btn-sm" data-copy="${esc(friend.opener)}">${icon("copy", 14)}Copy</button>
           <a class="btn btn-ghost btn-sm" href="${esc(app.url)}" target="_blank" rel="noopener">${icon("external", 14)}Open ${esc(app.label)}</a>
         </div>
       </div>`
    : `<div class="suggestion-actions solo">
         <a class="btn btn-secondary btn-sm" href="${esc(app.url)}" target="_blank" rel="noopener">${icon("external", 14)}Open ${esc(app.label)}</a>
       </div>`;

  const rateBlock = rate == null
    ? ""
    : `<span class="rate"><span class="meter"><i style="width:${Math.round(rate * 100)}%"></i></span>${Math.round(rate * 100)}% of shares answered</span>`;

  const links = [...friend.pending]
    .reverse()
    .slice(0, 6)
    .map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.kind)}</a> <span class="muted">· ${esc(daysAgo(p.ts, asOf))}</span></li>`)
    .join("");
  const shared = links
    ? `<details class="shared"><summary>View shared items (${friend.pending.length})</summary><ul>${links}</ul></details>`
    : "";

  return `
  <article class="card item" data-key="${esc(friend.key)}">
    <div class="item-head">
      <div class="avatar" style="--hue:${hue(friend.friend)}">${esc(initials(friend.friend))}</div>
      <div class="item-title">
        <div class="item-name"><strong>${esc(friend.friend)}</strong><span class="app-badge">${esc(app.label)}</span></div>
        <div class="item-meta">${meta.join("")}</div>
      </div>
      <button class="btn btn-secondary btn-sm done" data-done="${esc(friend.key)}" title="Mark as replied">${icon("check", 14)}<span class="label">Mark replied</span></button>
    </div>
    <p class="item-summary">${esc(friend.nudge)}</p>
    ${suggestion}
    <div class="item-foot">
      ${rateBlock}
      <span>Conversations started: them ${friend.theirStarts}, you ${friend.myStarts}</span>
      ${shared}
    </div>
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
    setButtonLabel(button, "Checking…");
    try {
      await refreshFromFolder({ ask: true, quiet: false });
    } finally {
      button.disabled = false;
      renderSourceBar();
    }
  });

  $("forget-button").addEventListener("click", async () => {
    if (!confirm("Delete all Nudge data stored on this device?")) {
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
    renderWelcomeExtras();
    show("welcome-view");
    toast("All data deleted from this device");
  });

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button, a");
    if (!target) {
      return;
    }
    if (target.dataset.action === "pick-files") {
      event.preventDefault();
      fileInput.click();
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
        toast("Message copied to clipboard");
      } catch {
        toast("Could not copy. Select the text instead");
      }
      return;
    }
    if (target.dataset.done) {
      const card = target.closest(".card");
      state.done[target.dataset.done] = Date.now();
      save();
      card.classList.add("leaving");
      setTimeout(renderResults, 250);
      toast("Marked as replied");
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

  // Installed app on Windows/ChromeOS: "Open with Nudge" on a .zip / .json / .txt lands here.
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
  hydrateIcons();
  wireEvents();
  setupInstall();
  renderWelcomeExtras();

  const params = new URLSearchParams(location.search);
  if (params.has("demo")) {
    await loadDemo();
    return;
  }

  // 1. Show the last results instantly, then load the stored chats behind them.
  if (restore()) {
    show("results-view");
    renderResults();
  } else {
    show("welcome-view");
  }
  if (await restoreThreads()) {
    runAnalysis();
    show("results-view");
    renderResults();
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
