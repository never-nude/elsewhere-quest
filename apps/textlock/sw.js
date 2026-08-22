// Offline app shell for TextLock. Bump CACHE when any shell file changes.
const CACHE = 'textlock-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lib/lock.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-mask-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' bypasses the HTTP cache so a freshly bumped shell
      // can never be seeded with stale copies of the old one.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first so deploys land promptly; cache fallback keeps it working offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      // './' is the runtime-refreshed copy of the shell page; the install-time
      // './index.html' entry is the last resort.
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('./'))
        .then((cached) => cached || caches.match('./index.html'))),
  );
});
