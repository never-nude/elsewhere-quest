import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SP = '/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad';
const fixture = `${SP}/fixtures/coffee-12mp.jpg`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://127.0.0.1:4174/gesso/');
await page.setInputFiles('#file', fixture);
await page.waitForSelector('#app[data-state="editing"]', { timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-tool="remove"]');
await page.waitForTimeout(800);

// Snapped outline around the spoon bowl + visible handle, in stage CSS px.
const SNAP = (() => { const cx = 264, cy = 344, r = 27, pts = [[288, 333]]; for (let th = -5; th <= 280; th += 19) pts.push([+(cx + r * Math.cos(th * Math.PI / 180)).toFixed(1), +(cy + r * Math.sin(th * Math.PI / 180)).toFixed(1)]); pts.push([288, 288], [294, 287], [299, 294]); return pts; })();
// The finger's looser path (what the user actually drew), same order.
const FINGER = SNAP.map(([x, y], i) => { const a = i * 1.7; return [x + 8 * Math.cos(a) + (i % 3 - 1) * 3, y + 8 * Math.sin(a) + (i % 2) * 4]; });

await page.evaluate(({ SNAP, FINGER }) => {
  const stage = document.querySelector('#stage');
  const c = document.createElement('canvas');
  c.id = 'mock';
  const r = stage.getBoundingClientRect();
  c.width = r.width * 3; c.height = r.height * 3;
  Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 });
  stage.append(c);
  const ed = window.gesso.editor;
  // The output pixels for the loupe, 2048 wide.
  const o = ed.readOutput({ maxSide: 2048, tone: true });
  const img = document.createElement('canvas'); img.width = o.width; img.height = o.height;
  img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(o.data.buffer, o.data.byteOffset, o.data.length), o.width, o.height), 0, 0);
  const out = ed.outputSize();
  window.__mock = { c, img, sImg: o.width / out.width, SNAP, FINGER };

  window.__draw = ({ upTo = SNAP.length, finger = null, closed = false, tint = null, loupe = false, lighten = false, text = null }) => {
    const { c, img, sImg } = window.__mock;
    const ctx = c.getContext('2d');
    ctx.setTransform(3, 0, 0, 3, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const v = ed.view;
    const toDoc = (x, y) => [(x - v.x) / v.scale, (y - v.y) / v.scale];
    const pts = SNAP.slice(0, upTo);
    const path = (list, close) => { ctx.beginPath(); list.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (close) ctx.closePath(); };
    if (closed && tint) {
      path(SNAP, true);
      if (lighten) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = tint; ctx.fill(); ctx.restore(); }
      else { ctx.fillStyle = tint; ctx.fill(); }
    }
    // the finger's own path, faint
    if (!closed && finger) {
      ctx.save(); ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      path(FINGER.slice(0, upTo).concat([finger]), false); ctx.stroke(); ctx.restore();
    }
    // the snapped line: dark halo + accent
    const drawLine = () => {
      const list = finger && !closed ? pts.concat([finger]) : pts;
      path(list, closed);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = closed ? '#ffd9c2' : '#ff7a2f'; ctx.stroke();
    };
    if (upTo > 0) drawLine();
    // anchors
    if (!closed) for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke(); }
    // fingertip marker
    if (finger && !closed) { ctx.beginPath(); ctx.arc(finger[0], finger[1], 14, 0, 7); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke(); }
    // 2x loupe above-left of the finger
    if (loupe && finger) {
      const D = 118, R = D / 2, cx = finger[0] - 64 < R + 6 ? finger[0] + 64 : finger[0] - 64, cy = finger[1] - 86;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 14; ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowBlur = 0;
      ctx.clip();
      // image at 2x around the finger
      const [dx, dy] = toDoc(finger[0], finger[1]);
      const span = R / v.scale / 2; // doc px shown across the radius
      ctx.drawImage(img, (dx - span) * sImg, (dy - span) * sImg, 2 * span * sImg, 2 * span * sImg, cx - R, cy - R, D, D);
      // the snapped line at 2x
      ctx.translate(cx, cy); ctx.scale(2, 2); ctx.translate(-finger[0], -finger[1]);
      ctx.lineWidth = 1.2; drawLine();
      ctx.restore();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
      // crosshair
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
    }
    if (text) {
      ctx.font = '600 13px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
      const w = ctx.measureText(text).width + 24;
      const x = 220, y = 520;
      ctx.fillStyle = 'rgba(22,20,19,0.92)'; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 14, w, 28, 14); ctx.fill();
      ctx.fillStyle = '#eee8df'; ctx.fillText(text, x, y + 5);
    }
  };
  // Panel: an Outline mode chip in the dial row (Size · Outline · Source).
  window.__panel = ({ on = true, hint, title }) => {
    const dials = document.querySelector('#dials');
    let b = dials.querySelector('[data-dial="outline"]');
    if (!b) {
      b = document.createElement('button'); b.type = 'button'; b.dataset.dial = 'outline'; b.className = 'dial dial--mode';
      b.innerHTML = '<span class="dial__name">Outline</span><span class="dial__value"></span>';
      dials.insertBefore(b, dials.children[1] ?? null);
    }
    b.classList.toggle('is-selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.querySelector('.dial__value').textContent = on ? 'On' : 'Off';
    if (hint !== undefined) document.querySelector('#hint').textContent = hint;
    if (title !== undefined) document.querySelector('#tool-name').textContent = title;
  };
}, { SNAP, FINGER });

const shot = (n) => page.screenshot({ path: `mock-${n}.png` });

// A: Outline just switched on
await page.evaluate(() => { window.__panel({ on: true, hint: 'Loop around it. The line snaps to edges.' }); window.__draw({ upTo: 0 }); });
await shot('1-outline-on');

// B: mid-drag with the loupe
const upTo = 9;
const f = FINGER[upTo];
await page.evaluate(({ upTo, f }) => { window.__draw({ upTo, finger: f, loupe: true }); }, { upTo, f });
await shot('2-dragging');

// C: loop closed, filling
await page.evaluate(() => { window.__panel({ on: true, hint: 'Filling inside the outline…' }); window.__draw({ closed: true, tint: 'rgba(255,122,47,0.28)', upTo: 99 }); document.querySelector('#status').textContent = 'Filling…'; });
await shot('3-closed-filling');

// D: the real fill engine (lib/inpaint.js) run on the polygon mask, at the 2048-px readback.
await page.evaluate(() => { window.__draw({ upTo: 0 }); document.querySelector('#status').textContent = ''; });
const fillMs = await page.evaluate(async ({ SNAP }) => {
  const { inpaintScaled, planRemoval } = await import('http://127.0.0.1:4174/gesso/lib/inpaint.js');
  const { c, img, sImg } = window.__mock; const ed = window.gesso.editor; const v = ed.view;
  const toImg = ([x, y]) => [(x - v.x) / v.scale * sImg, (y - v.y) / v.scale * sImg];
  const poly = SNAP.map(toImg);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const b = { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)) };
  b.width = Math.ceil(Math.max(...xs)) - b.x; b.height = Math.ceil(Math.max(...ys)) - b.y;
  const win = planRemoval(b, img.width, img.height);
  const ictx = img.getContext('2d');
  const image = ictx.getImageData(win.x, win.y, win.width, win.height);
  const m = document.createElement('canvas'); m.width = win.width; m.height = win.height;
  const mctx = m.getContext('2d');
  mctx.beginPath(); poly.forEach(([x, y], i) => i ? mctx.lineTo(x - win.x, y - win.y) : mctx.moveTo(x - win.x, y - win.y)); mctx.closePath();
  mctx.fillStyle = '#fff'; mctx.fill(); mctx.lineWidth = 4; mctx.strokeStyle = '#fff'; mctx.stroke(); // ~2 px dilation, like DILATE_PX
  const md = mctx.getImageData(0, 0, win.width, win.height).data;
  const mask = new Uint8Array(win.width * win.height);
  for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4] > 127 ? 1 : 0;
  const t0 = performance.now();
  const filled = inpaintScaled({ width: win.width, height: win.height, data: image.data }, mask, win.scale);
  const ms = performance.now() - t0;
  ictx.putImageData(new ImageData(filled.data, win.width, win.height), win.x, win.y);
  // paint the filled window over the photo at the view transform
  const ctx = c.getContext('2d'); ctx.setTransform(3, 0, 0, 3, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
  const s = v.scale / sImg;
  ctx.drawImage(img, win.x, win.y, win.width, win.height, v.x + win.x * s, v.y + win.y * s, win.width * s, win.height * s);
  return { ms: Math.round(ms), win };
}, { SNAP });
console.log('outline fill', JSON.stringify(fillMs));
await page.evaluate(() => { window.__panel({ on: true, hint: 'Removed. Try another gives a different fill.' }); document.querySelector('#hint').classList.add('is-tip'); const t = document.querySelector('#quick [data-quick="try"]') ?? document.querySelector('#quick [data-quick^="try"]'); if (t) t.disabled = false; document.querySelector('#status').textContent = 'Edited'; });
await shot('4-filled');

// E: Light with an outline around the coffee surface, brightened inside
await page.evaluate(() => { const { c } = window.__mock; c.getContext('2d').clearRect(0, 0, c.width, c.height); });
await page.click('[data-tool="light"]');
await page.waitForTimeout(600);
const COFFEE = (() => { const pts = []; for (let th = 0; th < 360; th += 18) pts.push([+(225 + 70 * Math.cos(th * Math.PI / 180)).toFixed(1), +(248 + 32 * Math.sin(th * Math.PI / 180)).toFixed(1)]); return pts; })();
await page.evaluate(({ COFFEE }) => {
  window.__mock.SNAP = COFFEE; window.__mock.FINGER = COFFEE;
  // redefine on the new SNAP: cheap trick, __draw closes over the originals, so patch them
}, { COFFEE });
await page.evaluate(({ COFFEE }) => {
  const { c, img } = window.__mock; const ed = window.gesso.editor; const v = ed.view; const out = ed.outputSize();
  const ctx = c.getContext('2d'); ctx.setTransform(3, 0, 0, 3, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
  const path = () => { ctx.beginPath(); COFFEE.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); };
  ctx.save(); path(); ctx.clip(); ctx.filter = 'brightness(1.32) saturate(1.06)';
  ctx.drawImage(img, 0, 0, img.width, img.height, v.x, v.y, out.width * v.scale, out.height * v.scale);
  ctx.restore();
  path(); ctx.lineJoin = 'round'; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke(); ctx.lineWidth = 2; ctx.strokeStyle = '#ffd9c2'; ctx.stroke();
  window.__panel({ on: true, hint: 'Changes now apply inside the outline.' });
  const b = document.querySelector('#quick [data-quick="brighter"]'); if (b) { b.setAttribute('aria-pressed', 'true'); b.classList.add('is-selected'); }
  const bright = document.querySelector('#dials [data-dial="brightness"] .dial__value'); if (bright) bright.textContent = '+28';
}, { COFFEE });
await shot('5-light-inside');
console.log('probe', await page.evaluate(() => { const { c } = window.__mock; const a = c.getContext('2d').getImageData(291 * 3, 333 * 3, 1, 1).data; const ov = document.querySelector('#overlay'); const o = ov.getContext('2d').getImageData(291 * 3, 333 * 3, 1, 1).data; return { mock: [...a], overlay: [...o], overlayVis: getComputedStyle(ov).visibility, tool: document.querySelector('#app').dataset.tool }; }));
console.log(await page.evaluate(() => [...document.querySelectorAll('#quick button')].map((b) => b.dataset.quick)));
await browser.close();
