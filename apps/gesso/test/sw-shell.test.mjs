// The offline shell (SPEC check 14): sw.js must precache every module the app can
// load, nothing that is not on disk (one 404 fails the whole install), and on
// activate retire only its own 'gesso-' caches — the origin is shared with other
// apps. sw.js runs here in a sandbox with a fake service-worker global, so these
// tests check what it does, not how its source happens to be written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, posix } from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const ORIGIN = 'https://gesso.test';

function loadWorker({ cacheKeys = [] } = {}) {
  const listeners = {};
  const precached = [];
  const opened = [];
  const deleted = [];
  const caches = {
    async open(name) {
      opened.push(name);
      return {
        async addAll(list) { for (const r of list) precached.push(typeof r === 'string' ? r : r.url); },
        async put() {},
      };
    },
    async keys() { return cacheKeys; },
    async delete(key) { deleted.push(key); return true; },
    async match() { return undefined; },
  };
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/gesso/sw.js` },
    addEventListener(type, fn) { listeners[type] = fn; },
    async skipWaiting() {},
    clients: { async claim() {} },
  };
  class Request {
    constructor(url, init = {}) { this.url = url; this.cache = init.cache; this.method = 'GET'; }
  }
  vm.runInNewContext(SOURCE, { self, caches, Request, URL, console, fetch: async () => { throw new Error('offline'); } });
  return { listeners, precached, opened, deleted };
}

async function fire(listener) {
  let pending = Promise.resolve();
  listener({ waitUntil(p) { pending = p; } });
  await pending;
}

async function installed() {
  const w = loadWorker();
  assert.equal(typeof w.listeners.install, 'function', 'sw.js has an install handler');
  await fire(w.listeners.install);
  return { shell: w.precached, cache: w.opened[0] };
}

// './lib/doc.js' and 'lib/doc.js' are the same entry.
const norm = (p) => {
  const n = posix.normalize(p.replace(/^\.\//, ''));
  return n === '.' || n === '' ? './' : n;
};

function walk(dir) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const full = join(abs, name);
    if (statSync(full).isDirectory()) out.push(...walk(join(dir, name)));
    else out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

test('the shell is precached into a gesso- cache', async () => {
  const { shell, cache } = await installed();
  assert.ok(shell.length > 0, 'install precaches something');
  assert.match(cache, /^gesso-/);
});

// SPEC check 14 says every file, not every module: ui/tape.css is fetched at run
// time too. Dotfiles (editor droppings) are not part of the app.
test('every file under lib/, ui/, workers/ and studio/ is in the shell', async () => {
  const shell = new Set((await installed()).shell.map(norm));
  const files = ['lib', 'ui', 'workers', 'studio'].flatMap(walk).filter((f) => !f.split('/').some((part) => part.startsWith('.')));
  assert.ok(files.filter((f) => f.endsWith('.js')).length > 10, 'found the app modules');
  const missing = files.filter((f) => !shell.has(f));
  assert.deepEqual(missing, [], `add to SHELL in sw.js: ${missing.map((f) => `'./${f}'`).join(', ')}`);
});

test('the root shell files are in the shell', async () => {
  const shell = new Set((await installed()).shell.map(norm));
  const required = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest'];
  // Everything the page and the manifest point at: icons, the stylesheet, the entry module.
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"#:]+)"/g)) required.push(m[1]);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons ?? []) required.push(icon.src);
  const missing = [...new Set(required.map(norm))].filter((f) => !shell.has(f));
  assert.deepEqual(missing, [], `add to SHELL in sw.js: ${missing.join(', ')}`);
});

test('every shell entry exists on disk, once', async () => {
  const { shell } = await installed();
  const entries = shell.map(norm);
  const dupes = entries.filter((e, i) => entries.indexOf(e) !== i);
  assert.deepEqual(dupes, [], 'no entry is listed twice');
  const absent = entries.filter((e) => e !== './' && !existsSync(join(ROOT, e)));
  assert.deepEqual(absent, [], 'a missing file fails cache.addAll and with it the whole install');
});

test('every module a shell module imports is in the shell too', async () => {
  const shell = new Set((await installed()).shell.map(norm));
  const missing = new Set();
  for (const file of [...shell].filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const specs = [
      ...src.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
      ...src.matchAll(/\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g),
      ...src.matchAll(/new\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const target = norm(posix.join(posix.dirname(file), spec));
      if (!shell.has(target)) missing.add(`${target} (from ${file})`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('activate deletes only old gesso- caches', async () => {
  const { cache } = await installed();
  const keys = ['gesso-v0', cache, 'gesso-old-shell', 'textlock-v3', 'textlock-gesso-v1', 'workbox-precache', 'gesso', 'Gesso-v0'];
  const w = loadWorker({ cacheKeys: keys });
  assert.equal(typeof w.listeners.activate, 'function', 'sw.js has an activate handler');
  await fire(w.listeners.activate);
  assert.deepEqual(w.deleted.sort(), ['gesso-old-shell', 'gesso-v0']);
});

test('the shell list in the source matches what install precaches', async () => {
  // A cheap guard against SHELL being built in a way the sandbox cannot see.
  const literal = SOURCE.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(literal, 'sw.js declares const SHELL = [ ... ]');
  const listed = [...literal[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => norm(m[1]));
  const { shell } = await installed();
  assert.deepEqual(shell.map(norm), listed);
});
