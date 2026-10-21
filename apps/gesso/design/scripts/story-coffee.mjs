import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SP = '/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const cdp = await ctx.newCDPSession(page);
const STAGE_TOP = 68;
const tp = ([x, y]) => ({ x, y, radiusX: 4, radiusY: 4, force: 0.6, id: 1 });
async function stroke(points, { pauseAt = -1, shot = null, step = 30 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(points[0])] });
  for (let i = 1; i < points.length; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(points[i])] });
    await page.waitForTimeout(step);
    if (i === pauseAt && shot) { await page.waitForTimeout(150); await page.screenshot({ path: shot }); }
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const labels = () => page.evaluate(() => window.gesso.editor.history.entries.map((e) => e.label));

await page.goto('http://127.0.0.1:4174/gesso/');
await page.setInputFiles('#file', `${SP}/fixtures/coffee-12mp.jpg`);
await page.waitForSelector('#app[data-state="editing"]', { timeout: 60000 });
await page.waitForTimeout(1500);

// ---- mock helpers: Outline chip + corner magnifier, drawn over the real app
const SNAP = (() => { const cx = 264, cy = 344, r = 27, pts = [[288, 333]]; for (let th = -5; th <= 280; th += 19) pts.push([+(cx + r * Math.cos(th * Math.PI / 180)).toFixed(1), +(cy + r * Math.sin(th * Math.PI / 180)).toFixed(1)]); pts.push([288, 288], [294, 287], [299, 294]); return pts; })();
const FINGER = SNAP.map(([x, y], i) => { const a = i * 1.7; return [x + 8 * Math.cos(a) + (i % 3 - 1) * 3, y + 8 * Math.sin(a) + (i % 2) * 4]; });
const COFFEE = (() => { const pts = []; for (let th = 0; th < 360; th += 15) pts.push([+(225 + 70 * Math.cos(th * Math.PI / 180)).toFixed(1), +(248 + 32 * Math.sin(th * Math.PI / 180)).toFixed(1)]); return pts; })();
const COFFEEF = COFFEE.map(([x, y], i) => [x + 6 * Math.cos(i * 1.9), y + 5 * Math.sin(i * 1.3)]);
await page.evaluate(() => {
  const stage = document.querySelector('#stage');
  const c = document.createElement('canvas'); c.id = 'mock';
  const r = stage.getBoundingClientRect(); c.width = r.width * 3; c.height = r.height * 3;
  Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 });
  stage.append(c);
  window.__clear = () => { c.getContext('2d').clearRect(0, 0, c.width, c.height); };
  window.__panel = ({ on, hint }) => {
    const dials = document.querySelector('#dials');
    let b = dials.querySelector('[data-dial="outline"]');
    if (on === null) { b?.remove(); return; }
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.dataset.dial = 'outline'; b.className = 'dial dial--mode'; b.innerHTML = '<span class="dial__name">Outline</span><span class="dial__value"></span>'; dials.insertBefore(b, dials.children[1] ?? null); }
    b.classList.toggle('is-selected', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.querySelector('.dial__value').textContent = on ? 'On' : 'Off';
    if (hint !== undefined) document.querySelector('#hint').textContent = hint;
  };
  window.__draw = ({ snap, fingerPath, upTo, closed = false, magnifier = true, snapRadius = 20, mag = 3, size = 140 }) => {
    const ed = window.gesso.editor;
    const o = ed.readOutput({ maxSide: 2048, tone: true });
    const img = document.createElement('canvas'); img.width = o.width; img.height = o.height;
    img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(o.data.buffer, o.data.byteOffset, o.data.length), o.width, o.height), 0, 0);
    const sImg = o.width / ed.outputSize().width;
    const ctx = c.getContext('2d'); ctx.setTransform(3, 0, 0, 3, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    const v = ed.view; const W = r.width;
    const pts = closed ? snap : snap.slice(0, upTo); const finger = closed ? null : fingerPath[upTo];
    const path = (list, close) => { ctx.beginPath(); list.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (close) ctx.closePath(); };
    const drawAll = (lw) => {
      if (!closed) { ctx.save(); ctx.setLineDash([3, 4]); ctx.lineWidth = lw * 0.5; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; path(fingerPath.slice(0, upTo).concat([finger]), false); ctx.stroke(); ctx.restore(); }
      path(closed ? pts : pts.concat([finger]), closed); ctx.lineJoin = ctx.lineCap = 'round';
      ctx.lineWidth = lw * 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke(); ctx.lineWidth = lw; ctx.strokeStyle = closed ? '#ffd9c2' : '#ff7a2f'; ctx.stroke();
      if (!closed) for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, lw * 1.3, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = lw * 0.5; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke(); }
    };
    drawAll(2);
    if (closed || !magnifier) return;
    ctx.beginPath(); ctx.arc(finger[0], finger[1], 14, 0, 7); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke();
    const m = 12, S = size; const nearLeft = finger[0] < S + m + 40 && finger[1] < S + m + 40;
    const wx = nearLeft ? W - S - m : m, wy = 10;
    ctx.save(); ctx.beginPath(); ctx.roundRect(wx, wy, S, S, 18); ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4; ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.clip();
    const cx = wx + S / 2, cy = wy + S / 2; const [dx, dy] = [(finger[0] - v.x) / v.scale, (finger[1] - v.y) / v.scale]; const span = S / 2 / v.scale / mag;
    ctx.drawImage(img, (dx - span) * sImg, (dy - span) * sImg, 2 * span * sImg, 2 * span * sImg, wx, wy, S, S);
    ctx.translate(cx, cy); ctx.scale(mag, mag); ctx.translate(-finger[0], -finger[1]); drawAll(1.1);
    ctx.beginPath(); ctx.arc(finger[0], finger[1], snapRadius, 0, 7); ctx.setLineDash([2, 3]); ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    ctx.beginPath(); ctx.roundRect(wx, wy, S, S, 18); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9); ctx.stroke();
    ctx.font = '600 11px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillText(`${mag}×`, wx + S - 9, wy + S - 8);
  };
});

// 1. Auto-enhance (real)
await page.click('#quick [data-quick="auto"]');
await page.waitForTimeout(1800);
await page.screenshot({ path: '01-auto-enhance.png' });

// 2. Remove › Outline: tracing the spoon with the corner magnifier (mock over the real panel)
await page.click('[data-tool="remove"]');
await page.waitForTimeout(700);
await page.evaluate(({ SNAP, FINGER }) => { window.__panel({ on: true, hint: 'Loop around it. The line snaps to edges.' }); window.__draw({ snap: SNAP, fingerPath: FINGER, upTo: 9 }); }, { SNAP, FINGER });
await page.screenshot({ path: '02-remove-outline-trace.png' });

// 3. The real fill: a careful Medium rub over the spoon (what Outline will hand to the same engine)
await page.evaluate(() => window.__clear());
const RUB = [[292, 360], [288, 376], [283, 392], [272, 402], [258, 408], [252, 420], [260, 432], [274, 434], [284, 422], [280, 408], [266, 406], [258, 416], [266, 426], [276, 420], [270, 412], [264, 414]];
await stroke(RUB);
await page.waitForFunction(() => /Removed/.test(window.gesso.editor.history.entries.at(-1)?.label ?? ''), null, { timeout: 90000 });
await page.waitForTimeout(800);
console.log('after rub', await labels());
await page.evaluate(() => { window.__panel({ on: true, hint: 'Removed. Try another gives a different fill.' }); document.querySelector('#hint').classList.add('is-tip'); });
await page.screenshot({ path: '03-removed.png' });
await page.evaluate(() => window.__panel({ on: null }));
await page.click('#done');
await page.waitForTimeout(500);

// 4. Light › Paint › Darken on the wood around the saucer (real), caught mid-stroke
await page.click('[data-tool="light"]');
await page.waitForTimeout(600);
await page.click('#dials [data-dial="paint"]');
await page.waitForTimeout(300);
await page.click('#slot [data-segment="darken"]');
await page.waitForTimeout(300);
const Y0 = STAGE_TOP;
const TOP = []; for (let x = 24; x <= 416; x += 16) TOP.push([x, Y0 + 158 + (x % 32 ? 0 : 6)]);
await stroke(TOP, { pauseAt: 14, shot: '04-light-paint-darken.png' });
await page.waitForTimeout(600);
const LEFT = []; for (let y = 160; y <= 400; y += 16) LEFT.push([28, Y0 + y]);
await stroke(LEFT);
await page.waitForTimeout(600);
const RIGHT = []; for (let y = 160; y <= 400; y += 16) RIGHT.push([412, Y0 + y]);
await stroke(RIGHT);
await page.waitForTimeout(600);
const TR = [[330, Y0 + 170], [360, Y0 + 185], [390, Y0 + 205], [400, Y0 + 240], [380, Y0 + 260]];
await stroke(TR);
await page.waitForTimeout(800);
console.log('after paint', await labels());

// 5. Light › Outline on the coffee surface: trace (mock), then Brighten inside (real paint dabs) with the outline shown
await page.evaluate(({ COFFEE, COFFEEF }) => { window.__panel({ on: true, hint: 'Loop around it. The line snaps to edges.' }); window.__draw({ snap: COFFEE, fingerPath: COFFEEF, upTo: 13 }); }, { COFFEE, COFFEEF });
await page.screenshot({ path: '05-light-outline-trace.png' });
await page.evaluate(() => window.__clear());
await page.click('#slot [data-segment="brighten"]');
await page.waitForTimeout(300);
const DABS = []; for (let th = 0; th < 360; th += 30) DABS.push([225 + 38 * Math.cos(th * Math.PI / 180), Y0 + 248 + 14 * Math.sin(th * Math.PI / 180)]); DABS.push([225, Y0 + 248], [205, Y0 + 246], [245, Y0 + 250]);
await stroke(DABS);
await page.waitForTimeout(900);
await page.evaluate(({ COFFEE, COFFEEF }) => { window.__panel({ on: true, hint: 'Changes now apply inside the outline.' }); window.__draw({ snap: COFFEE, fingerPath: COFFEEF, closed: true }); }, { COFFEE, COFFEEF });
await page.screenshot({ path: '06-light-outline-brighten.png' });
await page.evaluate(() => { window.__clear(); window.__panel({ on: null }); });
await page.click('#done');
await page.waitForTimeout(500);

// 6. Color › Film (real)
await page.click('[data-tool="color"]');
await page.waitForTimeout(1500);
await page.click('#quick [data-quick="look:film"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: '07-color-film.png' });
await page.click('#done');
await page.waitForTimeout(500);

// 7. Crop › 4:5 and straighten on the ruler (real)
await page.click('[data-tool="crop"]');
await page.waitForTimeout(600);
await page.click('#quick [data-quick="4:5"]');
await page.waitForTimeout(600);
const ruler = await page.locator('#slot .ruler').boundingBox();
await page.mouse.move(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(ruler.x + ruler.width / 2 - i * 8, ruler.y + ruler.height / 2); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(700);
console.log('crop', await page.evaluate(() => ({ angle: window.gesso.editor.doc.crop.angle, dial: document.querySelector('#dials [data-dial="straighten"] .dial__value')?.textContent })));
await page.screenshot({ path: '08-crop.png' });
await page.click('#done');
await page.waitForTimeout(600);

// 8. Text caption (real)
await page.click('[data-tool="text"]');
await page.waitForTimeout(700);
await page.fill('#caption-input', 'ristretto, 7:04 am');
await page.waitForTimeout(200);
await page.click('#caption-done');
await page.waitForTimeout(500);
await page.click('#quick [data-quick="style:serif"]').catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: '09-text.png' });
await page.click('#done');
await page.waitForTimeout(600);

// 9. Before / After wipe at Home (real)
await page.evaluate(() => window.gesso.editor.setCompare('wipe', 215));
await page.waitForTimeout(400);
await page.screenshot({ path: '10-before-after-wipe.png' });
await page.evaluate(() => window.gesso.editor.setCompare('off'));
console.log('final', await labels());
await browser.close();
