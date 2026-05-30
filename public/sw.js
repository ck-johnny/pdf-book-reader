// Minimal service worker: pass-through fetch + claim clients.
// Required by Chrome on Android to mark the app as installable.
const CACHE = "pdf-book-reader-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        const network = await fetch(request);
        if (network && network.ok && new URL(request.url).origin === self.location.origin) {
          const cache = await caches.open(CACHE);
          cache.put(request, network.clone()).catch(() => {});
        }
        return network;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
