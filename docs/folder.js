// "Connect a folder": remember a folder (usually Downloads) and pick up new chat exports
// from it automatically. Uses the File System Access API (Chrome / Edge on desktop).
import { idbDelete, idbGet, idbSet } from "./store.js";

const HANDLE_KEY = "folderHandle";
const MAX_DEPTH = 6;
const MAX_ENTRIES = 25000;
const SKIP_DIRS = /^(\.|node_modules$|\$recycle\.bin$|appdata$)/i;

export const folderSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;

export async function connectFolder() {
  const handle = await window.showDirectoryPicker({ id: "nudge-exports", mode: "read", startIn: "downloads" });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

export function savedFolder() {
  return idbGet(HANDLE_KEY);
}

export function forgetFolder() {
  return idbDelete(HANDLE_KEY);
}

// Returns true if we may read the folder. Only asks the user when `ask` is true (needs a click).
export async function canRead(handle, ask = false) {
  const options = { mode: "read" };
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }
  if (!ask) {
    return false;
  }
  return (await handle.requestPermission(options)) === "granted";
}

// Which "slot" an export belongs to. For zips/txt only the newest file per slot is used,
// so re-downloading next week replaces last week's export instead of double counting.
export function exportSlot(path) {
  const name = path.split("/").pop();
  const lower = name.toLowerCase();
  if (/\.zip$/.test(lower) && /^(instagram|facebook|meta)[-_]/.test(lower)) {
    return `meta:${lower.replace(/[-_]\d{4}[-_]\d{2}[-_]\d{2}.*$/, "").replace(/\.zip$/, "")}`;
  }
  const whatsapp = name.match(/^WhatsApp Chat(?: with| -)?\s*(.+?)(?:\s*\(\d+\))?\.(zip|txt)$/i);
  if (whatsapp) {
    return `whatsapp:${whatsapp[1].toLowerCase()}`;
  }
  if (/(^|\/)result[^/]*\.json$/i.test(path)) {
    return `telegram:${path.toLowerCase()}`;
  }
  if (/\/messages\/(inbox|message_requests)\/[^/]+\/message_\d+\.json$/i.test(path)) {
    return `unzipped:${path.toLowerCase()}`;
  }
  return null;
}

export async function scanFolder(handle, onProgress = () => {}) {
  const newest = new Map();
  let visited = 0;

  async function walk(directory, prefix, depth) {
    for await (const entry of directory.values()) {
      visited += 1;
      if (visited > MAX_ENTRIES) {
        return;
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (depth < MAX_DEPTH && !SKIP_DIRS.test(entry.name)) {
          await walk(entry, path, depth + 1);
        }
        continue;
      }
      const slot = exportSlot(path);
      if (!slot) {
        continue;
      }
      const file = await entry.getFile();
      const current = newest.get(slot);
      if (!current || file.lastModified > current.file.lastModified) {
        newest.set(slot, { path, file });
      }
    }
  }

  onProgress(`Looking for chat exports in “${handle.name}”…`);
  await walk(handle, "", 0);
  const items = [...newest.values()].sort((a, b) => a.path.localeCompare(b.path));
  const signature = items.map((item) => `${item.path}:${item.file.size}:${item.file.lastModified}`).join("|");
  return { items, signature };
}
