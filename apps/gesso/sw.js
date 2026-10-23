// Offline app shell for Gesso. The Pages deploy stamps CACHE with a hash of the app
// (.github/workflows/deploy.yml), so every deploy installs a whole new shell; change
// it by hand only to try an update locally.
// Every module must be listed: a missing one breaks offline start-up, and
// test/sw-shell.test.mjs checks the list against the files on disk.
const CACHE = 'gesso-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './studio/index.html',
  './studio/studio.css',
  './studio/app.js',
  './studio/model.js',
  './studio/engine.js',
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
  './lib/magnifier.js',
  './lib/navpan.js',
  './lib/native-bridge.js',
  './lib/outline-paint.js',
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
  './ui/magnifier.js',
  './ui/navigator.js',
  './ui/panel.js',
  './ui/platform.js',
  './ui/probe.js',
  './ui/renderer.js',
  './ui/ruler-view.js',
  './ui/savesheet.js',
  './ui/store.js',
  './ui/subject.js',
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

// No skipWaiting: a page that is already open keeps the shell it started with (the
// workers it starts later included), and the new shell takes over at the next launch.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' bypasses the HTTP cache so a new shell is never seeded
      // with stale copies of the old one.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))),
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

// Cache-first from this worker's own shell, which install filled in one piece: a page
// runs exactly one deploy, online or offline, and never pulls a module or a worker
// from another. Responses are never written back into the shell.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => (
    (await cache.match(event.request, { ignoreSearch: true }))
    ?? (event.request.mode === 'navigate' ? await cache.match(url.pathname.endsWith('/studio/') ? './studio/index.html' : './') : undefined)
    ?? fetch(event.request)
  )));
});
