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
  './lib/caption-edit.js',
  './lib/develop.js',
  './lib/doc.js',
  './lib/draft.js',
  './lib/export-plan.js',
  './lib/geometry.js',
  './lib/gestures.js',
  './lib/heal.js',
  './lib/hints.js',
  './lib/history.js',
  './lib/image-io.js',
  './lib/inpaint.js',
  './lib/lasso.js',
  './lib/level.js',
  './lib/navpan.js',
  './lib/patches.js',
  './lib/remove-plan.js',
  './lib/ruler.js',
  './lib/stroke.js',
  './lib/tape.js',
  './lib/text-layout.js',
  './lib/view.js',
  './ui/autosave.js',
  './ui/captions.js',
  './ui/editor.js',
  './ui/exporter.js',
  './ui/heal-client.js',
  './ui/hints-ui.js',
  './ui/importer.js',
  './ui/navigator.js',
  './ui/panel.js',
  './ui/probe.js',
  './ui/renderer.js',
  './ui/ruler-view.js',
  './ui/savesheet.js',
  './ui/store.js',
  './ui/tape.css',
  './ui/tape.js',
  './ui/tools/color.js',
  './ui/tools/crop.js',
  './ui/tools/dials.js',
  './ui/tools/home.js',
  './ui/tools/light.js',
  './ui/tools/remove.js',
  './ui/tools/text.js',
  './workers/export-worker.js',
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
// A network that takes requests but never answers (one bar, a dead captive
// portal) must not hold the app until the OS gives up: after NETWORK_WAIT_MS the
// cached copy answers, and for SLOW_MS after that the cache answers at once (the
// module graph is several requests deep). A late network answer still refreshes
// the cache.
const NETWORK_WAIT_MS = 2500;
const SLOW_MS = 30000;
let slowUntil = 0;

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const navigate = event.request.mode === 'navigate';
  const cached = () => caches.match(event.request, { ignoreSearch: true })
    .then((hit) => hit || (navigate ? caches.match('./') : undefined))
    .then((hit) => hit || (navigate ? caches.match('./index.html') : undefined));
  const network = fetch(event.request, { cache: 'no-cache' }).then((response) => {
    slowUntil = 0;
    if (response.ok) {
      const copy = response.clone();
      const put = caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      try { event.waitUntil(put); } catch { /* already answered from the cache */ }
    }
    return response;
  });
  event.respondWith(new Promise((resolve, reject) => {
    let done = false;
    const answer = (response) => {
      if (done || !response) return;
      done = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => {
      slowUntil = Date.now() + SLOW_MS;
      cached().then(answer);
    }, Date.now() < slowUntil ? 0 : NETWORK_WAIT_MS);
    network.then(answer, (err) => cached().then((hit) => (hit ? answer(hit) : !done && reject(err))));
  }));
});
