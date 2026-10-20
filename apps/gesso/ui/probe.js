// Device diagnostics for ?probe=1 (SPEC F18 and the risk table): checks, on the real
// phone, the platform facts the design leans on and lists each as PASS, FAIL or INFO
// with its value. Not linked from the app. "Copy report" puts the plain text on the
// clipboard to paste into an issue. Checks run one at a time, cheap ones first; the
// big canvas runs last so a crash there keeps the rest on screen.

import { MAX_SIDE, WORK_MAX_PIXELS } from '../lib/image-io.js';

// 64x64 HEIC (libheif + x265, Main Still Picture, 404 bytes): left half red
// (231, 40, 30), right half blue (30, 60, 220).
const HEIC_SAMPLE = 'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAUJtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABZgABAAAAAAAAAC4AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAAwmlwcnAAAACkaXBjbwAAAHhodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQArQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqSSmubgIaDAgAAAMAyAAAAwAIQGIAAQAHRAHBcrAiQAAAABRpc3BlAAAAAAAAAEAAAABAAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAA2bWRhdAAAACooAa8GOFr8/Tf1d7///wEx6H+rUKbFL+0urpf72IX//w7vPHxhpX/f2fg=';

const RED = [231, 40, 30];
const BLUE = [30, 60, 220];
const BIG = { width: 8064, height: 6048 }; // a 48 MP iPhone frame
const CHECK_TIMEOUT_MS = 10000;

const pass = (value) => ({ status: 'PASS', value });
const fail = (value) => ({ status: 'FAIL', value });
const info = (value) => ({ status: 'INFO', value });
const yes = (b) => (b ? 'yes' : 'no');

const CHECKS = [
  ['WebGL2', webgl2],
  ['MAX_TEXTURE_SIZE', maxTexture],
  ['RGBA16F framebuffer', () => framebuffer('RGBA16F')],
  ['RG8 framebuffer', () => framebuffer('RG8')],
  ['createImageBitmap resize', bitmapResize],
  ['EXIF orientation 6', exifOrientation],
  ['HEIC decode', heicDecode],
  ['Share files', shareFiles],
  ['Storage persist()', storagePersist],
  ['Storage estimate()', storageEstimate],
  ['IndexedDB', indexedDb],
  ['Module worker + OffscreenCanvas JPEG', workerJpeg],
  ['ui-serif / ui-rounded / ui-monospace', systemFonts],
  ['Coalesced pointer events', coalesced],
  ['Display mode', displayMode],
  ['devicePixelRatio', () => info(String(window.devicePixelRatio))],
  ['Screen', screenSize],
  ['Safe area insets', safeArea],
  ['Working size cap', workingCap],
  [`${BIG.width}x${BIG.height} canvas`, bigCanvas],
];

export async function runProbe(root = document.body) {
  const doc = root.ownerDocument ?? document;
  doc.title = 'Gesso probe';
  addStyle(doc);
  root.replaceChildren();

  const started = new Date();
  const page = el(doc, 'main', 'probe');
  const head = el(doc, 'header', 'probe__head');
  head.append(el(doc, 'h1', 'probe__title', 'Gesso device probe'));
  const meta = el(doc, 'p', 'probe__meta', `${started.toISOString()} · ${navigator.userAgent}`);
  head.append(meta);
  const bar = el(doc, 'div', 'probe__bar');
  const copy = el(doc, 'button', 'probe__copy', 'Copy report');
  copy.type = 'button';
  const note = el(doc, 'span', 'probe__note', 'Running…');
  note.setAttribute('role', 'status');
  bar.append(copy, note);
  head.append(bar);
  const list = el(doc, 'ol', 'probe__rows');
  const fallback = el(doc, 'textarea', 'probe__text');
  fallback.readOnly = true;
  fallback.hidden = true;
  fallback.setAttribute('aria-label', 'Report');
  page.append(head, list, fallback);
  root.append(page);

  const results = [];
  const report = () => [
    `Gesso probe · ${started.toISOString()}`,
    `UA: ${navigator.userAgent}`,
    `URL: ${location.origin}${location.pathname}`,
    '',
    ...results.map((r) => `${r.status.padEnd(4)}  ${r.name}: ${r.value}`),
  ].join('\n');

  copy.addEventListener('click', async () => {
    const text = report();
    let ok = false;
    try {
      // first await: still inside the tap, as iOS requires
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      fallback.hidden = false;
      fallback.value = text;
      fallback.select();
      try { ok = doc.execCommand('copy'); } catch { ok = false; }
    }
    note.textContent = ok ? 'Copied' : 'Select the text below and copy it';
  });

  let finish;
  const done = new Promise((r) => { finish = r; });
  window.gessoProbe = { results, done, report };

  for (const [name, fn] of CHECKS) {
    const row = el(doc, 'li', 'probe__row');
    const badge = el(doc, 'span', 'probe__status is-wait', '…');
    row.append(badge, el(doc, 'span', 'probe__name', name), el(doc, 'span', 'probe__value', ''));
    list.append(row);
    await nextFrame(); // paint the row before a check that may block
    let r;
    try {
      r = await withTimeout(Promise.resolve().then(fn), CHECK_TIMEOUT_MS);
    } catch (err) {
      r = fail(`error: ${err?.message ?? String(err)}`);
    }
    results.push({ name, status: r.status, value: String(r.value) });
    badge.textContent = r.status;
    badge.className = `probe__status is-${r.status.toLowerCase()}`;
    row.lastChild.textContent = String(r.value);
  }
  const fails = results.filter((r) => r.status === 'FAIL').length;
  note.textContent = fails ? `Done · ${fails} failed` : 'Done · all passed';
  finish(results);
  return results;
}

// ------------------------------------------------------------------ GPU

function gl2() {
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  return c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
}

function webgl2() {
  const gl = gl2();
  if (!gl) return fail('no WebGL2 context (Lockdown Mode, or turned off)');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const version = gl.getParameter(gl.VERSION);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return pass(`${name} · ${version}`);
}

function maxTexture() {
  const gl = gl2();
  if (!gl) return fail('no WebGL2');
  const n = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  const value = `${n} (needs ≥ ${MAX_SIDE}) · renderbuffer ${rb} · viewport ${vp[0]}x${vp[1]}`;
  return n >= MAX_SIDE ? pass(value) : fail(value);
}

function framebuffer(format) {
  const gl = gl2();
  if (!gl) return fail('no WebGL2');
  const exts = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'].filter((x) => gl.getExtension(x));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl[format], 16, 16);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  let cleared = false;
  if (status === gl.FRAMEBUFFER_COMPLETE) {
    // complete is a promise; a clear that reads back is the proof
    gl.viewport(0, 0, 16, 16);
    gl.clearColor(0.5, 0.25, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    cleared = gl.getError() === gl.NO_ERROR;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  const extText = format === 'RGBA16F' ? ` · ${exts.length ? exts.join(', ') : 'no float colour-buffer extension'}` : '';
  const ok = status === gl.FRAMEBUFFER_COMPLETE;
  return ok && cleared ? pass(`complete${extText}`) : fail(`${ok ? 'complete but clear failed' : `incomplete (0x${status.toString(16)})`}${extText}`);
}

// ------------------------------------------------------------------ decoding

// A w x h test picture, left half red and right half blue, as an encoded blob.
async function twoTone(w, h, type, quality = 0.95) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${RED})`;
  ctx.fillRect(0, 0, w / 2, h);
  ctx.fillStyle = `rgb(${BLUE})`;
  ctx.fillRect(w / 2, 0, w / 2, h);
  const blob = await new Promise((res) => c.toBlob(res, type, quality));
  if (!blob) throw new Error(`canvas could not encode ${type}`);
  return blob;
}

function pixelAt(source, x, y) {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
}

const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function bitmapResize() {
  if (typeof createImageBitmap !== 'function') return fail('createImageBitmap missing');
  const blob = await twoTone(64, 32, 'image/jpeg');
  const fromBlob = await createImageBitmap(blob, { resizeWidth: 32, resizeHeight: 16, resizeQuality: 'high' });
  const full = await createImageBitmap(blob);
  const fromBitmap = await createImageBitmap(full, { resizeWidth: 16, resizeHeight: 8, resizeQuality: 'high' });
  const okBlob = fromBlob.width === 32 && fromBlob.height === 16;
  const okBitmap = fromBitmap.width === 16 && fromBitmap.height === 8;
  const colours = near(pixelAt(fromBlob, 4, 8), RED) && near(pixelAt(fromBlob, 28, 8), BLUE);
  for (const b of [fromBlob, full, fromBitmap]) b.close();
  const value = `blob→${okBlob ? '32x16' : 'wrong size'} · bitmap→${okBitmap ? '16x8' : 'wrong size'} · colours ${colours ? 'ok' : 'off'}`;
  return okBlob && okBitmap && colours ? pass(value) : fail(value);
}

// A JPEG with an EXIF APP1 saying "rotate 90° clockwise" (orientation 6).
function withOrientation(jpeg, orientation) {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // big-endian header, IFD0 at 8
    0, 1, // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation, SHORT, 1
    0, 0, 0, 0]; // no next IFD
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0"
  const len = body.length + 2;
  const app1 = [0xff, 0xe1, len >> 8, len & 0xff, ...body];
  // after SOI and any JFIF APP0
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(app1, at);
  out.set(jpeg.subarray(at), at + app1.length);
  return out;
}

async function exifOrientation() {
  const plain = new Uint8Array(await (await twoTone(32, 16, 'image/jpeg')).arrayBuffer());
  const blob = new Blob([withOrientation(plain, 6)], { type: 'image/jpeg' });
  const turned = await createImageBitmap(blob);
  const dims = `${turned.width}x${turned.height}`;
  // Rotated 90° clockwise, the red left half becomes the top.
  const rotated = turned.width === 16 && turned.height === 32
    && near(pixelAt(turned, 8, 4), RED) && near(pixelAt(turned, 8, 28), BLUE);
  turned.close();
  let order = 'resize: unknown';
  try {
    const small = await createImageBitmap(blob, { resizeWidth: 8, resizeHeight: 16, resizeQuality: 'high' });
    if (small.width === 8 && small.height === 16 && near(pixelAt(small, 4, 2), RED)) order = 'resize applies after rotation';
    else order = `resize applies before rotation (got ${small.width}x${small.height}; the importer re-asks)`;
    small.close();
  } catch (err) {
    order = `resize failed: ${err?.message ?? err}`;
  }
  const value = `${rotated ? 'applied' : `not applied (got ${dims})`} · ${order}`;
  return rotated ? pass(value) : fail(value);
}

function base64Bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function heicDecode() {
  const blob = new Blob([base64Bytes(HEIC_SAMPLE)], { type: 'image/heic' });
  let viaImg = 'no';
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    viaImg = img.naturalWidth === 64 ? 'yes' : `odd size ${img.naturalWidth}x${img.naturalHeight}`;
  } catch {
    viaImg = 'no';
  } finally {
    URL.revokeObjectURL(url);
  }
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (err) {
    return fail(`createImageBitmap: no (${err?.name ?? 'error'}) · <img>: ${viaImg}`);
  }
  const ok = bmp.width === 64 && bmp.height === 64 && near(pixelAt(bmp, 12, 32), RED) && near(pixelAt(bmp, 52, 32), BLUE);
  const value = `createImageBitmap: ${ok ? 'yes, colours ok' : `decoded ${bmp.width}x${bmp.height} but wrong`} · <img>: ${viaImg}`;
  bmp.close();
  return ok ? pass(value) : fail(value);
}

// ------------------------------------------------------------------ platform

async function shareFiles() {
  const hasShare = typeof navigator.share === 'function';
  const jpeg = await twoTone(16, 16, 'image/jpeg');
  const file = new File([jpeg], 'gesso-probe.jpg', { type: 'image/jpeg' });
  let can = false;
  try { can = !!navigator.canShare?.({ files: [file] }); } catch { can = false; }
  const value = `share: ${yes(hasShare)} · canShare({files: [jpeg]}): ${yes(can)}`;
  return hasShare && can ? pass(value) : fail(`${value} (Save falls back to touch-and-hold)`);
}

async function storagePersist() {
  const s = navigator.storage;
  if (!s?.persist) return info('persist() missing');
  const before = await s.persisted?.();
  const now = before || await s.persist();
  const value = now ? `granted${before ? ' (already)' : ''}` : 'not granted (Safari may clear drafts after 7 days unused)';
  return now ? pass(value) : info(value);
}

async function storageEstimate() {
  const est = await navigator.storage?.estimate?.();
  if (!est) return info('estimate() missing');
  const mb = (n) => (Number.isFinite(n) ? `${(n / 1048576).toFixed(1)} MB` : '?');
  return info(`${mb(est.usage)} used of ${mb(est.quota)}`);
}

function indexedDb() {
  if (!globalThis.indexedDB) return fail('missing');
  return new Promise((resolve) => {
    const name = 'gesso-probe';
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('t');
    req.onerror = () => resolve(fail(`open failed: ${req.error?.name ?? 'error'}`));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('t', 'readwrite');
      tx.objectStore('t').put(new Blob([new Uint8Array(1024)]), 'k');
      tx.oncomplete = () => {
        db.close();
        indexedDB.deleteDatabase(name);
        resolve(pass('opened, stored a Blob'));
      };
      tx.onerror = () => {
        db.close();
        resolve(fail(`write failed: ${tx.error?.name ?? 'error'}`));
      };
    };
  });
}

function workerJpeg() {
  if (typeof Worker !== 'function') return fail('no Worker');
  const code = `
    self.onmessage = async () => {
      try {
        if (typeof OffscreenCanvas !== 'function') throw new Error('no OffscreenCanvas in workers');
        const c = new OffscreenCanvas(64, 48);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#e0281e';
        ctx.fillRect(0, 0, 64, 48);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        self.postMessage({ ok: blob.type === 'image/jpeg', size: blob.size, type: blob.type });
      } catch (err) {
        self.postMessage({ ok: false, error: String(err && err.message || err) });
      }
    };`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return new Promise((resolve) => {
    let w;
    const done = (r) => {
      w?.terminate();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    try {
      w = new Worker(url, { type: 'module' });
    } catch (err) {
      done(fail(`module worker refused: ${err?.message ?? err}`));
      return;
    }
    w.onmessage = (e) => done(e.data.ok ? pass(`JPEG ${e.data.size} bytes`) : fail(e.data.error ?? `got ${e.data.type}`));
    w.onerror = (e) => done(fail(`worker error: ${e.message ?? 'unknown'}`));
    w.postMessage('go');
  });
}

// A generic family the canvas doesn't know falls back to the default font. Each of
// the three must measure differently from that fallback and from the others.
function systemFonts() {
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'Hamburgefonstiv 0123456789 WMwmil';
  const width = (family) => {
    ctx.font = `40px ${family}`;
    return ctx.measureText(sample).width;
  };
  const fallback = width('"gesso-no-such-font"');
  const fams = ['ui-serif', 'ui-rounded', 'ui-monospace'].map((f) => ({ f, w: width(f) }));
  const resolved = fams.filter(({ w }) => Math.abs(w - fallback) > 0.5);
  const distinct = new Set(fams.map(({ w }) => w.toFixed(1))).size === fams.length;
  const value = `${fams.map(({ f, w }) => `${f} ${w.toFixed(1)}`).join(' · ')} · fallback ${fallback.toFixed(1)}`;
  if (resolved.length === fams.length && distinct) return pass(value);
  const missing = fams.filter((x) => !resolved.includes(x)).map(({ f }) => f);
  return fail(`${missing.length ? `unresolved: ${missing.join(', ')}` : 'not distinct'} · ${value}`);
}

function coalesced() {
  const ok = typeof PointerEvent === 'function' && 'getCoalescedEvents' in PointerEvent.prototype;
  return ok ? pass('getCoalescedEvents: yes') : info('getCoalescedEvents: no (brush strokes use plain moves)');
}

function displayMode() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return info(standalone ? 'standalone (Home Screen app)' : 'browser tab');
}

function screenSize() {
  const vv = window.visualViewport;
  return info(`screen ${screen.width}x${screen.height} · window ${innerWidth}x${innerHeight}${vv ? ` · visual ${Math.round(vv.width)}x${Math.round(vv.height)}` : ''}`);
}

function safeArea() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(p);
  const cs = getComputedStyle(p);
  const v = ['Top', 'Right', 'Bottom', 'Left'].map((s) => `${s[0].toLowerCase()} ${parseFloat(cs[`padding${s}`]) || 0}`).join(' · ');
  p.remove();
  return info(v);
}

function workingCap() {
  let stored = null;
  try { stored = Number(localStorage.getItem('gesso:workCap')) || null; } catch { stored = null; }
  const mp = (n) => `${(n / 1e6).toFixed(1)} MP`;
  return info(stored ? `${mp(stored)} (stepped down after a failure)` : `${mp(WORK_MAX_PIXELS)} (default)`);
}

function bigCanvas() {
  const c = document.createElement('canvas');
  c.width = BIG.width;
  c.height = BIG.height;
  try {
    const ctx = c.getContext('2d');
    if (!ctx) return fail('no 2D context at that size');
    ctx.fillStyle = 'rgb(10, 200, 30)';
    ctx.fillRect(BIG.width - 64, BIG.height - 48, 64, 48);
    ctx.fillStyle = 'rgb(200, 30, 10)';
    ctx.fillRect(0, 0, 8, 8);
    const far = [...ctx.getImageData(BIG.width - 1, BIG.height - 1, 1, 1).data];
    const nearCorner = [...ctx.getImageData(0, 0, 1, 1).data];
    const ok = near(far, [10, 200, 30, 255], 2) && near(nearCorner, [200, 30, 10, 255], 2);
    const mp = ((BIG.width * BIG.height) / 1e6).toFixed(1);
    return ok ? pass(`allocated and read back (${mp} MP)`) : fail(`read back blank (${mp} MP): over this device's canvas limit`);
  } finally {
    // Give the memory back now; iOS counts canvas memory against the page.
    c.width = 1;
    c.height = 1;
  }
}

// ------------------------------------------------------------------ page

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function addStyle(doc) {
  const s = doc.createElement('style');
  s.textContent = `
    html, body { height: auto; overflow: auto; user-select: text; -webkit-user-select: text; -webkit-touch-callout: default; }
    body { padding: calc(env(safe-area-inset-top) + 16px) max(16px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 24px) max(16px, env(safe-area-inset-left)); }
    .probe { max-width: 720px; margin: 0 auto; }
    .probe__head { position: sticky; top: 0; z-index: 1; padding: 8px 0 12px; background: var(--ground); border-bottom: 1px solid var(--line); }
    .probe__title { margin: 0 0 4px; font-size: 20px; font-weight: 700; }
    .probe__meta { margin: 0 0 10px; color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
    .probe__bar { display: flex; align-items: center; gap: 12px; }
    .probe__copy { min-height: 44px; padding: 0 18px; border-radius: 12px; background: var(--accent); color: var(--on-accent); font-size: 16px; font-weight: 700; }
    .probe__note { color: var(--ink-2); font-size: 14px; }
    .probe__rows { margin: 0; padding: 0; list-style: none; }
    .probe__row { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 2px 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .probe__status { grid-row: span 2; align-self: start; padding: 3px 0; border-radius: 6px; font: 700 12px/1.4 ui-monospace, Menlo, monospace; text-align: center; }
    .probe__name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
    .probe__value { color: var(--ink-2); font-size: 13px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .is-pass { background: #1d3a24; color: #8fe39b; }
    .is-fail { background: #4a1f1c; color: #ff9d92; }
    .is-info { background: var(--raised-2); color: var(--ink-2); }
    .is-wait { background: var(--raised); color: var(--ink-3); }
    .probe__text { width: 100%; min-height: 220px; margin-top: 16px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--raised); color: var(--ink); font: 16px/1.4 ui-monospace, Menlo, monospace; }
  `;
  doc.head.append(s);
}
