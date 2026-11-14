"use strict";
// Bump this version whenever you deploy updated application files.
const CACHE_PREFIX = "proscan-studio-";
const CACHE_NAME = `${CACHE_PREFIX}stage4-2-2026-11-13-1`;
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./paper-match.js",
  "./local-repair-core.js",
  "./vision.js",
  "./filter-client.js",
  "./filter-worker.js",
  "./filter-core.js",
  "./pdf-image-codec.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/opencv-4.5.4.js",
  "./vendor/jspdf-2.5.1.umd.min.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(
        ASSETS.map(
          (path) =>
            new Request(new URL(path, self.registration.scope).href, {
              cache: "reload",
            }),
        ),
      ),
    ),
  );
  // Existing users explicitly accept the waiting update; no surprise reloads.
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const known = ASSETS.map(
    (path) => new URL(path, self.registration.scope).href,
  );
  if (
    request.mode === "navigate" &&
    url.href.startsWith(self.registration.scope)
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        return (
          (await cache.match(
            new URL("./index.html", self.registration.scope).href,
          )) || fetch(request)
        );
      }),
    );
    return;
  }
  if (!known.includes(url.href)) return;
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => (await cache.match(request)) || fetch(request)),
  );
});
