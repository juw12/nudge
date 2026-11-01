// Turn whatever the user drops (zips, JSON, WhatsApp .txt) into chat threads.
import {
  isInstagramFile,
  isTelegramData,
  looksLikeWhatsApp,
  parseInstagram,
  parseTelegram,
  parseWhatsApp,
  whatsAppTitle,
} from "./engine.js";
import { listZip, readEntryText } from "./zip.js";

const MAX_TEXT_BYTES = 200 * 1024 * 1024;

function isInteresting(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("__macosx/")) {
    return false;
  }
  return isInstagramFile(lower) || /(^|\/)result[^/]*\.json$/.test(lower) || lower.endsWith(".txt");
}

// Route one text file to the right parser. Instagram files are collected and parsed together.
function routeText(name, text, containerName, sink) {
  const lower = name.toLowerCase();
  if (isInstagramFile(lower)) {
    sink.instagram.push({ name, text });
    return;
  }
  if (lower.endsWith(".json")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      sink.skipped.push(name);
      return;
    }
    if (data && Array.isArray(data.participants) && Array.isArray(data.messages)) {
      sink.instagram.push({ name, text });
    } else if (isTelegramData(data)) {
      sink.threads.push(...parseTelegram(data));
    } else {
      sink.skipped.push(name);
    }
    return;
  }
  if (lower.endsWith(".txt") && looksLikeWhatsApp(text)) {
    // iOS zips contain "_chat.txt"; the zip's own name carries the contact name.
    const baseName = name.split("/").pop();
    const title = /^_?chat\.txt$/i.test(baseName) && containerName ? whatsAppTitle(containerName) : whatsAppTitle(name);
    sink.threads.push(...parseWhatsApp(text, title));
    return;
  }
  sink.skipped.push(name);
}

export async function loadFiles(files, onProgress = () => {}) {
  const sink = { threads: [], instagram: [], skipped: [] };
  let index = 0;
  for (const file of files) {
    index += 1;
    const label = file.webkitRelativePath || file.name;
    onProgress(`Reading ${label} (${index}/${files.length})…`);
    if (/\.zip$/i.test(file.name)) {
      const entries = (await listZip(file)).filter((entry) => isInteresting(entry.name) && entry.size < MAX_TEXT_BYTES);
      let done = 0;
      for (const entry of entries) {
        done += 1;
        if (done % 25 === 0) {
          onProgress(`Unpacking ${file.name}: ${done}/${entries.length} chats…`);
        }
        routeText(entry.name, await readEntryText(file, entry), file.name, sink);
      }
    } else if (file.size < MAX_TEXT_BYTES) {
      routeText(label, await file.text(), null, sink);
    } else {
      sink.skipped.push(label);
    }
  }
  if (sink.instagram.length) {
    onProgress(`Analysing ${sink.instagram.length} Instagram/Messenger chat files…`);
    sink.threads.push(...parseInstagram(sink.instagram));
  }
  return { threads: sink.threads, skipped: sink.skipped };
}
