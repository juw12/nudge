// Tiny IndexedDB key-value store (on-device only). Holds parsed chat threads, the connected
// folder handle, and files shared to the app — none of it ever leaves the browser.
const DB_NAME = "nudge";
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export function idbGet(key) {
  return run("readonly", (store) => store.get(key));
}

export function idbSet(key, value) {
  return run("readwrite", (store) => store.put(value, key));
}

export function idbDelete(key) {
  return run("readwrite", (store) => store.delete(key));
}

export function idbClear() {
  return run("readwrite", (store) => store.clear());
}

// ------------------------------------------------------------------ threads

// Keep only what the analysis needs: who sent what kind of thing when. No message text.
export function compactThread(thread) {
  return {
    id: thread.id,
    title: thread.title,
    source: thread.source,
    me: thread.me || null,
    participants: [...thread.participants],
    messages: thread.messages.map((m) => ({
      sender: m.sender,
      ts: m.ts,
      shareUrl: m.shareUrl || null,
      reactions: m.reactions || [],
    })),
  };
}

export function reviveThread(stored) {
  return {
    ...stored,
    participants: new Set(stored.participants),
    messages: stored.messages.map((m) => ({ text: "", ...m })),
  };
}

// Union of two exports of the same chat (e.g. "last month" then "last week").
function mergeOne(older, newer) {
  const byKey = new Map();
  for (const message of [...older.messages, ...newer.messages]) {
    byKey.set(`${message.ts}|${message.sender}|${message.shareUrl || ""}`, message);
  }
  const messages = [...byKey.values()].sort((a, b) => a.ts - b.ts);
  return {
    ...newer,
    participants: new Set([...older.participants, ...newer.participants]),
    messages,
  };
}

export function mergeThreads(existing, incoming) {
  const byId = new Map(existing.map((thread) => [thread.id, thread]));
  for (const thread of incoming) {
    const previous = byId.get(thread.id);
    byId.set(thread.id, previous ? mergeOne(previous, thread) : thread);
  }
  return [...byId.values()];
}
