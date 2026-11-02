// Offline support + Android share target.
const CACHE = "nudge-v2";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "engine.js",
  "loader.js",
  "zip.js",
  "store.js",
  "folder.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "demo/nudge-demo.zip",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

// --- share target: "Export chat → nudge" on Android posts the file here -------------------

function putSharedFiles(files) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("nudge", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("kv", "readwrite");
      const store = transaction.objectStore("kv");
      const read = store.get("sharedInbox");
      read.onsuccess = () => {
        store.put([...(read.result || []), ...files], "sharedInbox");
      };
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

async function handleShare(request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((value) => value instanceof File);
  for (const value of form.getAll("text")) {
    // Some apps share chat text instead of a file.
    if (typeof value === "string" && value.trim()) {
      files.push(new File([value], "shared-chat.txt", { type: "text/plain" }));
    }
  }
  if (files.length) {
    await putSharedFiles(files);
  }
  return Response.redirect("./?shared=1", 303);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) {
    return;
  }
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(handleShare(event.request));
    return;
  }
  if (event.request.method !== "GET") {
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: url.pathname.endsWith("/") }).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok && !url.search) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
