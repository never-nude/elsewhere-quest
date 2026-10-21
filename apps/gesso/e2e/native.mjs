#!/usr/bin/env node
// Native UI contract checks in desktop Chromium/WebKit. The production adapter
// still sees issued gesso:// URLs; a test-only fetch adapter maps their bytes to
// Playwright routes. WKURLSchemeHandler itself is checked in the Simulator.
// Run after the timing-sensitive acceptance suite, with no other browser work:
// node e2e/native.mjs [--base http://127.0.0.1:4174/gesso/] [--browser all] [--out /tmp/gesso-native]

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { FIXTURE, writeFixture } from './fixture.mjs';

const opts = { base: 'http://127.0.0.1:4174/gesso/', browser: 'all', out: join(tmpdir(), 'gesso-native') };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help') {
    console.log('node e2e/native.mjs [--base URL] [--browser chromium|webkit|all] [--only 1,3] [--out DIR]');
    process.exit(0);
  }
  if (!['--base', '--browser', '--out', '--only'].includes(key) || !process.argv[i + 1]) throw new Error(`Invalid option: ${key}`);
  opts[key.slice(2)] = process.argv[++i];
}
if (!['chromium', 'webkit', 'all'].includes(opts.browser)) throw new Error('--browser must be chromium, webkit or all');
if (opts.only) {
  if (!/^([1-6],)*[1-6]$/.test(opts.only)) throw new Error('--only must list check numbers 1–6');
  opts.only = new Set(opts.only.split(',').map(Number));
}
if (!opts.base.endsWith('/')) opts.base += '/';
const base = new URL(opts.base);
const fixtureSpec = { ...FIXTURE, width: 1200, height: 900, speck: { x: 345, y: 210, diameter: 20 }, name: 'gesso-native-fixture.jpg' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await delay(20); }
  throw new Error(message);
}

async function loadPlaywright() {
  const paths = [process.env.PLAYWRIGHT_MODULE, 'playwright'];
  try { paths.push(pathToFileURL(join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright/index.mjs')).href); } catch {}
  paths.push('/opt/homebrew/lib/node_modules/playwright/index.mjs');
  for (const path of paths.filter(Boolean)) {
    try { const module = await import(path); if (module.chromium && module.webkit) return module; } catch {}
  }
  throw new Error('Playwright is unavailable; set PLAYWRIGHT_MODULE to its index.mjs');
}

function installStub({ origin }) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const value = typeof input === 'string' ? input : input?.url;
    if (value?.startsWith('gesso://localhost/xfer/')) {
      const url = new URL(value);
      return originalFetch(`${origin}/__gesso_native_xfer__/${url.pathname.slice('/xfer/'.length)}`, init);
    }
    return originalFetch(input, init);
  };
  const counters = { serviceWorkers: 0, webShares: 0 };
  Object.defineProperty(globalThis, '__gessoNativeTest', { value: counters });
  Object.defineProperty(globalThis, '__gessoNative', { value: Object.freeze({
    api: 1, bridge: 'gesso', origin: 'gesso://localhost', app: 'test', build: '1', web: 'native-harness',
    capabilities: ['photos', 'decode', 'subject', 'haptic', 'transfer-post'],
  }) });
  const webkit = globalThis.webkit ?? {};
  Object.defineProperty(webkit, 'messageHandlers', { configurable: true, value: {
    gesso: { postMessage: (message) => globalThis.__gessoHarnessOp(message) },
  } });
  if (!globalThis.webkit) Object.defineProperty(globalThis, 'webkit', { value: webkit });
  try {
    if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value() {
      counters.serviceWorkers++;
      return Promise.reject(new Error('The native bundle must not register a service worker'));
    } });
  } catch { /* an initial about:blank document can have an opaque origin */ }
  Object.defineProperty(navigator, 'share', { configurable: true, value() {
    counters.webShares++;
    return Promise.reject(new Error('Native saving must not use Web Share'));
  } });
}

function newState(assets) {
  const state = {
    entries: new Map(), calls: [], gets: [], posts: [], problems: [], pending: [],
    pick: 'jpeg', save: 'saved', share: 'airdrop', subject: 'found', subjectShape: 'small',
  };
  state.issue = (body, { name = 'photo.jpg', type = 'image/jpeg', raw = false, size = body?.length } = {}) => {
    const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'dng';
    const ref = { url: `gesso://localhost/xfer/${randomUUID()}.${ext}`, name, type, size };
    state.entries.set(ref.url, { ...ref, body, raw });
    return ref;
  };
  const failure = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
  const complete = (url) => {
    const file = state.entries.get(url);
    assert.ok(file?.body, `operation reads a completed issued file: ${url}`);
    return file;
  };
  state.dispatch = async ({ op, args }) => {
    switch (op) {
      case 'ping': return { api: 1, origin: 'gesso://localhost', app: 'test', build: '1', web: 'native-harness', capabilities: ['photos', 'decode', 'subject', 'haptic', 'transfer-post'], os: 'test' };
      case 'photo.pick':
        if (state.pick === 'cancel') return null;
        if (state.pick === 'failed') return failure('unreadable');
        return state.pick === 'raw'
          ? state.issue(Buffer.from([73, 73, 42, 0, 0, 0, 0, 0]), { name: 'camera-original.dng', type: 'image/dng', raw: true })
          : state.issue(assets.jpeg, { name: fixtureSpec.name });
      case 'image.info': return { natW: fixtureSpec.width, natH: fixtureSpec.height, raw: complete(args.url).raw };
      case 'image.decode': {
        complete(args.url);
        assert.equal(args.w, fixtureSpec.width, 'JS asks for the exact native-rendered width');
        assert.equal(args.h, fixtureSpec.height, 'JS asks for the exact native-rendered height');
        return { ...state.issue(assets.png, { name: 'camera-rendered.png', type: 'image/png' }), w: args.w, h: args.h };
      }
      case 'xfer.create':
        assert.ok(Number.isInteger(args.size) && args.size > 0);
        return state.issue(null, args);
      case 'xfer.release': state.entries.delete(args.url); return {};
      case 'photos.save': {
        const file = complete(args.url);
        assert.equal(file.body[0], 255); assert.equal(file.body[1], 216, 'Photos receives a JPEG');
        if (state.save === 'defer') return new Promise((resolve) => state.pending.push({ op, resolve, url: args.url }));
        if (state.save === 'cancel') return failure('cancelled');
        return state.save === 'saved' ? { saved: true } : { saved: false, reason: state.save };
      }
      case 'share':
        complete(args.url);
        if (state.share === 'failed') return failure('failed');
        return { completed: state.share !== 'cancel', activity: state.share === 'photos' ? 'com.apple.UIKit.activity.SaveToCameraRoll' : state.share === 'cancel' ? null : 'com.apple.UIKit.activity.AirDrop' };
      case 'subject.mask': {
        const file = complete(args.url);
        assert.equal(file.type, 'image/png');
        const w = file.body.readUInt32BE(16), h = file.body.readUInt32BE(20);
        assert.ok(w <= 1024 && h <= 1024);
        assert.ok(args.x >= 0 && args.x < w && args.y >= 0 && args.y < h);
        if (state.subject === 'none') return { found: false };
        if (state.subject === 'failed') return failure('unsupported');
        const x = args.x, y = args.y, r = 24;
        const polygons = [state.subjectShape === 'large' ? [1, 1, w - 1, 1, w - 1, h - 1, 1, h - 1]
          : [Math.max(0, x - r), Math.max(0, y - r), Math.min(w, x + r), Math.max(0, y - r), Math.min(w, x + r), Math.min(h, y + r), Math.max(0, x - r), Math.min(h, y + r)]];
        const result = { found: true, w, h, polygons };
        if (state.subject === 'defer') return new Promise((resolve) => state.pending.push({ op, resolve: () => resolve(result), url: args.url }));
        return result;
      }
      case 'haptic': assert.ok(['prepare', 'tick', 'light', 'medium', 'success', 'warning', 'error'].includes(args.kind)); return {};
      case 'settings.open': return {};
      case 'clipboard.write': return {};
      default: return failure('unsupported', `Unexpected operation: ${op}`);
    }
  };
  return state;
}

async function wire(context, state) {
  await context.exposeBinding('__gessoHarnessOp', async (_source, message) => {
    state.calls.push(message);
    try {
      assert.deepEqual(Object.keys(message).sort(), ['args', 'op'], 'one {op,args} bridge envelope');
      assert.ok(message.args && typeof message.args === 'object' && !Array.isArray(message.args));
      return { ok: true, result: await state.dispatch(message) };
    } catch (err) {
      if (!err.code) state.problems.push(err.stack);
      return { ok: false, error: { code: err.code ?? 'failed', message: err.message } };
    }
  });
  await context.route('**/__gesso_native_xfer__/*', async (route) => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split('/').at(-1);
    const url = `gesso://localhost/xfer/${name}`;
    const entry = state.entries.get(url);
    if (!entry) return route.fulfill({ status: 404, body: 'Unknown transfer' });
    if (request.method() === 'POST') {
      const bytes = request.postDataBuffer();
      if (entry.body) return route.fulfill({ status: 409, body: 'Already uploaded' });
      if (!bytes || bytes.length !== entry.size) return route.fulfill({ status: 400, body: 'Wrong length' });
      entry.body = bytes;
      state.posts.push({ url, bytes, type: request.headers()['content-type'] });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ size: bytes.length }) });
    }
    if (request.method() !== 'GET') return route.fulfill({ status: 405, body: 'Wrong method' });
    if (!entry.body) return route.fulfill({ status: 404, body: 'Incomplete transfer' });
    state.gets.push({ url, raw: entry.raw, size: entry.body.length });
    return route.fulfill({ status: 200, contentType: entry.type, headers: { 'Cache-Control': 'no-store' }, body: entry.body });
  });
  await context.addInitScript(installStub, { origin: base.origin });
}

async function ready(page) {
  await page.goto(opts.base, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.gesso?.editor, null, { timeout: 30000 });
}
async function pick(page, state, mode = 'jpeg') {
  state.pick = mode;
  await page.locator('#choose').click();
  await page.waitForFunction(() => !!window.gesso?.editor.committed && document.querySelector('#busy').hidden);
}
async function edit(page) {
  await page.locator('#dock [data-tool="light"]').click();
  await page.locator('[data-quick="brighter"]').click();
  assert.equal(await page.evaluate(() => window.gesso.editor.isSaved), false);
}
async function openSave(page) {
  await page.locator('#save').click();
  await page.locator('#share[data-ready]').waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.locator('#sheet-coach').isVisible(), false);
  assert.equal(await page.locator('#sheet-share').isVisible(), true);
}
async function closeSave(page) {
  await page.keyboard.press('Escape');
  await page.locator('#sheet').waitFor({ state: 'hidden' });
}
async function sourceTap(page) {
  const point = await page.evaluate(({ x, y }) => {
    const p = window.gesso.editor.docToStage(x, y);
    const r = document.querySelector('#stage').getBoundingClientRect();
    return { x: r.x + p[0], y: r.y + p[1] };
  }, fixtureSpec.speck);
  await page.touchscreen.tap(point.x, point.y);
}
async function signature(page) {
  return page.evaluate(() => {
    const image = window.gesso.editor.readOutput({ maxSide: 256, tone: true });
    let hash = 2166136261;
    for (const byte of image.data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
  });
}

const scenarios = [
  ['startup and picker cancellation/errors', async ({ page, state, chooserCount, capture }) => {
    assert.equal(await page.locator('#install').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.__gessoNativeTest), { serviceWorkers: 0, webShares: 0 });
    await capture('start');
    state.pick = 'cancel';
    await page.locator('#choose').press('Enter');
    await until(() => state.calls.filter((c) => c.op === 'photo.pick').length === 1, 'keyboard opens native picker');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(() => window.gesso.editor.committed), null);
    state.pick = 'failed';
    await page.locator('#choose').click();
    await page.waitForFunction(() => document.querySelector('#hint').textContent.includes('choose it again'));
    assert.equal(await page.evaluate(() => window.gesso.editor.committed), null);
    await pick(page, state);
    assert.equal(chooserCount(), 0, 'native mode suppresses the HTML file chooser');
    assert.equal(state.calls.filter((c) => c.op === 'photo.pick').length, 3);
    assert.equal(await page.evaluate(() => window.gesso.editor.sourceInfo.type), 'jpeg');
  }],
  ['RAW becomes the persisted PNG source and restores without native decode', async ({ page, state }) => {
    await pick(page, state, 'raw');
    const before = await page.evaluate(async () => {
      await window.gesso.flush();
      const ed = window.gesso.editor;
      const { openStore } = await import('./ui/store.js');
      const store = await openStore();
      const blob = await store.getBlob(`source:${ed.doc.id}`);
      return { id: ed.doc.id, source: ed.doc.source, info: ed.sourceInfo, type: blob.type, head: [...new Uint8Array(await blob.slice(0, 8).arrayBuffer())] };
    });
    assert.equal(before.info.type, 'png');
    assert.equal(before.type, 'image/png');
    assert.deepEqual(before.head, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(state.gets.some((g) => g.raw), false, 'DNG bytes never enter WebContent');
    const decodes = state.calls.filter((c) => c.op === 'image.decode').length;
    assert.equal(decodes, 1);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction((id) => window.gesso?.editor.committed?.id === id, before.id);
    assert.deepEqual(await page.evaluate(() => window.gesso.editor.doc.source), before.source);
    assert.equal(state.calls.filter((c) => c.op === 'image.decode').length, decodes, 'restore decodes the stored PNG through WebKit');
  }],
  ['Photos denial, Settings, share cancellation and truthful success', async ({ page, state, capture }) => {
    await pick(page, state); await edit(page); await openSave(page);
    await capture('save-main');
    state.save = 'denied';
    await page.locator('#share').click();
    await page.locator('#sheet-settings').waitFor({ state: 'visible' });
    assert.match(await page.locator('#sheet-error').innerText(), /Settings/);
    assert.equal(await page.locator('#fallback').isVisible(), false);
    assert.equal(await page.evaluate(() => window.gesso.editor.isSaved), false);
    await capture('save-denied');
    await page.locator('#sheet-settings').click();
    await until(() => state.calls.some((c) => c.op === 'settings.open'), 'Open Settings reaches native code');
    await page.waitForFunction(() => !document.querySelector('#share').disabled);
    state.save = 'restricted'; await page.locator('#share').click();
    await page.waitForFunction(() => document.querySelector('#sheet-error').textContent.includes('restricted'));
    assert.equal(await page.locator('#sheet-settings').isVisible(), false);
    state.save = 'failed'; await page.locator('#share').click();
    await page.waitForFunction(() => document.querySelector('#sheet-error').textContent.includes('could not be saved'));
    assert.equal(await page.evaluate(() => window.gesso.editor.isSaved), false);
    state.save = 'cancel'; await page.locator('#share').click();
    await page.waitForFunction(() => !document.querySelector('#share').disabled);
    assert.equal(await page.locator('#sheet-done').isVisible(), false);
    assert.equal(await page.evaluate(() => window.gesso.editor.isSaved), false);
    state.share = 'cancel'; await page.locator('#sheet-share').click();
    await page.waitForFunction(() => !document.querySelector('#sheet-share').disabled);
    assert.equal(await page.locator('#sheet-done').isVisible(), false);
    state.share = 'failed'; await page.locator('#sheet-share').click();
    await page.waitForFunction(() => document.querySelector('#sheet-error').textContent.includes('could not be shared'));
    state.share = 'airdrop'; await page.locator('#sheet-share').click();
    await page.locator('#sheet-done').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.sheet__success').innerText(), 'Shared.');
    assert.equal(await page.evaluate(() => window.gesso.editor.isSaved), false, 'AirDrop does not retire the unsaved guard');
    await capture('save-shared');
    await closeSave(page); await openSave(page);
    state.share = 'photos'; await page.locator('#sheet-share').click();
    await page.waitForFunction(() => window.gesso.editor.isSaved);
    assert.equal(await page.locator('.sheet__success').innerText(), 'Saved to Photos.');
    await closeSave(page); await edit(page); await openSave(page);
    state.save = 'saved'; await page.locator('#share').click();
    await page.waitForFunction(() => window.gesso.editor.isSaved);
    assert.equal(await page.locator('.sheet__success').innerText(), 'Saved to Photos.');
    assert.equal(await page.evaluate(() => window.__gessoNativeTest.webShares), 0);
  }],
  ['late Photos replies cannot affect a reopened sheet or its busy guard', async ({ page, state }) => {
    await pick(page, state); await edit(page); await openSave(page);
    state.save = 'defer'; await page.locator('#share').click();
    await until(() => state.pending.length === 1, 'first Photos request is pending');
    const old = state.pending[0];
    await closeSave(page); await openSave(page);
    await page.locator('#share').click();
    await until(() => state.pending.length === 2, 'second Photos request is pending');
    old.resolve({ saved: true });
    await until(() => !state.entries.has(old.url), 'old request finishes and releases its transfer');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.locator('#share').isDisabled(), true, 'old completion cannot enable the new request');
    assert.equal(await page.locator('#sheet-done').isVisible(), false);
    assert.equal(await page.evaluate(() => window.gesso.editor.isSaved), false);
    state.pending[1].resolve({ saved: false, reason: 'denied' });
    await page.locator('#sheet-settings').waitFor({ state: 'visible' });
    state.save = 'saved'; await page.locator('#share').click();
    await page.waitForFunction(() => window.gesso.editor.isSaved);
  }],
  ['Outline subject taps use real Light/Remove pipelines and discard stale replies', async ({ page, state }) => {
    await pick(page, state);
    const pristine = await signature(page);
    await page.locator('#dock [data-tool="light"]').click();
    await page.locator('[data-dial="outline"]').click();
    await sourceTap(page);
    await page.waitForFunction(() => window.gesso.editor.committed.paint.length === 1);
    assert.equal(await page.evaluate(() => {
      const ed = window.gesso.editor;
      return ed.pools.strokes[ed.committed.paint[0]].kind;
    }), 'outline');
    assert.notEqual(await signature(page), pristine, 'the subject mask changes rendered pixels');
    await page.locator('#undo').click();
    assert.equal(await signature(page), pristine, 'Undo restores the exact rendered photo');
    state.subject = 'none'; await sourceTap(page);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No subject'));
    assert.equal(await page.evaluate(() => window.gesso.editor.committed.paint.length), 0);
    state.subject = 'failed'; await sourceTap(page);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Loop around it instead'));
    state.subject = 'defer'; await sourceTap(page);
    await until(() => state.pending.some((p) => p.op === 'subject.mask'), 'subject request is pending');
    await page.locator('#cancel').click();
    const pending = state.pending.find((p) => p.op === 'subject.mask');
    pending.resolve();
    await until(() => !state.entries.has(pending.url), 'cancelled subject transfer is released');
    assert.equal(await page.evaluate(() => window.gesso.editor.committed.paint.length), 0);
    state.subject = 'found';
    await page.locator('#dock [data-tool="remove"]').click();
    await page.locator('[data-dial="outline"]').click();
    await sourceTap(page);
    await page.waitForFunction(() => window.gesso.editor.committed.remove.length === 1, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => {
      const ed = window.gesso.editor;
      return ed.pools.patches[ed.committed.remove[0]].how.kind;
    }), 'outline', 'native tap enters the outline fill, not spot heal');
    assert.notEqual(await signature(page), pristine);
    await page.locator('#undo').click();
    assert.equal(await signature(page), pristine);
    state.subjectShape = 'large'; await sourceTap(page);
    await page.waitForFunction(() => document.querySelector('#hint').textContent.includes('Big area'));
    assert.equal(await page.evaluate(() => window.gesso.editor.committed.remove.length), 0, 'the existing 20% cap still applies');
  }],
  ['5 MiB transfer crosses the ArrayBuffer POST route byte for byte', async ({ page, state }) => {
    const size = 5 * 1024 ** 2;
    await page.evaluate(async (size) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) % 251;
      const platform = await import('./ui/platform.js');
      const ref = await platform.putFile(new Blob([bytes], { type: 'image/jpeg' }), 'five-megabytes.jpg');
      try {
        const roundtrip = await platform.fetchFile(ref);
        const actual = new Uint8Array(await roundtrip.arrayBuffer());
        if (actual.length !== size) throw new Error('5 MiB download changed length');
        for (let i = 0; i < size; i++) if (actual[i] !== bytes[i]) throw new Error(`5 MiB roundtrip changed byte ${i}`);
      } finally { await platform.release(ref.url); }
    }, size);
    const post = state.posts.find((p) => p.bytes.length === size);
    assert.ok(post, 'the full file is uploaded through POST');
    for (let i = 0; i < size; i++) assert.equal(post.bytes[i], (i * 17) % 251);
    assert.equal(state.entries.size, 0, 'the roundtrip releases its issued file');
    assert.ok(state.calls.every((c) => JSON.stringify(c).length < 1024), 'photo bytes never enter script messages');
  }],
];

await mkdir(opts.out, { recursive: true });
const playwright = await loadPlaywright();
const results = [];
for (const engine of opts.browser === 'all' ? ['chromium', 'webkit'] : [opts.browser]) {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] } : {});
  try {
    const fixturePage = await browser.newPage();
    const fixture = await writeFixture(fixturePage, join(opts.out, engine), fixtureSpec);
    const jpeg = await readFile(fixture.path);
    const pngUrl = await fixturePage.evaluate(async (url) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png');
    }, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
    const assets = { jpeg, png: Buffer.from(pngUrl.split(',')[1], 'base64') };
    await fixturePage.close();
    for (const [index, [name, run]] of scenarios.entries()) {
      if (opts.only && !opts.only.has(index + 1)) continue;
      const context = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const state = newState(assets), errors = [], logs = [];
      let page, choosers = 0;
      const started = Date.now();
      try {
        await wire(context, state);
        page = await context.newPage();
        page.on('pageerror', (err) => errors.push(err.stack ?? err.message));
        page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
        page.on('filechooser', () => { choosers++; });
        page.setDefaultTimeout(30000);
        await ready(page);
        await run({ page, state, chooserCount: () => choosers,
          capture: async (name) => {
            await page.evaluate(() => Promise.allSettled(document.getAnimations()
              .filter((a) => a.effect?.target?.matches?.('.sheet__card, .sheet__scrim')).map((a) => a.finished)));
            await page.screenshot({ path: join(opts.out, `${engine}-${name}.png`), fullPage: true });
          },
        });
        assert.deepEqual(state.problems, [], 'the stub observed valid bridge contracts');
        assert.deepEqual(errors, [], 'no uncaught page errors');
        assert.equal(choosers, 0, 'the native picker never opens the HTML chooser');
        assert.deepEqual(await page.evaluate(() => window.__gessoNativeTest), { serviceWorkers: 0, webShares: 0 });
        await until(() => state.entries.size === 0, 'all completed transfer files are released');
        results.push({ engine, name, status: 'PASS', ms: Date.now() - started });
        console.log(`PASS ${engine}: ${name}`);
      } catch (err) {
        const stem = `${engine}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const shot = join(opts.out, `${stem}.png`);
        await page?.screenshot({ path: shot, fullPage: true }).catch(() => {});
        results.push({ engine, name, status: 'FAIL', ms: Date.now() - started, error: err.stack ?? String(err), errors, problems: state.problems, screenshot: shot });
        console.error(`FAIL ${engine}: ${name}\n${err.stack ?? err}`);
      } finally {
        await writeFile(join(opts.out, `${engine}-${results.length}.log`), logs.join('\n') + '\n');
        for (const pending of state.pending) pending.resolve({ saved: false, reason: 'failed' });
        await context.close();
      }
    }
  } finally { await browser.close(); }
}
await writeFile(join(opts.out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
const failures = results.filter((r) => r.status === 'FAIL');
console.log(`${results.length - failures.length}/${results.length} native checks passed; results: ${join(opts.out, 'results.json')}`);
process.exitCode = failures.length ? 1 : 0;
