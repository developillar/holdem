/**
 * Service worker: makes the app installable and fully playable offline.
 *
 * Strategy is deliberately simple because the whole app is a handful of
 * fingerprinted, immutable build assets:
 *   • navigations  → network-first, falling back to the cached shell, so a
 *                    fresh deploy is picked up but a dead network still opens
 *                    the app from the home screen;
 *   • everything else → cache-first, since Vite fingerprints every asset and a
 *                    changed file is always a different URL.
 *
 * VERSION must change on every deploy — the deploy script rewrites it.
 */
const VERSION = 'royale-041b39a';
const SHELL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.add(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }),
    ),
  );
});
