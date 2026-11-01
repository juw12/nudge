// reachback widget for Scriptable (iOS / iPadOS) — https://scriptable.app
//
// Shows "Maya + 2 others are waiting on you" on your home screen, and can fire a
// notification when you open Instagram / TikTok (via a Shortcuts automation).
//
// Setup (once):
//   1. On your computer, run:  reachback schedule <exports> --out "<a cloud folder>"
//      (iCloud Drive, OneDrive, Dropbox... anything the Files app can see).
//   2. In Scriptable: Settings -> File Bookmarks -> add that folder, name it  reachback
//   3. Add this script to Scriptable, then add a Scriptable widget and pick this script.
//   4. Optional nudge-before-feed: Shortcuts -> Automation -> App -> Instagram -> "Is Opened"
//      -> Run Script (Scriptable) "reachback-widget" with parameter  notify  -> Run Immediately.

const BOOKMARK = "reachback";
const FILE_NAME = "status.json";

// Deep links that open the app where the friend is waiting.
const APP_URLS = {
  instagram: "instagram://direct-inbox",
  messenger: "fb-messenger://",
  whatsapp: "whatsapp://",
  telegram: "tg://",
  imessage: "sms:",
};

async function loadStatus() {
  const fm = FileManager.iCloud();
  let folder;
  if (fm.bookmarkExists(BOOKMARK)) {
    folder = fm.bookmarkedPath(BOOKMARK);
  } else {
    folder = fm.joinPath(fm.documentsDirectory(), "reachback");
  }
  const path = fm.joinPath(folder, FILE_NAME);
  if (!fm.fileExists(path)) {
    return null;
  }
  if (!fm.isFileDownloaded(path)) {
    await fm.downloadFileFromiCloud(path);
  }
  return JSON.parse(fm.readString(path));
}

function addText(stack, text, size, color, bold) {
  const line = stack.addText(text);
  line.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  line.textColor = new Color(color);
  line.lineLimit = 2;
  line.minimumScaleFactor = 0.7;
  return line;
}

function buildWidget(status) {
  const widget = new ListWidget();
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#ff5f6d"), new Color("#ffc371")];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;
  widget.setPadding(14, 14, 14, 14);

  if (!status) {
    addText(widget, "reachback", 13, "#3b1d1d", true);
    widget.addSpacer(6);
    addText(widget, "No status.json yet. Run `reachback digest` and bookmark the folder.", 12, "#1b1b1b", false);
    return widget;
  }

  addText(widget, "💌 reachback", 12, "#3b1d1d", true);
  widget.addSpacer(4);
  addText(widget, status.headline, 16, "#1b1b1b", true);
  widget.addSpacer(6);

  const family = config.widgetFamily || "medium";
  const rows = family === "small" ? 1 : family === "medium" ? 2 : 5;
  for (const friend of status.top.slice(0, rows)) {
    const parts = [];
    if (friend.pending) {
      parts.push(`${friend.pending} unseen`);
    }
    if (friend.waiting_days !== null && friend.waiting_messages) {
      parts.push(`waiting ${friend.waiting_days}d`);
    }
    addText(widget, `• ${friend.friend} · ${parts.join(" · ")}`, 12, "#2a1a1a", false);
  }

  widget.addSpacer();
  if (status.data_age_days >= 7) {
    addText(widget, `data is ${status.data_age_days}d old`, 10, "#5a2a2a", false);
  }

  const first = status.top[0];
  if (first && APP_URLS[first.source]) {
    widget.url = APP_URLS[first.source];
  }
  widget.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);
  return widget;
}

async function sendNudge(status) {
  if (!status || !status.top.length) {
    return;
  }
  const first = status.top[0];
  const notification = new Notification();
  notification.title = status.headline;
  notification.body = first.opener ? `Before you scroll, try: "${first.opener}"` : first.nudge;
  if (APP_URLS[first.source]) {
    notification.openURL = APP_URLS[first.source];
  }
  await notification.schedule();
}

async function showInApp(status) {
  if (!status || !status.top.length) {
    const alert = new Alert();
    alert.title = "reachback";
    alert.message = status ? status.headline : "No status.json found yet.";
    alert.addAction("OK");
    await alert.present();
    return;
  }
  const table = new UITable();
  for (const friend of status.top) {
    const row = new UITableRow();
    row.height = 70;
    const cell = row.addText(friend.friend, friend.opener ? `Tap to copy: ${friend.opener}` : friend.nudge);
    cell.subtitleFont = Font.systemFont(12);
    row.dismissOnSelect = true;
    row.onSelect = () => {
      if (friend.opener) {
        Pasteboard.copy(friend.opener);
      }
      if (APP_URLS[friend.source]) {
        Safari.open(APP_URLS[friend.source]);
      }
    };
    table.addRow(row);
  }
  await table.present();
}

async function main() {
  const status = await loadStatus();
  const parameter = (args.shortcutParameter || args.queryParameters.mode || "").toString();

  if (config.runsInWidget) {
    Script.setWidget(buildWidget(status));
  } else if (parameter === "notify") {
    await sendNudge(status);
    Script.setShortcutOutput(status ? status.headline : "");
  } else {
    await showInApp(status);
  }
  Script.complete();
}

await main();
