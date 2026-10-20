#!/usr/bin/env node
// Gesso acceptance checks (SPEC §1b "Automated acceptance checks", 1–17) in a real
// browser: Chromium through Playwright, touch emulation at DPR 3, iPhone safe
// areas, and the generated fixture photo (e2e/fixture.mjs). Dev-only; nothing in
// the app imports this.
//
//   node e2e/acceptance.mjs [--base http://127.0.0.1:4174/gesso/] [--only 1,2,8] [--out DIR]
//
// Prints one row per check (PASS / FAIL / SKIP with a one-line reason), then the
// details of every failure; writes failure screenshots, console logs and
// results.json to --out; exits 1 when any check fails. e2e/README.md explains how
// each check reads the spec where the spec leaves room.

import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { FIXTURE, writeFixture } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const DEFAULT_OUT = process.env.GESSO_E2E_OUT
  || '/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad/wave2/harness/out';

const CHECKS = {
  1: 'Map visible',
  2: 'Nothing hidden',
  3: 'Fixed places',
  4: 'No unlabelled controls',
  5: 'Glanceable count',
  6: 'Static paint',
  7: 'One-tap defaults',
  8: 'One-minute flow',
  9: 'Save fallback',
  10: 'Undo integrity',
  11: 'Before',
  12: 'Gesture coverage',
  13: 'No zoom-on-focus',
  14: 'Offline',
  15: 'No network',
  16: 'Cancel',
  17: 'Resume',
};

const VIEWPORTS = [[402, 874], [430, 932], [440, 956], [874, 402], [956, 440]]
  .map(([width, height]) => ({ width, height, label: `${width}x${height}` }));
const PRIMARY = VIEWPORTS[2]; // iPhone 17 Pro Max, portrait
// SPEC §3: about 62 pt of safe area on top and 34 for the home indicator in
// portrait; in landscape the sensor housing and the indicator move to the sides.
const insetsFor = (vp) => (vp.width > vp.height
  ? { top: 0, right: 62, bottom: 21, left: 62 }
  : { top: 62, right: 0, bottom: 34, left: 0 });
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const DOCK = ['Crop', 'Light', 'Color', 'Remove', 'Text'];
const ACTIONS = ['Undo', 'Redo', 'Before', 'Save'];
const TOOLS = ['crop', 'light', 'color', 'remove', 'text'];
const SCENARIO_MS = 240_000;

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const o = { base: 'http://127.0.0.1:4174/gesso/', only: null, out: DEFAULT_OUT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`${key} needs a value`);
      return v;
    };
    if (key === '--base') o.base = val();
    else if (key === '--only') o.only = new Set(val().split(',').map((s) => Number(s.trim())).filter((n) => CHECKS[n]));
    else if (key === '--out') o.out = resolve(val());
    else if (key === '--help' || key === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.base.endsWith('/')) o.base += '/';
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('node e2e/acceptance.mjs [--base URL] [--only 1,2,8] [--out DIR]\n');
  for (const [n, name] of Object.entries(CHECKS)) console.log(`${String(n).padStart(3)}  ${name}`);
  process.exit(0);
}
const wanted = (n) => !opts.only || opts.only.has(n);
const BASE = new URL(opts.base);

// ------------------------------------------------------------------ small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const quote = (s) => JSON.stringify(String(s));
const list = (xs, n = 4) => (xs.length <= n ? xs.join('; ') : `${xs.slice(0, n).join('; ')}; and ${xs.length - n} more`);

// Top-level DocState keys whose content differs (both are stable JSON strings).
function diffKeys(a, b) {
  try {
    const A = JSON.parse(a), B = JSON.parse(b);
    return [...new Set([...Object.keys(A ?? {}), ...Object.keys(B ?? {})])].filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
  } catch {
    return ['(unreadable)'];
  }
}

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright'];
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (root) tries.push(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
  } catch { /* no npm: fall through */ }
  tries.push('/opt/node22/lib/node_modules/playwright/index.mjs');
  for (const t of tries.filter(Boolean)) {
    try {
      const m = await import(t);
      if (m.chromium) return m;
    } catch { /* next */ }
  }
  throw new Error('Playwright not found: npm i -g playwright, or set PLAYWRIGHT_MODULE to its index.mjs');
}

// ------------------------------------------------------------------ results

const results = new Map(); // check number -> [{ status, where, reasons, notes, shots }]

function record(no, entry) {
  if (!results.has(no)) results.set(no, []);
  results.get(no).push(entry);
}

// One run of one check in one place (a viewport, a part). Failures accumulate so
// a run reports everything it saw, and the first few take a screenshot at once.
class Trial {
  constructor(s, no, where) {
    this.s = s;
    this.no = no;
    this.where = where;
    this.reasons = [];
    this.notes = [];
    this.shots = [];
    this.skipped = null;
    this.errMark = s ? s.errors.length : 0;
    this.done = false;
  }

  async fail(msg) {
    this.reasons.push(msg);
    if (this.s?.page && this.shots.length < 3) {
      const path = join(opts.out, `check${pad2(this.no)}-${slug(this.where)}-${this.shots.length + 1}.png`);
      try {
        await this.s.page.screenshot({ path, timeout: 10_000 });
        this.shots.push(path);
      } catch { /* the page may be gone */ }
    }
    return false;
  }

  async expect(cond, msg) {
    if (!cond) await this.fail(msg);
    return !!cond;
  }

  note(msg) { this.notes.push(msg); }

  skip(msg) { this.skipped = msg; }

  async end() {
    if (this.done) return;
    this.done = true;
    const errs = this.s ? this.s.errors.slice(this.errMark) : [];
    if (errs.length) await this.fail(`page error${errs.length > 1 ? 's' : ''}: ${list(errs.map((e) => e.message), 2)}`);
    const status = this.reasons.length ? 'FAIL' : this.skipped ? 'SKIP' : 'PASS';
    record(this.no, { status, where: this.where, reasons: this.reasons, notes: this.skipped ? [this.skipped, ...this.notes] : this.notes, shots: this.shots });
  }
}

function begin(s, no, where) {
  if (!wanted(no)) return null;
  const t = new Trial(s, no, where);
  s?.trials.push(t);
  return t;
}

async function check(s, no, where, fn) {
  const t = begin(s, no, where);
  if (!t) return;
  try {
    await fn(t);
  } catch (err) {
    await t.fail(firstLine(err));
  }
  await t.end();
}

// ------------------------------------------------------------------ in-page helpers

// Installed in every page before the app's own scripts. Self-contained: it is
// serialized into the page.
function pageHelpers() {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const acc = {
    norm, q, qa,
    rect(el) {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    },
    opacity(el) {
      let o = 1;
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    },
    rendered(el) {
      if (!el || !el.isConnected || !el.getClientRects().length) return false;
      if (getComputedStyle(el).visibility !== 'visible') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    visible: (el) => acc.rendered(el) && acc.opacity(el) > 0.05,
    text: (el) => norm(el?.innerText),
    describe(el) {
      if (!el) return '(none)';
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      for (const k of ['tool', 'quick', 'dial', 'segment', 'swatch']) if (el.dataset?.[k] !== undefined) s += `[data-${k}="${el.dataset[k]}"]`;
      if (!el.id && el.classList?.length && !/\[data-/.test(s)) s += `.${[...el.classList].join('.')}`;
      const t = norm(el.innerText ?? el.textContent).slice(0, 24);
      return t ? `${s} "${t}"` : s;
    },
    // Visible text pieces inside el with the computed font size of each.
    textSizes(el) {
      const out = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = norm(n.nodeValue);
        const p = n.parentElement;
        if (!t || !p || !acc.visible(p)) continue;
        out.push({ text: t, size: parseFloat(getComputedStyle(p).fontSize) });
      }
      return out;
    },
    stable: (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
      : x)),
    snap() {
      const ed = window.gesso?.editor;
      const h = ed?.history;
      if (!ed || !h || !ed.committed) return null;
      return {
        state: acc.stable(ed.committed),
        shown: acc.stable(ed.doc),
        labels: h.entries.map((e) => e.label),
        index: h.index,
        len: h.entries.length,
        tool: ed.toolId,
      };
    },
    async waitHistory(prevIndex, prevLen, ms) {
      const t0 = performance.now();
      for (;;) {
        const h = window.gesso?.editor?.history;
        if (h && (h.index !== prevIndex || h.entries.length !== prevLen)) {
          return { label: h.entries[h.index]?.label ?? null, at: performance.now(), index: h.index, len: h.entries.length };
        }
        if (performance.now() - t0 > ms) return null;
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    frames(n = 2) {
      return new Promise((res) => {
        const step = (k) => (k <= 0 ? res() : requestAnimationFrame(() => step(k - 1)));
        step(n);
      });
    },
    compare: () => q('#stage')?.dataset.compare ?? null,
    insets() {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.append(d);
      const cs = getComputedStyle(d);
      const r = { top: parseFloat(cs.paddingTop), right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) };
      d.remove();
      return r;
    },
    // The accessible name, approximately as browsers compute it: labelledby,
    // aria-label, alt / labels, then content for roles named from content, then title.
    accName(el) {
      const by = el.getAttribute('aria-labelledby');
      if (by) return norm(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
      const al = el.getAttribute('aria-label');
      if (al && al.trim()) return norm(al);
      const tag = el.tagName.toLowerCase();
      if (tag === 'img') return norm(el.getAttribute('alt') || el.getAttribute('title'));
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const lab = el.labels?.[0];
        return norm(lab ? lab.textContent : el.getAttribute('placeholder') || el.getAttribute('title'));
      }
      const role = el.getAttribute('role');
      const tagFromContent = ['button', 'label', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'option', 'legend'].includes(tag) || (tag === 'a' && el.hasAttribute('href'));
      const roleFromContent = ['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'checkbox', 'switch', 'treeitem', 'heading', 'cell', 'tooltip'].includes(role);
      if (tagFromContent || roleFromContent) return norm(el.textContent);
      return norm(el.getAttribute('title'));
    },
    // Everything checks 2, 3, 4 and 13 need from one state of the UI.
    measure(selectors = []) {
      const out = { tool: q('#app')?.dataset.tool ?? null, rects: {}, overflow: [], truncated: [], badNames: [], haspopup: [], unlabelled: [], sliders: [], inputs: [], exists: {} };
      const keyed = [['undo', '#undo'], ['redo', '#redo'], ['before', '#before'], ['save', '#save'], ['panel', '#panel'], ['stage', '#stage']];
      for (const b of qa('#dock [data-tool]')) keyed.push([`dock:${b.dataset.tool}`, `#dock [data-tool="${b.dataset.tool}"]`]);
      for (const [k, sel] of keyed) { const el = q(sel); if (el) out.rects[k] = acc.rect(el); }
      out.panelH = q('#panel') ? acc.rect(q('#panel')).height : null;
      const rows = [['#panel', q('#panel')], ['#dock', q('#dock')], ['#actions', q('#actions')], ['#quick', q('#quick')], ['#dials', q('#dials')]];
      for (const el of qa('#slot .segment, #slot .swatches')) rows.push([acc.describe(el), el]);
      for (const [name, el] of rows) {
        if (!el || !acc.rendered(el)) continue;
        const r = { name, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight };
        if (r.sw > r.cw + 1 || r.sh > r.ch + 1) out.overflow.push(r);
      }
      for (const el of qa('#quick button, #dials button')) {
        if (!acc.rendered(el)) continue;
        const cut = [el, ...el.querySelectorAll('span')].some((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).textOverflow === 'ellipsis');
        if (cut) out.truncated.push(acc.describe(el));
      }
      const bad = /menu|more|options|settings|overflow/i;
      for (const el of qa('body *')) {
        const name = acc.accName(el);
        if (name && bad.test(name)) out.badNames.push(`${acc.describe(el)} named ${JSON.stringify(name)}`);
      }
      out.haspopup = qa('#app [aria-haspopup]').map(acc.describe);
      const scope = ['#topbar', '#actions', '#dock', '#panel'].map(q).filter(Boolean);
      const seen = new Set();
      for (const root of scope) {
        for (const el of root.querySelectorAll('button, [role=button], [role=radio], [role=slider]')) {
          if (seen.has(el) || !acc.rendered(el)) continue;
          seen.add(el);
          if (el.getAttribute('role') === 'slider') {
            out.sliders.push({ desc: acc.describe(el), valuetext: norm(el.getAttribute('aria-valuetext')), name: acc.accName(el) });
            continue;
          }
          if (!acc.text(el)) out.unlabelled.push(`${acc.describe(el)}${el.getAttribute('aria-label') ? ` (aria-label ${JSON.stringify(el.getAttribute('aria-label'))} only)` : ''}`);
        }
      }
      out.rulers = qa('.ruler').filter(acc.rendered).map((el) => ({ desc: acc.describe(el), role: el.getAttribute('role'), valuetext: norm(el.getAttribute('aria-valuetext')) }));
      out.inputs = qa('input, textarea').map((el) => ({ desc: acc.describe(el), tag: el.tagName.toLowerCase(), type: el.type, size: parseFloat(getComputedStyle(el).fontSize) }));
      for (const sel of selectors) { try { out.exists[sel] = !!q(sel); } catch { out.exists[sel] = false; } }
      return out;
    },
    // Check 5: enabled, visible interactive controls outside the photo.
    controls() {
      const sel = 'button, a[href], input, textarea, select, label[for], [role=button], [role=link], [role=radio], [role=slider], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [tabindex]:not([tabindex="-1"])';
      const stage = q('#stage');
      return [...new Set(qa(sel))].filter((el) => {
        if (stage?.contains(el) || !acc.visible(el)) return false;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-hidden="true"], [inert]')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      }).map(acc.describe);
    },
    controlInfo(el) {
      return { desc: acc.describe(el), text: acc.text(el), rect: acc.rect(el), sizes: acc.textSizes(el), visible: acc.visible(el) };
    },
    // Every element showing text matching re right now (opacity counted).
    visibleText(re) {
      const hits = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const p = n.parentElement;
        if (p && re.test(n.nodeValue) && acc.visible(p)) hits.push(acc.describe(p));
      }
      return hits;
    },
    // Check 12: which earned hints are on screen, sampled every 40 ms.
    hints: null,
    trackHints(table) {
      if (acc.hints) return;
      const st = { shows: [], visible: [], max: 0, maxAt: [] };
      acc.hints = st;
      const tick = () => {
        if (!document.body) return;
        const texts = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set();
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const p = n.parentElement;
          if (!p || seen.has(p) || !n.nodeValue.trim()) continue;
          seen.add(p);
          if (acc.visible(p)) texts.push(norm(p.textContent));
        }
        const now = table.filter((h) => texts.some((t) => t.includes(h.text))).map((h) => h.id);
        for (const id of now) if (!st.visible.includes(id)) st.shows.push({ id, t: Math.round(performance.now()) });
        st.visible = now;
        if (now.length > st.max) { st.max = now.length; st.maxAt = now; }
      };
      setInterval(tick, 40);
      tick();
    },
    lastStageUp: 0,
    lastBeforeUp: 0,
    samples: [],
    sampleCompare(ms) {
      acc.samples = [];
      const t0 = performance.now();
      return new Promise((res) => {
        const id = setInterval(() => {
          acc.samples.push({ t: performance.now(), v: acc.compare() });
          if (performance.now() - t0 >= ms) { clearInterval(id); res(acc.samples); }
        }, 25);
      });
    },
  };
  window.addEventListener('pointerup', (e) => {
    const el = e.target;
    if (el?.closest?.('#stage')) acc.lastStageUp = performance.now();
    if (el?.closest?.('#before')) acc.lastBeforeUp = performance.now();
  }, true);
  window.__acc = acc;
}

// Check 8: navigator.share records each call, the event being dispatched when it
// was called (window.event is only set while a listener runs synchronously), and
// the data; then resolves like a completed share.
function shareStub() {
  window.__shareCalls = [];
  const share = function share(data) {
    const ev = window.event;
    window.__shareCalls.push({ eventType: ev ? ev.type : null, trusted: ev ? ev.isTrusted : null, data });
    return Promise.resolve();
  };
  const canShare = function canShare(data) { return !!data && Array.isArray(data.files) && data.files.length > 0; };
  Object.defineProperty(Navigator.prototype, 'share', { value: share, configurable: true, writable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', { value: canShare, configurable: true, writable: true });
}

// Check 9: no Web Share at all.
function noShare() {
  delete Navigator.prototype.share;
  delete Navigator.prototype.canShare;
  try { delete navigator.share; delete navigator.canShare; } catch { /* own props are rare */ }
}

// ------------------------------------------------------------------ sessions

let browser = null;
let fixture = null;

async function openSession({ viewport = PRIMARY, js = true, init = [], label }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    javaScriptEnabled: js,
  });
  const s = { context, page: null, viewport, label, errors: [], logs: [], requests: [], trials: [], taps: 0, insetsEmulated: false };
  context.on('request', (r) => s.requests.push(r.url()));
  if (js) {
    await context.addInitScript(pageHelpers);
    for (const fn of init) await context.addInitScript(fn);
  }
  const page = await context.newPage();
  s.page = page;
  page.on('pageerror', (e) => s.errors.push({ message: firstLine(e), stack: e.stack }));
  page.on('console', (m) => s.logs.push(`[${m.type()}] ${m.text()}`));
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: insetsFor(viewport) });
    s.insetsEmulated = true;
  } catch { /* older Chromium: env() stays 0 and checks measure against that */ }
  s.close = async () => {
    for (const t of s.trials) if (!t.done) { await t.fail('not finished: the scenario stopped early'); await t.end(); }
    try {
      await mkdir(join(opts.out, 'logs'), { recursive: true });
      const errs = s.errors.map((e) => `[pageerror] ${e.stack ?? e.message}`);
      await writeFile(join(opts.out, 'logs', `${slug(label)}.txt`), [...errs, ...s.logs].join('\n') + '\n');
    } catch { /* logs are a convenience */ }
    await context.close().catch(() => {});
  };
  return s;
}

async function settle(s, ms = 120) {
  await s.page.evaluate(() => window.__acc?.frames(2)).catch(() => {});
  if (ms) await sleep(ms);
}

async function gotoApp(s, url = opts.base) {
  await s.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  try {
    await s.page.waitForFunction(() => !!window.gesso?.editor, null, { timeout: 20_000 });
  } catch {
    const hint = await s.page.locator('#hint').innerText().catch(() => '');
    throw new Error(`the app did not start (window.gesso never set; hint line: ${quote(hint)})`);
  }
}

// Load the fixture through the real file input (what "Choose a photo" opens).
async function importFixture(s) {
  await s.page.setInputFiles('#file', fixture.path);
  try {
    await s.page.waitForFunction((name) => {
      const ed = window.gesso?.editor;
      return document.querySelector('#app')?.dataset.state === 'editing' && ed?.history?.entries?.length === 1 && ed.sourceInfo?.name === name;
    }, FIXTURE.name, { timeout: 30_000 });
  } catch {
    const hint = await s.page.locator('#hint').innerText().catch(() => '');
    throw new Error(`the fixture never opened (#app not editing a fresh photo after 30 s; hint line: ${quote(hint)})`);
  }
  await settle(s, 250);
}

async function tap(s, sel, { timeout = 3000 } = {}) {
  try {
    await s.page.locator(sel).first().tap({ timeout });
  } catch {
    const why = await s.page.evaluate((q) => {
      const el = document.querySelector(q);
      if (!el) return 'no such element';
      if (el.disabled) return 'it is disabled';
      if (!window.__acc?.rendered(el)) return 'it is not visible';
      return 'it did not take the tap (covered?)';
    }, sel).catch(() => 'the page is gone');
    throw new Error(`could not tap ${sel}: ${why}`);
  }
  s.taps++;
  await settle(s);
}

const snap = (s) => s.page.evaluate(() => window.__acc.snap());
const toolOf = (s) => s.page.evaluate(() => document.querySelector('#app')?.dataset.tool);

async function openTool(s, id) {
  await tap(s, `#dock [data-tool="${id}"]`);
  try {
    await s.page.waitForFunction((t) => document.querySelector('#app')?.dataset.tool === t, id, { timeout: 3000 });
  } catch {
    throw new Error(`tapping the ${id} dock button did not open ${id} (#app data-tool is ${quote(await toolOf(s))})`);
  }
  await settle(s, 200);
}

// Back to Home from any tool: Cancel when it is showing, else the active dock button.
async function goHome(s, how = 'cancel') {
  if ((await toolOf(s)) === 'home') return;
  const sel = how === 'done' ? '#done' : '#cancel';
  const shown = await s.page.evaluate((q) => window.__acc.rendered(document.querySelector(q)), sel);
  if (shown) await tap(s, sel);
  else await tap(s, `#dock [data-tool="${await toolOf(s)}"]`);
  await s.page.waitForFunction(() => document.querySelector('#app')?.dataset.tool === 'home', null, { timeout: 3000 })
    .catch(() => { throw new Error(`could not leave the tool for Home with ${sel}`); });
  await settle(s);
}

async function waitEntry(s, before, ms) {
  return s.page.evaluate(([i, n, t]) => window.__acc.waitHistory(i, n, t), [before.index, before.len, ms]);
}

// Page coordinates of a point given in stage CSS px.
async function stagePoint(s, x, y) {
  const b = await s.page.locator('#stage').boundingBox();
  return [b.x + x, b.y + y];
}

async function stageCenter(s) {
  const b = await s.page.locator('#stage').boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
}

// Page coordinates of the fixture's speck, through the crop and the view.
async function speckPoint(s) {
  const [x, y] = await s.page.evaluate(async (fx) => {
    const ed = window.gesso.editor;
    const g = await import(new URL('lib/geometry.js', document.baseURI).href);
    const st = ed.doc;
    const k = st.source.w / fx.width;
    const m = g.sourceToOutput(st.crop, st.source.w, st.source.h);
    const [ox, oy] = g.apply(m, fx.speck.x * k, fx.speck.y * k);
    return ed.docToStage(ox, oy);
  }, FIXTURE);
  return stagePoint(s, x, y);
}

// A synthesized tap on the photo: down and up 40 ms apart, no movement.
async function pointerTap(s, [x, y], ms = 40) {
  await s.page.mouse.move(x, y);
  await s.page.mouse.down();
  await sleep(ms);
  await s.page.mouse.up();
}

async function centerOf(s, sel) {
  const b = await s.page.locator(sel).boundingBox();
  if (!b) throw new Error(`${sel} has no box`);
  return [b.x + b.width / 2, b.y + b.height / 2];
}

// ------------------------------------------------------------------ the UI states checks 2–4 visit

const STATES = [
  { id: 'home' },
  { id: 'crop', tool: 'crop' },
  { id: 'light', tool: 'light' },
  { id: 'light/Paint', tool: 'light', then: ['[data-dial="paint"]'] },
  { id: 'color', tool: 'color' },
  { id: 'color/Pick white', tool: 'color', then: ['[data-dial="pick"]'] },
  { id: 'remove', tool: 'remove' },
  { id: 'text', tool: 'text' },
  { id: 'text/after Done', tool: 'text', then: ['#caption-done'] },
  { id: 'text/Color', tool: 'text', then: ['#caption-done', '[data-dial="color"]'] },
];

// ------------------------------------------------------------------ scenario: layout (1, 2, 3, 4, 5, 13 and 12's gesture table)

async function scenarioLayout(vp, { gestures }) {
  const s = await openSession({ viewport: vp, label: `layout-${vp.label}` });
  const where = vp.label;
  try {
    await gotoApp(s);
    await importFixture(s);
    const insets = await s.page.evaluate(() => window.__acc.insets());
    const insetNote = s.insetsEmulated ? `safe area ${insets.top}/${insets.right}/${insets.bottom}/${insets.left}` : 'safe area not emulated (env() = 0)';

    await check(s, 1, where, async (t) => {
      const info = await s.page.evaluate(() => {
        const a = window.__acc;
        return {
          dock: a.qa('#dock button').filter(a.rendered).map(a.controlInfo),
          actions: a.qa('#actions button').filter(a.rendered).map(a.controlInfo),
          vw: innerWidth,
          vh: innerHeight,
        };
      });
      const dockText = info.dock.map((c) => c.text);
      await t.expect(JSON.stringify(dockText) === JSON.stringify(DOCK), `dock buttons read ${quote(dockText.join(' · '))}, want exactly ${quote(DOCK.join(' · '))}`);
      const actText = info.actions.map((c) => c.text);
      await t.expect(JSON.stringify(actText) === JSON.stringify(ACTIONS), `action buttons read ${quote(actText.join(' · '))}, want ${quote(ACTIONS.join(' · '))}`);
      const all = [...info.dock, ...info.actions];
      const box = { left: insets.left, top: insets.top, right: info.vw - insets.right, bottom: info.vh - insets.bottom };
      for (const c of all) {
        const r = c.rect;
        const name = c.text || c.desc;
        if (r.left < box.left - 0.5 || r.top < box.top - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5) {
          await t.fail(`${name} at ${fmtRect(r)} leaves the safe area ${fmtRect(box)}`);
        }
        if (r.width < 44 - 0.01 || r.height < 44 - 0.01) await t.fail(`${name} hit box is ${r.width.toFixed(1)}×${r.height.toFixed(1)} (want ≥ 44×44)`);
        if (!c.sizes.length) await t.fail(`${name} shows no visible text`);
        const small = c.sizes.filter((x) => x.size < 12);
        if (small.length) await t.fail(`${name} text ${quote(small[0].text)} is ${small[0].size}px (want ≥ 12px)`);
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i].rect, b = all[j].rect;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 0.5 && oy > 0.5) await t.fail(`${all[i].text} and ${all[j].text} overlap by ${ox.toFixed(1)}×${oy.toFixed(1)}`);
        }
      }
      t.note(insetNote);
    });

    await check(s, 5, where, async (t) => {
      const ctrls = await s.page.evaluate(() => window.__acc.controls());
      await t.expect(ctrls.length <= 12, `${ctrls.length} enabled controls outside #stage in Home (want ≤ 12): ${list(ctrls, 14)}`);
      t.note(`${ctrls.length} controls`);
    });

    // Checks 2, 3, 4 and 13 look at every state; each failure is reported (and
    // photographed) in the state it happens in.
    const t2 = begin(s, 2, where);
    const t3 = begin(s, 3, where);
    const t4 = begin(s, 4, where);
    const t13 = begin(s, 13, where);
    const selectors = gestures ? [...new Set(gestures.flatMap((g) => (g.sel ? g.sel.split(',').map((x) => x.trim()) : [])))] : [];
    const exists = {};
    let home = null;
    for (const st of STATES) {
      try {
        if (st.tool) await openTool(s, st.tool);
        for (const sel of st.then ?? []) await tap(s, sel);
        await settle(s, 150);
        const m = await s.page.evaluate((sels) => window.__acc.measure(sels), selectors);
        if (!home) home = m;
        for (const [k, v] of Object.entries(m.exists)) if (v) exists[k] = true;
        if (t2) await judgeHidden(t2, st.id, m);
        if (t3) await judgePlaces(t3, st.id, m, home);
        if (t4) await judgeLabels(t4, st.id, m);
        if (t13) await judgeZoom(t13, st.id, m);
      } catch (err) {
        for (const t of [t2, t3, t4, t13]) if (t) await t.fail(`${st.id}: ${firstLine(err)}`);
      }
      if (st.tool) await goHome(s).catch(() => {});
    }
    for (const t of [t2, t3, t4, t13]) if (t) { t.note(`${STATES.length} states`); await t.end(); }

    if (gestures) {
      await check(s, 12, 'gesture table vs live DOM', async (t) => {
        const missing = [];
        for (const g of gestures) {
          const parts = g.sel ? g.sel.split(',').map((x) => x.trim()) : [];
          const absent = parts.filter((p) => !exists[p]);
          const selOk = parts.length > 0 && absent.length === 0;
          const hintOk = !!g.hint && g.hintExists;
          if (!selOk && !hintOk) {
            await t.fail(`${g.id}: ${g.sel ? `selector ${quote(g.sel)} matches nothing in index.html or any tool panel` : 'no visible equivalent'}${g.hint ? ` and hint ${g.hint} is not in HINTS` : ' and no hint'}`);
          } else if (absent.length) {
            missing.push(`${g.id} (${absent.join(', ')}; covered by ${g.hint})`);
          }
        }
        if (missing.length) t.note(`selectors missing but hint-covered: ${list(missing)}`);
        t.note(`${gestures.length} gestures`);
      });
    }
  } finally {
    await s.close();
  }
}

function fmtRect(r) {
  return `[${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}]`;
}

async function judgeHidden(t, state, m) {
  for (const o of m.overflow) await t.fail(`${state}: ${o.name} overflows (scroll ${o.sw}×${o.sh} vs client ${o.cw}×${o.ch})`);
  for (const b of m.badNames) await t.fail(`${state}: ${b} matches /menu|more|options|settings|overflow/i`);
  for (const h of m.haspopup) await t.fail(`${state}: ${h} has aria-haspopup`);
  if (m.truncated.length) t.note(`${state}: truncated chip text ${list(m.truncated, 3)}`);
}

async function judgePlaces(t, state, m, home) {
  for (const [k, r] of Object.entries(home.rects)) {
    const now = m.rects[k];
    if (!now) { await t.fail(`${state}: ${k} is missing`); continue; }
    const d = Math.max(Math.abs(now.left - r.left), Math.abs(now.top - r.top), Math.abs(now.width - r.width), Math.abs(now.height - r.height));
    if (d > 1) await t.fail(`${state}: ${k} moved to ${fmtRect(now)} from ${fmtRect(r)} in Home (Δ ${d.toFixed(1)}px)`);
  }
  if (m.panelH === null || Math.abs(m.panelH - 204) > 1) await t.fail(`${state}: #panel is ${m.panelH}px tall (want 204±1)`);
}

async function judgeLabels(t, state, m) {
  for (const u of m.unlabelled) await t.fail(`${state}: ${u} has no visible text`);
  for (const r of m.rulers) {
    if (r.role !== 'slider') await t.fail(`${state}: ruler ${r.desc} has role ${quote(r.role)} (want slider)`);
    if (!r.valuetext) await t.fail(`${state}: ruler ${r.desc} has an empty aria-valuetext`);
  }
  for (const sl of m.sliders) {
    if (!sl.valuetext) await t.fail(`${state}: slider ${sl.desc} has an empty aria-valuetext`);
    if (!sl.name) await t.fail(`${state}: slider ${sl.desc} has no name`);
  }
}

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week', '']);
async function judgeZoom(t, state, m) {
  for (const i of m.inputs) {
    const typed = i.tag === 'textarea' || TEXT_TYPES.has(i.type);
    if (!typed) continue;
    if (!(i.size >= 16)) await t.fail(`${state}: ${i.desc} font-size ${i.size}px (want ≥ 16px)`);
  }
  if (state === 'home') {
    const skipped = m.inputs.filter((i) => !(i.tag === 'textarea' || TEXT_TYPES.has(i.type))).map((i) => `${i.desc} (type=${i.type})`);
    if (skipped.length) t.note(`not text-entry, so no zoom: ${skipped.join(', ')}`);
  }
}

// ------------------------------------------------------------------ scenario: static paint (6)

async function scenarioStatic(vp) {
  const s = await openSession({ viewport: vp, js: false, label: `static-${vp.label}` });
  try {
    await check(s, 6, vp.label, async (t) => {
      await s.page.goto(opts.base, { waitUntil: 'load', timeout: 30_000 });
      const info = await s.page.evaluate(() => {
        const vis = (el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          let o = 1;
          for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
          return { text: (el.innerText || '').trim(), w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom, size: parseFloat(cs.fontSize), color: cs.color, opacity: o, vis: cs.visibility };
        };
        return {
          dock: [...document.querySelectorAll('#dock button')].map(vis),
          actions: [...document.querySelectorAll('#actions button')].map(vis),
          vw: innerWidth,
          vh: innerHeight,
          js: typeof window.gesso,
        };
      });
      const dockText = info.dock.map((c) => c.text);
      const actText = info.actions.map((c) => c.text);
      await t.expect(JSON.stringify(dockText) === JSON.stringify(DOCK), `dock reads ${quote(dockText.join(' · '))} without JS`);
      await t.expect(JSON.stringify(actText) === JSON.stringify(ACTIONS), `actions read ${quote(actText.join(' · '))} without JS`);
      for (const c of [...info.dock, ...info.actions]) {
        const off = c.w <= 0 || c.h <= 0 || c.l < -0.5 || c.t < -0.5 || c.r > info.vw + 0.5 || c.b > info.vh + 0.5;
        if (off) await t.fail(`${quote(c.text)} is not painted inside the viewport without JS (${c.w}×${c.h} at ${Math.round(c.l)},${Math.round(c.t)})`);
        else if (c.vis !== 'visible' || c.opacity < 0.2 || c.size < 1) await t.fail(`${quote(c.text)} is not legible without JS (opacity ${c.opacity.toFixed(2)}, ${c.size}px)`);
      }
      if (info.js !== 'undefined') t.note('JS appears to have run');
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ scenario: one-tap defaults (7) and undo integrity (10)

async function scenarioDefaults() {
  const s = await openSession({ label: 'defaults' });
  const t7 = begin(s, 7, 'one-tap defaults');
  const t10 = begin(s, 10, 'Undo after each check-7 action');
  const verified = [];
  try {
    await gotoApp(s);
    await importFixture(s);

    // Undo right after an action: the state from before it, and "Undid: …".
    const undoAfter = async (what, before) => {
      if (!t10) return;
      await tap(s, '#undo');
      const after = await snap(s);
      const toast = await s.page.evaluate(() => ({ text: document.querySelector('#toast')?.textContent ?? '', on: document.querySelector('#toast')?.classList.contains('is-on') }));
      let ok = true;
      if (after.state !== before.state) ok = await t10.fail(`${what}: after Undo the document differs from before (${diffKeys(before.state, after.state).join(', ')})`);
      if (!toast.text.startsWith('Undid:')) ok = await t10.fail(`${what}: Undo toast reads ${quote(toast.text)} (want it to begin "Undid:")`);
      else if (!toast.on) ok = await t10.fail(`${what}: the "Undid:" toast is not showing`);
      if (ok) verified.push(what);
    };

    // One tool's first Quick chip.
    const quickDefault = async (tool) => {
      await openTool(s, tool);
      const first = await s.page.evaluate(() => {
        const b = document.querySelector('#quick button');
        return b ? { id: b.dataset.quick, def: b.hasAttribute('data-default'), text: window.__acc.text(b), disabled: b.disabled } : null;
      });
      const name = `${tool[0].toUpperCase()}${tool.slice(1)} ${first?.text || 'first chip'}`;
      if (t7) {
        if (!first) { await t7.fail(`${tool}: the Quick row is empty`); await goHome(s); return; }
        await t7.expect(first.def, `${tool}: the first Quick chip ${quote(first.text)} has no [data-default]`);
      }
      const before = await snap(s);
      await tap(s, '#quick button >> nth=0');
      await waitEntry(s, before, 1500);
      await settle(s, 300);
      const after = await snap(s);
      const added = after.len - before.len;
      const label = after.labels[after.index];
      let entryOk = false;
      if (t7) {
        if (added !== 1 || after.index !== before.index + 1) await t7.fail(`${name}: added ${added} history entries (want exactly 1)`);
        else if (!label || !label.trim()) await t7.fail(`${name}: the new history entry has an empty label`);
        else entryOk = true;
        if (after.state === before.state) await t7.fail(`${name}: the document did not change`);
        if (tool === 'crop') {
          const angle = JSON.parse(after.state).crop?.angle;
          await t7.expect(typeof angle === 'number' && Math.abs(angle - -3) <= 0.5, `Crop Auto set the angle to ${angle}° (want −3°±0.5° for the fixture's +3° horizon)`);
        }
      } else entryOk = added === 1;
      if (entryOk && after.state !== before.state) await undoAfter(name, before);
      else if (t10) await t10.fail(`unverified: ${name} added no undoable step (see check 7)`);
      await goHome(s, 'done');
    };

    for (const tool of ['crop', 'light', 'color']) {
      try { await quickDefault(tool); } catch (err) {
        if (t7) await t7.fail(`${tool}: ${firstLine(err)}`);
        await goHome(s).catch(() => {});
      }
    }

    // Home: Auto-enhance.
    try {
      const before = await snap(s);
      await tap(s, '[data-quick="auto"]');
      await waitEntry(s, before, 1500);
      await settle(s, 300);
      const after = await snap(s);
      const label = after.labels[after.index];
      const chips = await s.page.evaluate(() => window.__acc.qa('#dials button').filter(window.__acc.rendered).map(window.__acc.text));
      let ok = true;
      if (t7) {
        if (after.len !== before.len + 1 || label !== 'Auto-enhance') ok = await t7.fail(`Auto-enhance added ${after.len - before.len} entries, newest ${quote(label)} (want one "Auto-enhance")`);
        await t7.expect(chips.length >= 1, 'Auto-enhance left no change chips in the dial row');
        if (chips.length) t7.note(`chips: ${chips.join(', ')}`);
      }
      if (ok && after.len === before.len + 1) await undoAfter('Auto-enhance', before);
      else if (t10) await t10.fail('unverified: Auto-enhance added no step (see check 7)');
    } catch (err) {
      if (t7) await t7.fail(`Auto-enhance: ${firstLine(err)}`);
    }

    // Remove: Medium on open; a tap on the speck heals it within a second.
    try {
      await openTool(s, 'remove');
      const sizes = await s.page.evaluate(() => ['small', 'medium', 'large'].map((id) => document.querySelector(`[data-quick="${id}"]`)?.getAttribute('aria-pressed') ?? null));
      if (t7) await t7.expect(sizes[1] === 'true' && sizes[0] !== 'true' && sizes[2] !== 'true', `Remove opened with Small/Medium/Large pressed = ${sizes.join('/')} (want Medium only)`);
      const before = await snap(s);
      await pointerTap(s, await speckPoint(s));
      const got = await waitEntry(s, before, 5000);
      const upAt = await s.page.evaluate(() => window.__acc.lastStageUp);
      const ms = got ? Math.round(got.at - upAt) : null;
      if (t7) {
        if (!got) await t7.fail('Remove: a tap on the speck added no history entry within 5 s');
        else if (got.label !== 'Removed spot') await t7.fail(`Remove: the tap added ${quote(got.label)} (want "Removed spot")`);
        else if (ms > 1000) await t7.fail(`Remove: "Removed spot" took ${ms} ms after the tap (want ≤ 1000 ms)`);
        else t7.note(`Removed spot in ${ms} ms`);
      }
      await settle(s, 200);
      if (got) await undoAfter('Remove tap', before);
      else if (t10) await t10.fail('unverified: the Remove tap added no step (see check 7)');
      await goHome(s, 'done');
    } catch (err) {
      if (t7) await t7.fail(`Remove: ${firstLine(err)}`);
      await goHome(s).catch(() => {});
    }

    // Text: the dock tap puts the keyboard up on "Your words", all selected.
    try {
      const before = await snap(s);
      await openTool(s, 'text');
      const f = await s.page.evaluate(() => {
        const a = document.activeElement;
        return { desc: window.__acc.describe(a), id: a?.id, tag: a?.tagName, value: a?.value, ss: a?.selectionStart, se: a?.selectionEnd };
      });
      if (t7) {
        if (f.id !== 'caption-input') await t7.fail(`Text: after the dock tap the focus is on ${f.desc} (want the caption textarea #caption-input)`);
        else {
          await t7.expect(f.value === 'Your words', `Text: the caption textarea holds ${quote(f.value)} (want "Your words")`);
          await t7.expect(f.ss === 0 && f.se === 10, `Text: the selection is ${f.ss}–${f.se} (want 0–10)`);
        }
      }
      if (t10) {
        // The caption becomes a step on Done; that step is what Undo must take back.
        const visible = await s.page.evaluate(() => window.__acc.rendered(document.querySelector('#caption-done')));
        if (!visible) await t10.fail('unverified: Text has no visible edit-bar Done to commit the caption');
        else {
          await tap(s, '#caption-done');
          const got = await waitEntry(s, before, 1500);
          await settle(s, 200);
          if (got) await undoAfter(`Text caption (${got.label})`, before);
          else await t10.fail('unverified: Text Done added no step to undo');
        }
      }
      await goHome(s, 'done');
    } catch (err) {
      if (t7) await t7.fail(`Text: ${firstLine(err)}`);
      if (t10) await t10.fail(`Text: ${firstLine(err)}`);
    }
    if (t10 && verified.length) t10.note(`verified: ${verified.join(', ')}`);
  } finally {
    for (const t of [t7, t10]) if (t) await t.end();
    await s.close();
  }
}

// ------------------------------------------------------------------ scenario: one-minute flow (8), no network (15), resume (17)

async function scenarioFlow() {
  const s = await openSession({ label: 'flow', init: [shareStub] });
  const t8 = begin(s, 8, 'Auto-enhance, Crop, Auto, Save');
  const t15 = begin(s, 15, 'requests during check 8');
  try {
    await gotoApp(s);
    let taps = 0;
    const step = async (sel) => { taps++; await tap(s, sel); };
    await importFixture(s);
    taps++; // the "Choose a photo" tap that opens the picker
    const t0 = await snap(s);
    await step('[data-quick="auto"]');
    const t1 = await snap(s);
    if (t8 && t1.labels[t1.index] !== 'Auto-enhance') t8.note(`Auto-enhance step reads ${quote(t1.labels[t1.index])}`);
    await step('#dock [data-tool="crop"]');
    await step('#quick [data-default]');
    const saveAt = Date.now();
    await step('#save');
    const sheetOpen = await s.page.waitForSelector('#sheet:not([hidden])', { state: 'visible', timeout: 2000 }).then(() => true, () => false);
    let shared = null;
    if (!sheetOpen) {
      const toast = await s.page.locator('#toast').textContent().catch(() => '');
      if (t8) await t8.fail(`Save did not open the Save sheet (#sheet stayed hidden; toast ${quote(toast)})`);
    } else {
      const left = Math.max(0, 4000 - (Date.now() - saveAt));
      const ready = await s.page.waitForSelector('#share[data-ready]', { state: 'attached', timeout: left }).then(() => true, () => false);
      if (!ready) {
        const label = await s.page.locator('#share').innerText().catch(() => '');
        if (t8) await t8.fail(`Save to Photos did not gain [data-ready] within 4 s of Save (it reads ${quote(label)})`);
      }
      const enabled = await s.page.evaluate(() => !document.querySelector('#share')?.disabled);
      if (ready || enabled) {
        await step('#share');
        await sleep(800);
        shared = await s.page.evaluate(async () => {
          const calls = window.__shareCalls ?? [];
          const out = {
            count: calls.length,
            calls: calls.map((c) => ({
              eventType: c.eventType,
              keys: c.data && typeof c.data === 'object' ? Object.keys(c.data) : [],
              files: Array.isArray(c.data?.files) ? c.data.files.map((f) => ({ isFile: f instanceof File, type: f.type, size: f.size, name: f.name })) : null,
            })),
            outputSize: window.gesso.editor.outputSize(),
          };
          const f = calls[0]?.data?.files?.[0];
          if (f instanceof Blob) {
            try {
              const b = await createImageBitmap(f);
              out.decoded = { width: b.width, height: b.height };
              b.close();
            } catch (e) { out.decodeError = String(e); }
          }
          return out;
        });
      }
    }
    if (t8 && shared) {
      const c = shared.calls[0];
      if (shared.count !== 1) await t8.fail(`navigator.share was called ${shared.count} times (want exactly 1)`);
      if (c) {
        await t8.expect(c.eventType === 'click', `navigator.share ran ${c.eventType ? `inside a ${c.eventType} handler` : 'outside any event handler (after an await?)'}, not synchronously in the click handler`);
        const extra = c.keys.filter((k) => k === 'title' || k === 'text');
        await t8.expect(!extra.length, `the share data carries ${extra.join(' and ')} (want files only)`);
        if (!c.files) await t8.fail(`the share data has no files array (keys: ${c.keys.join(', ') || 'none'})`);
        else if (c.files.length !== 1 || !c.files[0].isFile) await t8.fail(`the share data has ${c.files.length} files (want [File])`);
        else {
          const f = c.files[0];
          await t8.expect(f.type === 'image/jpeg', `the shared file type is ${quote(f.type)} (want image/jpeg)`);
          await t8.expect(f.size > 0, 'the shared file is empty');
          const o = shared.outputSize;
          if (shared.decodeError) await t8.fail(`the shared file does not decode: ${shared.decodeError}`);
          else if (shared.decoded) {
            const W = Math.round(o.width), H = Math.round(o.height);
            await t8.expect(shared.decoded.width === W && shared.decoded.height === H, `the JPEG decodes to ${shared.decoded.width}×${shared.decoded.height}, outputSize is ${W}×${H}`);
          }
          t8.note(`${f.name || 'unnamed'} ${(f.size / 1e6).toFixed(2)} MB`);
        }
      }
    } else if (t8 && sheetOpen && !shared) {
      await t8.fail('Save to Photos stayed disabled, so navigator.share was never reached');
    }
    if (t8) {
      await t8.expect(taps <= 6, `the flow took ${taps} taps (want ≤ 6)`);
      t8.note(`${taps} taps`);
      if (t0.len === t1.len) t8.note('Auto-enhance added no step');
    }
    if (t15) {
      const base = `${BASE.origin}${BASE.pathname}`;
      const bad = [...new Set(s.requests.filter((u) => !/^(data|blob):/.test(u) && !u.startsWith(base)))];
      await t15.expect(!bad.length, `requests outside ${base}: ${list(bad, 3)}`);
      t15.note(`${s.requests.length} requests`);
    }
    for (const t of [t8, t15]) if (t) await t.end();

    if (wanted(17)) {
      await check(s, 17, 'reload after check 8', async (t) => {
        const keep = await s.page.evaluate(() => window.__acc.rendered(document.querySelector('#sheet-keep')));
        if (keep) await tap(s, '#sheet-keep').catch(() => {});
        await goHome(s, 'done').catch(() => {});
        const before = await snap(s);
        await sleep(1500); // autosave writes 300 ms after a step
        await s.page.reload({ waitUntil: 'load', timeout: 30_000 });
        await s.page.waitForFunction(() => !!window.gesso?.editor, null, { timeout: 20_000 }).catch(() => {});
        const editing = await s.page.waitForFunction(() => document.querySelector('#app')?.dataset.state === 'editing' && window.gesso?.editor?.history, null, { timeout: 15_000 }).then(() => true, () => false);
        if (!editing) {
          const hint = await s.page.locator('#hint').innerText().catch(() => '');
          await t.fail(`after the reload the start screen showed: no draft was restored (hint line ${quote(hint)})`);
          return;
        }
        await settle(s, 300);
        const after = await snap(s);
        await t.expect(after.state === before.state, `the restored document differs (${diffKeys(before.state, after.state).join(', ')})`);
        await t.expect(JSON.stringify(after.labels) === JSON.stringify(before.labels), `the restored undo labels are ${quote(after.labels.join(' › '))} (want ${quote(before.labels.join(' › '))})`);
        await t.expect(after.index === before.index, `the restored history sits at step ${after.index} (want ${before.index})`);
        t.note(`${before.labels.length - 1} steps`);
      });
    }
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ scenario: Save fallback (9)

// Chromium has no -webkit-touch-callout, so when the computed style cannot say,
// read the stylesheets the page loaded and resolve the cascade for that one
// property by hand (specificity, then source order; inherited when unset).
function calloutFromSources(el, sheets) {
  const spec = (sel) => {
    const s = sel.replace(/::[\w-]+/g, ' x').replace(/:not\(([^)]*)\)/g, ' $1');
    const a = (s.match(/#[\w-]+/g) ?? []).length;
    const b = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
    const c = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
    return a * 1e6 + b * 1e3 + c;
  };
  const decls = [];
  let order = 0;
  for (const css of sheets) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const d = /(?:^|;)\s*-webkit-touch-callout\s*:\s*([^;!]+)(!important)?/i.exec(m[2]);
      if (!d) continue;
      decls.push({ selectors: m[1].split(',').map((x) => x.trim()).filter(Boolean), value: d[1].trim(), important: !!d[2], order: order++ });
    }
  }
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const inline = /-webkit-touch-callout\s*:\s*([^;!]+)/i.exec(e.getAttribute('style') ?? '');
    let best = null;
    for (const d of decls) {
      for (const sel of d.selectors) {
        let ok = false;
        try { ok = e.matches(sel); } catch { ok = false; }
        if (!ok) continue;
        const rank = (d.important ? 1e12 : 0) + spec(sel) * 1e3 + d.order;
        if (!best || rank > best.rank) best = { rank, value: d.value, sel };
      }
    }
    if (inline && !(best && best.rank >= 1e12)) return { value: inline[1].trim(), from: `inline style on ${e.tagName.toLowerCase()}` };
    if (best) return { value: best.value, from: `${best.sel}${e === el ? '' : ' (inherited)'}` };
  }
  return { value: 'default', from: 'initial value' };
}

async function scenarioFallback() {
  const s = await openSession({ label: 'fallback', init: [noShare] });
  try {
    await check(s, 9, 'navigator.share deleted', async (t) => {
      await gotoApp(s);
      const has = await s.page.evaluate(() => 'share' in navigator);
      if (has) t.note('navigator.share could not be removed');
      await importFixture(s);
      const saveAt = Date.now();
      await tap(s, '#save');
      const sheet = await s.page.waitForSelector('#sheet:not([hidden])', { state: 'visible', timeout: 2000 }).then(() => true, () => false);
      if (!sheet) {
        const toast = await s.page.locator('#toast').textContent().catch(() => '');
        await t.fail(`Save did not open the Save sheet (toast ${quote(toast)}), so Save to Photos could not be tapped`);
        return;
      }
      const left = Math.max(0, 4000 - (Date.now() - saveAt));
      await s.page.waitForSelector('#share[data-ready]', { state: 'attached', timeout: left }).catch(() => {});
      await tap(s, '#share', { timeout: 4000 });
      const shown = await s.page.waitForFunction(() => [...document.querySelectorAll('img')].some((i) => i.src.startsWith('blob:') && window.__acc.visible(i)), null, { timeout: 4000 }).then(() => true, () => false);
      if (!shown) {
        const fb = await s.page.evaluate(() => ({ hidden: document.querySelector('#fallback')?.hidden, src: document.querySelector('#fallback-img')?.getAttribute('src') }));
        await t.fail(`no visible <img src="blob:…"> after Save to Photos (#fallback hidden=${fb.hidden}, #fallback-img src=${quote(fb.src)})`);
        return;
      }
      await s.page.waitForFunction(() => [...document.querySelectorAll('img')].some((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0), null, { timeout: 4000 }).catch(() => {});
      const info = await s.page.evaluate(async (resolver) => {
        const a = window.__acc;
        const img = [...document.querySelectorAll('img')].find((i) => i.src.startsWith('blob:') && a.visible(i));
        let full = null;
        for (let e = img; e && e.nodeType === 1; e = e.parentElement) {
          const r = e.getBoundingClientRect();
          if (a.visible(e) && r.left <= 1 && r.top <= 1 && r.right >= innerWidth - 1 && r.bottom >= innerHeight - 1) { full = a.describe(e).split(' "')[0]; break; }
        }
        const supported = CSS.supports('-webkit-touch-callout', 'none');
        let callout;
        if (supported) callout = { value: getComputedStyle(img).getPropertyValue('-webkit-touch-callout'), from: 'computed style' };
        else {
          const sheets = [];
          for (const l of document.querySelectorAll('link[rel~="stylesheet"]')) {
            try { sheets.push(await (await fetch(l.href)).text()); } catch { /* unreadable sheet */ }
          }
          for (const st of document.querySelectorAll('style')) sheets.push(st.textContent);
          // eslint-disable-next-line no-new-func
          callout = new Function(`return (${resolver})`)()(img, sheets);
          callout.from = `stylesheet: ${callout.from}`;
        }
        return { desc: a.describe(img), natural: [img.naturalWidth, img.naturalHeight], full, callout, text: a.visibleText(/Touch and hold the picture/) };
      }, calloutFromSources.toString());
      await t.expect(info.full, `the blob image ${info.desc} is not inside a full-screen view`);
      await t.expect(info.natural[0] > 0, 'the blob image did not load');
      await t.expect(info.callout.value && info.callout.value !== 'none', `-webkit-touch-callout on the image is ${quote(info.callout.value)} (${info.callout.from}); want anything but none`);
      await t.expect(info.text.length > 0, 'no visible "Touch and hold the picture" text');
      t.note(`callout ${info.callout.value} via ${info.callout.from}`);
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ scenario: Before (11)

async function scenarioBefore() {
  const s = await openSession({ label: 'before' });
  try {
    await gotoApp(s);
    await importFixture(s);
    await check(s, 11, 'Before', async (t) => {
      const before = await centerOf(s, '#before');
      // A tap on Before: on for 1.2 s, and the words "Hold to compare".
      await s.page.mouse.move(...before);
      await s.page.mouse.down();
      await sleep(60);
      await s.page.mouse.up();
      const sampling = s.page.evaluate(() => window.__acc.sampleCompare(2000));
      await sleep(350);
      const words = await s.page.evaluate(() => window.__acc.visibleText(/Hold to compare/i));
      const samples = await sampling;
      const up = await s.page.evaluate(() => window.__acc.lastBeforeUp);
      const onAt = samples.find((x) => x.v === 'before');
      const offAt = samples.find((x) => onAt && x.t > onAt.t && x.v !== 'before');
      if (!onAt) await t.fail('a tap on Before never set #stage[data-compare=before]');
      else {
        const held = (offAt ? offAt.t : Infinity) - up;
        await t.expect(held >= 1000 && held <= 1500, `a tap on Before kept it for ${Number.isFinite(held) ? `${Math.round(held)} ms` : 'over 2 s'} (want about 1.2 s)`);
      }
      await t.expect(words.length > 0, 'a tap on Before did not show "Hold to compare"');

      // Hold the button: on while down, off on release.
      await sleep(300);
      await s.page.mouse.move(...before);
      await s.page.mouse.down();
      await sleep(120);
      await settle(s, 0);
      const down = await s.page.evaluate(() => window.__acc.compare());
      await sleep(500);
      await s.page.mouse.up();
      await settle(s, 60);
      const released = await s.page.evaluate(() => window.__acc.compare());
      await t.expect(down === 'before', `pointerdown on Before left data-compare=${quote(down)} (want "before")`);
      await t.expect(released === 'off', `pointerup after holding Before left data-compare=${quote(released)} (want "off")`);

      // A still 600 ms press on the photo, in every tool state.
      for (const id of ['home', ...TOOLS]) {
        try {
          if (id !== 'home') await openTool(s, id);
          const p = await stageCenter(s);
          await s.page.mouse.move(...p);
          await s.page.mouse.down();
          await sleep(600);
          await settle(s, 0);
          const held = await s.page.evaluate(() => window.__acc.compare());
          await s.page.mouse.up();
          await settle(s, 60);
          const after = await s.page.evaluate(() => window.__acc.compare());
          await t.expect(held === 'before', `${id}: a still 600 ms press on the photo left data-compare=${quote(held)} (want "before")`);
          await t.expect(after === 'off', `${id}: lifting after the press left data-compare=${quote(after)} (want "off")`);
        } catch (err) {
          await t.fail(`${id}: ${firstLine(err)}`);
        }
        if (id !== 'home') await goHome(s).catch(() => {});
      }
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ scenario: hints in the browser (12)

async function scenarioHints() {
  const s = await openSession({ label: 'hints' });
  try {
    await check(s, 12, 'hints across a reload', async (t) => {
      await gotoApp(s);
      await importFixture(s);
      const table = await s.page.evaluate(async () => (await import(new URL('lib/hints.js', document.baseURI).href)).HINTS.map((h) => ({ id: h.id, text: h.text })));
      const beforeTap = async () => {
        const p = await centerOf(s, '#before');
        await s.page.mouse.move(...p);
        await s.page.mouse.down();
        await sleep(60);
        await s.page.mouse.up();
      };
      // Earn H14 (Auto-enhance) and, on top of it, H3 (Before taps).
      const session = async () => {
        await s.page.evaluate((tb) => window.__acc.trackHints(tb), table);
        await tap(s, '[data-quick="auto"]');
        await sleep(1200);
        await beforeTap();
        await sleep(4500);
        await beforeTap();
        await sleep(1500);
        return s.page.evaluate(() => {
          let stored = null;
          try { stored = localStorage.getItem('gesso:hints'); } catch { /* blocked */ }
          return { ...window.__acc.hints, stored };
        });
      };
      const one = await session();
      const shownOne = one.shows.map((x) => x.id);
      const dupOne = shownOne.filter((id, i) => shownOne.indexOf(id) !== i);
      if (!shownOne.length) {
        await t.fail(`no hint appeared after Auto-enhance (H14) or two Before taps (H3); gesso:hints = ${quote(one.stored)}`);
        return;
      }
      await t.expect(!dupOne.length, `in one session ${dupOne.join(', ')} showed twice`);
      let stored = [];
      try { stored = JSON.parse(one.stored ?? '[]'); } catch { stored = []; }
      const unsaved = [...new Set(shownOne)].filter((id) => !stored.includes(id));
      await t.expect(!unsaved.length, `${unsaved.join(', ')} showed but localStorage['gesso:hints'] is ${quote(one.stored)}`);

      await s.page.reload({ waitUntil: 'load' });
      await s.page.waitForFunction(() => !!window.gesso?.editor, null, { timeout: 20_000 });
      await sleep(800); // let a restored draft settle before replacing it
      await importFixture(s);
      const two = await session();
      const again = two.shows.map((x) => x.id).filter((id) => shownOne.includes(id) || stored.includes(id));
      await t.expect(!again.length, `after a reload ${[...new Set(again)].join(', ')} showed again`);
      const max = Math.max(one.max, two.max);
      await t.expect(max <= 1, `${max} hints were visible at once (${(one.max >= two.max ? one.maxAt : two.maxAt).join(' + ')})`);
      t.note(`shown: ${shownOne.join(', ')}; after reload: ${two.shows.map((x) => x.id).join(', ') || 'none'}`);
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ scenario: offline (14)

async function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function swStatic(t) {
  const sw = await readFile(join(APP_DIR, 'sw.js'), 'utf8');
  const m = /const\s+SHELL\s*=\s*\[([\s\S]*?)\]/.exec(sw);
  if (!m) { await t.fail('sw.js has no `const SHELL = [...]`'); return; }
  const shell = new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
  const rel = (p) => `./${relative(APP_DIR, p).split('\\').join('/')}`;
  const need = [];
  for (const d of ['lib', 'ui', 'workers']) need.push(...(await walk(join(APP_DIR, d))).map(rel));
  // The root shell: the page, what it links, and the manifest's icons.
  const root = new Set(['./', './index.html', './styles.css', './app.js', './manifest.webmanifest']);
  const html = await readFile(join(APP_DIR, 'index.html'), 'utf8');
  for (const r of html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="(\.\/[^"#?]+)"/g)) root.add(r[1]);
  try {
    const man = JSON.parse(await readFile(join(APP_DIR, 'manifest.webmanifest'), 'utf8'));
    for (const i of man.icons ?? []) if (i.src && !/^[a-z]+:/i.test(i.src)) root.add(i.src.startsWith('./') ? i.src : `./${i.src.replace(/^\//, '')}`);
  } catch { /* checked by the browser part */ }
  const missing = [...need, ...root].filter((p) => !shell.has(p));
  await t.expect(!missing.length, `sw.js SHELL is missing ${list(missing, 6)}`);
  const stale = [];
  for (const p of shell) {
    if (p === './') continue;
    try { await access(join(APP_DIR, p)); } catch { stale.push(p); }
  }
  await t.expect(!stale.length, `sw.js SHELL lists files that do not exist: ${list(stale)}`);
  const a = sw.indexOf("addEventListener('activate'");
  const next = a < 0 ? -1 : sw.indexOf('addEventListener(', a + 10);
  const block = a < 0 ? '' : sw.slice(a, next < 0 ? undefined : next);
  if (!block) await t.fail('sw.js has no activate handler');
  else {
    const filter = block.search(/startsWith\(\s*['"]gesso-['"]\s*\)/);
    const del = block.indexOf('caches.delete');
    await t.expect(filter >= 0 && del > filter, 'the activate handler does not limit caches.delete to keys starting with "gesso-"');
  }
}

// A pass-through to --base that can drop off the network for real. Chromium's
// offline emulation does not reach a service worker's own fetches, so with
// setOffline alone a network-first worker would still be online and the check
// could never fail.
async function startProxy(base) {
  const target = new URL(base);
  let offline = false;
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    if (offline) { req.socket.destroy(); return; }
    try {
      const r = await fetch(new URL(req.url, target.origin), { redirect: 'manual', headers: { accept: req.headers.accept ?? '*/*' } });
      const body = Buffer.from(await r.arrayBuffer());
      const headers = { 'content-length': body.length, 'cache-control': 'no-cache' };
      for (const k of ['content-type', 'location', 'last-modified']) { const v = r.headers.get(k); if (v) headers[k] = v; }
      res.writeHead(r.status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(e));
    }
  });
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    base: `${origin}${target.pathname}`,
    setOffline(v) { offline = v; if (v) for (const sock of sockets) sock.destroy(); },
    close: () => new Promise((r) => { for (const sock of sockets) sock.destroy(); server.close(() => r()); }),
  };
}

async function scenarioOffline() {
  await check(null, 14, 'sw.js SHELL and activate (node)', swStatic);
  const proxy = await startProxy(opts.base);
  const s = await openSession({ label: 'offline' });
  try {
    await check(s, 14, 'offline reload (browser)', async (t) => {
      // Caches that belong to someone else on this origin, made before Gesso's
      // worker activates: it must only ever delete its own.
      await s.page.goto(`${proxy.base}manifest.webmanifest`);
      await s.page.evaluate(async () => {
        await (await caches.open('textlock-v1')).put('/textlock/probe', new Response('x'));
        await (await caches.open('gesso-v0-old')).put('/gesso/probe', new Response('x'));
      });
      await gotoApp(s, proxy.base);
      const sw = await s.page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return { error: 'no serviceWorker' };
        const timeout = new Promise((r) => setTimeout(() => r('timeout'), 15000));
        const ready = (async () => {
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
          return 'ok';
        })();
        const r = await Promise.race([ready, timeout]);
        return { r, keys: await caches.keys() };
      });
      if (sw.r !== 'ok') { await t.fail(`the service worker never took control (${sw.error ?? sw.r})`); return; }
      await t.expect(sw.keys.includes('textlock-v1'), `activating Gesso's worker deleted another app's cache (keys now ${quote(sw.keys.join(', '))})`);
      await t.expect(sw.keys.some((k) => k.startsWith('gesso-') && k !== 'gesso-v0-old'), `no gesso-* shell cache after install (keys ${quote(sw.keys.join(', '))})`);
      if (sw.keys.includes('gesso-v0-old')) t.note('an old gesso-* cache survived activation');

      await s.context.setOffline(true);
      proxy.setOffline(true);
      const probe = await s.page.evaluate(async () => {
        try { const r = await fetch(`./__offline_probe__?${Date.now()}`); return { status: r.status }; } catch (e) { return { error: String(e) }; }
      });
      if (probe.status === 404) t.note('the network still answered while offline; the result may be optimistic');
      const failed = [];
      const onFail = (r) => failed.push(`${r.url().replace(proxy.origin, '')} (${r.failure()?.errorText})`);
      s.context.on('requestfailed', onFail);
      try {
        await s.page.reload({ waitUntil: 'load', timeout: 20_000 });
      } catch (err) {
        await t.fail(`the offline reload failed: ${firstLine(err)}`);
        return;
      }
      const started = await s.page.waitForFunction(() => !!window.gesso?.editor, null, { timeout: 15_000 }).then(() => true, () => false);
      if (!started) {
        await t.fail(`offline, the app did not start (window.gesso never set)${failed.length ? `; failed: ${list(failed, 4)}` : ''}`);
        return;
      }
      const dock = await s.page.evaluate(() => window.__acc.qa('#dock button').filter(window.__acc.visible).map(window.__acc.text));
      await t.expect(JSON.stringify(dock) === JSON.stringify(DOCK), `offline, the dock reads ${quote(dock.join(' · '))}`);
      try {
        await importFixture(s);
      } catch (err) {
        await t.fail(`offline, ${firstLine(err)}${failed.length ? `; failed: ${list(failed, 4)}` : ''}`);
        return;
      }
      if (failed.length) await t.fail(`offline, requests failed: ${list(failed, 4)}`);
      t.note('editor rendered and opened the fixture offline');
    });
  } finally {
    await s.close();
    await proxy.close();
  }
}

// ------------------------------------------------------------------ scenario: Cancel (16)

async function scenarioCancel() {
  const s = await openSession({ label: 'cancel' });
  try {
    await gotoApp(s);
    await importFixture(s);
    await check(s, 16, 'Cancel in each tool', async (t) => {
      // Start from an edited photo, so "where the tool opened" is not the Original.
      const base = await snap(s);
      await tap(s, '[data-quick="auto"]').catch(() => {});
      await waitEntry(s, base, 1000);
      const changes = {
        crop: async () => tap(s, '[data-quick="square"]'),
        light: async () => tap(s, '[data-quick="brighter"]'),
        color: async () => tap(s, '[data-quick="look:film"]'),
        remove: async (before) => { await pointerTap(s, await speckPoint(s)); await waitEntry(s, before, 4000); },
        text: async () => tap(s, '#caption-done'), // the dock tap made the caption; Done commits it
      };
      for (const tool of TOOLS) {
        try {
          await openTool(s, tool);
          const s0 = await snap(s);
          await changes[tool](s0);
          await settle(s, 200);
          const s1 = await snap(s);
          if (s1.state === s0.state && s1.len === s0.len) {
            await t.fail(`${tool}: the change made no history entry, so Cancel could not be exercised`);
            await goHome(s);
            continue;
          }
          await tap(s, '#cancel');
          await s.page.waitForFunction(() => document.querySelector('#app')?.dataset.tool === 'home', null, { timeout: 2000 }).catch(() => {});
          await settle(s, 150);
          const s2 = await snap(s);
          if (s2.tool !== 'home') await t.fail(`${tool}: Cancel left the tool open (${s2.tool})`);
          if (s2.state !== s0.state) await t.fail(`${tool}: after Cancel the document differs from when the tool opened (${diffKeys(s0.state, s2.state).join(', ')})`);
          if (s2.shown !== s2.state) await t.fail(`${tool}: after Cancel a live preview is still showing (${diffKeys(s2.state, s2.shown).join(', ')})`);
          if (JSON.stringify(s2.labels) !== JSON.stringify(s0.labels)) await t.fail(`${tool}: history after Cancel is ${quote(s2.labels.join(' › '))} (want ${quote(s0.labels.join(' › '))})`);
        } catch (err) {
          await t.fail(`${tool}: ${firstLine(err)}`);
          await goHome(s).catch(() => {});
        }
      }
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ run

const SCENARIOS = [
  { name: 'layout', checks: [1, 2, 3, 4, 5, 12, 13], run: runLayout },
  { name: 'static', checks: [6], run: async () => { for (const vp of VIEWPORTS) await scenarioStatic(vp); } },
  { name: 'defaults', checks: [7, 10], run: scenarioDefaults },
  { name: 'flow', checks: [8, 15, 17], run: scenarioFlow },
  { name: 'fallback', checks: [9], run: scenarioFallback },
  { name: 'before', checks: [11], run: scenarioBefore },
  { name: 'hints', checks: [12], run: scenarioHints },
  { name: 'offline', checks: [14], run: scenarioOffline },
  { name: 'cancel', checks: [16], run: scenarioCancel },
];

async function runLayout() {
  const layoutWanted = [1, 2, 3, 4, 5, 13].some(wanted);
  let gestures = null;
  if (wanted(12)) {
    // lib/hints.js as the app serves it, read in a throwaway page.
    const s = await openSession({ label: 'gesture-table' });
    try {
      await gotoApp(s);
      gestures = await s.page.evaluate(async () => {
        const m = await import(new URL('lib/hints.js', document.baseURI).href);
        const ids = new Set(m.HINTS.map((h) => h.id));
        return m.GESTURES.map((g) => ({ id: g.id, sel: g.visibleEquivalent, hint: g.hint, hintExists: !!g.hint && ids.has(g.hint) }));
      });
    } finally {
      await s.close();
    }
  }
  for (const vp of layoutWanted ? VIEWPORTS : [PRIMARY]) {
    await scenarioLayout(vp, { gestures: vp === PRIMARY ? gestures : null });
  }
}

function summarize(no) {
  const runs = results.get(no) ?? [];
  if (!runs.length) return { status: 'SKIP', reason: 'not run' };
  const fails = runs.filter((r) => r.status === 'FAIL');
  if (fails.length) {
    // Group places that failed for the same first reason.
    const groups = new Map();
    for (const r of fails) {
      const k = r.reasons[0];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const parts = [...groups.entries()].map(([reason, rs]) => {
      const more = rs.reduce((n, r) => n + r.reasons.length - 1, 0);
      return `${rs.map((r) => r.where).join(', ')}: ${reason}${more ? ` (+${more} more)` : ''}`;
    });
    return { status: 'FAIL', reason: parts.join(' | ') };
  }
  if (runs.every((r) => r.status === 'SKIP')) return { status: 'SKIP', reason: runs.map((r) => r.notes[0]).join(' | ') };
  const notes = [...new Set(runs.flatMap((r) => r.notes))];
  const where = runs.length > 1 ? `${runs.length} runs (${runs.map((r) => r.where).join(', ')})` : runs[0].where;
  return { status: 'PASS', reason: `${where}${notes.length ? `; ${list(notes, 3)}` : ''}` };
}

async function main() {
  await mkdir(opts.out, { recursive: true });
  try {
    const r = await fetch(opts.base);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.error(`The app is not reachable at ${opts.base} (${firstLine(err)}). Start a server, e.g.\n  cd apps && python3 -m http.server 4174 --bind 127.0.0.1`);
    process.exit(2);
  }
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  const started = Date.now();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    fixture = await writeFixture(page, opts.out);
    await page.close();
    console.log(`fixture ${fixture.width}×${fixture.height}, median luma ${fixture.median.toFixed(3)}, ${(fixture.bytes / 1e6).toFixed(2)} MB → ${fixture.path}`);

    for (const sc of SCENARIOS) {
      if (!sc.checks.some(wanted)) continue;
      const t0 = Date.now();
      process.stdout.write(`… ${sc.name}`);
      let timer = null;
      try {
        await Promise.race([
          sc.run(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${SCENARIO_MS / 1000} s`)), SCENARIO_MS); }),
        ]);
      } catch (err) {
        for (const no of sc.checks.filter(wanted)) {
          if (!results.has(no)) record(no, { status: 'FAIL', where: sc.name, reasons: [`scenario failed: ${firstLine(err)}`], notes: [], shots: [] });
        }
      } finally {
        clearTimeout(timer);
      }
      process.stdout.write(` ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const rows = Object.keys(CHECKS).map(Number).filter(wanted).map((no) => ({ no, name: CHECKS[no], ...summarize(no) }));
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const cap = (s) => (s.length > 240 ? `${s.slice(0, 239)}…` : s);
  console.log('');
  console.log(`${' #'.padEnd(4)}${'Check'.padEnd(nameW + 2)}${'Result'.padEnd(8)}Reason`);
  for (const r of rows) console.log(`${String(r.no).padStart(2).padEnd(4)}${r.name.padEnd(nameW + 2)}${r.status.padEnd(8)}${cap(r.reason)}`);
  const failed = rows.filter((r) => r.status === 'FAIL');
  if (failed.length) {
    console.log('\nFailures in full:');
    for (const r of failed) {
      for (const run of results.get(r.no).filter((x) => x.status === 'FAIL')) {
        console.log(`  ${r.no} ${r.name} — ${run.where}`);
        for (const reason of run.reasons) console.log(`      • ${reason}`);
        for (const shot of run.shots) console.log(`      ▸ ${shot}`);
      }
    }
  }
  const counts = ['PASS', 'FAIL', 'SKIP'].map((k) => `${rows.filter((r) => r.status === k).length} ${k}`).join(', ');
  console.log(`\n${counts} in ${((Date.now() - started) / 1000).toFixed(0)} s. Screenshots and logs: ${opts.out}`);
  await writeFile(join(opts.out, 'results.json'), JSON.stringify({
    base: opts.base,
    at: new Date().toISOString(),
    fixture,
    checks: rows.map((r) => ({ ...r, runs: results.get(r.no) ?? [] })),
  }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
