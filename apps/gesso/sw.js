// Offline app shell for Gesso. Bump CACHE whenever any shell file changes.
// Every module must be listed: a missing one breaks offline start-up, and
// test/sw-shell.test.mjs checks the list against the files on disk.
const CACHE = 'gesso-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-mask-512.png',
  './lib/autofix.js',
  './lib/develop.js',
  './lib/doc.js',
  './lib/geometry.js',
  './lib/gestures.js',
  './lib/heal.js',
  './lib/hints.js',
  './lib/history.js',
  './lib/image-io.js',
  './lib/inpaint.js',
  './lib/level.js',
  './lib/patches.js',
  './lib/ruler.js',
  './lib/stroke.js',
  './lib/text-layout.js',
  './lib/view.js',
  './ui/autosave.js',
  './ui/captions.js',
  './ui/editor.js',
  './ui/hints-ui.js',
  './ui/importer.js',
  './ui/panel.js',
  './ui/probe.js',
  './ui/renderer.js',
  './ui/ruler-view.js',
  './ui/savesheet.js',
  './ui/store.js',
  './ui/tape.js',
  './ui/tools/color.js',
  './ui/tools/crop.js',
  './ui/tools/dials.js',
  './ui/tools/home.js',
  './ui/tools/light.js',
  './ui/tools/remove.js',
  './ui/tools/text.js',
  './workers/heal-worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' bypasses the HTTP cache so a new shell is never seeded
      // with stale copies of the old one.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // The origin is shared with other apps (e.g. /textlock/): only retire our own.
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('gesso-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first with no-cache, so a deploy never mixes fresh and 10-minute-stale
// modules from the HTTP cache; the shell cache keeps it working offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('./'))
        .then((cached) => cached || caches.match('./index.html'))),
  );
});
