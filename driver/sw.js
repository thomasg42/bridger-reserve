/* Bridger Reserve Driver app shell. Bump CACHE on every deploy. Never caches the ledger API or routing answers. */
const CACHE = "br-driver-2026-11-10-1";
const SHELL = ["./", "./index.html", "./driver.css", "./driver.js", "./trip.js", "./config.js", "./manifest.webmanifest", "../fare.js", "../quote-core.js", "../places.js", "../favicon.svg", "../assets/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("br-driver-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/* network first, so a deploy shows up at once; the cached shell opens the app with no signal */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("./index.html"))),
  );
});
