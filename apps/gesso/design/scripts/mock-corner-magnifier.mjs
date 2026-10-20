import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SP = '/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4174/gesso/');
await page.setInputFiles('#file', `${SP}/fixtures/coffee-12mp.jpg`);
await page.waitForSelector('#app[data-state="editing"]', { timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-tool="remove"]');
await page.waitForTimeout(800);
const SNAP = (() => { const cx = 264, cy = 344, r = 27, pts = [[288, 333]]; for (let th = -5; th <= 280; th += 19) pts.push([+(cx + r * Math.cos(th * Math.PI / 180)).toFixed(1), +(cy + r * Math.sin(th * Math.PI / 180)).toFixed(1)]); pts.push([288, 288], [294, 287], [299, 294]); return pts; })();
const FINGER = SNAP.map(([x, y], i) => { const a = i * 1.7; return [x + 8 * Math.cos(a) + (i % 3 - 1) * 3, y + 8 * Math.sin(a) + (i % 2) * 4]; });
// A second trace: the cup's left rim, so the finger is near the top-left and the window flips.
const RIM = (() => { const pts = []; for (let th = 175; th <= 265; th += 9) pts.push([+(206 + 72 * Math.cos(th * Math.PI / 180)).toFixed(1), +(224 + 72 * Math.sin(th * Math.PI / 180) * 0.78).toFixed(1)]); return pts; })();
const RIMF = RIM.map(([x, y], i) => [x - 7 + (i % 3) * 3, y + 6 * Math.sin(i * 1.3)]);

await page.evaluate(({ SNAP, FINGER, RIM, RIMF }) => {
  const stage = document.querySelector('#stage');
  const c = document.createElement('canvas'); c.id = 'mock';
  const r = stage.getBoundingClientRect(); c.width = r.width * 3; c.height = r.height * 3;
  Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 });
  stage.append(c);
  const ed = window.gesso.editor;
  const o = ed.readOutput({ maxSide: 2048, tone: true });
  const img = document.createElement('canvas'); img.width = o.width; img.height = o.height;
  img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(o.data.buffer, o.data.byteOffset, o.data.length), o.width, o.height), 0, 0);
  const out = ed.outputSize(); const sImg = o.width / out.width;
  const dials = document.querySelector('#dials');
  const b = document.createElement('button'); b.type = 'button'; b.className = 'dial dial--mode is-selected'; b.setAttribute('aria-pressed', 'true');
  b.innerHTML = '<span class="dial__name">Outline</span><span class="dial__value">On</span>'; dials.insertBefore(b, dials.children[1]);
  document.querySelector('#hint').textContent = 'Loop around it. The line snaps to edges.';

  window.__draw = ({ snap, fingerPath, upTo, snapRadius = 20, mag = 3, size = 140 }) => {
    const ctx = c.getContext('2d'); ctx.setTransform(3, 0, 0, 3, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    const v = ed.view; const W = r.width;
    const pts = snap.slice(0, upTo); const finger = fingerPath[upTo];
    const path = (list, close) => { ctx.beginPath(); list.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (close) ctx.closePath(); };
    const drawAll = (lw) => {
      ctx.save(); ctx.setLineDash([3, 4]); ctx.lineWidth = lw * 0.5; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; path(fingerPath.slice(0, upTo).concat([finger]), false); ctx.stroke(); ctx.restore();
      path(pts.concat([finger]), false); ctx.lineJoin = ctx.lineCap = 'round';
      ctx.lineWidth = lw * 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke(); ctx.lineWidth = lw; ctx.strokeStyle = '#ff7a2f'; ctx.stroke();
      for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, lw * 1.3, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = lw * 0.5; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke(); }
    };
    drawAll(2);
    // fingertip
    ctx.beginPath(); ctx.arc(finger[0], finger[1], 14, 0, 7); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke();
    // corner window: top-left unless the finger is near it, then top-right
    const m = 12, S = size;
    const nearLeft = finger[0] < S + m + 40 && finger[1] < S + m + 40;
    const wx = nearLeft ? W - S - m : m, wy = 10;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(wx, wy, S, S, 18); ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4; ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.clip();
    const cx = wx + S / 2, cy = wy + S / 2;
    const [dx, dy] = [(finger[0] - v.x) / v.scale, (finger[1] - v.y) / v.scale];
    const span = S / 2 / v.scale / mag;
    ctx.drawImage(img, (dx - span) * sImg, (dy - span) * sImg, 2 * span * sImg, 2 * span * sImg, wx, wy, S, S);
    ctx.translate(cx, cy); ctx.scale(mag, mag); ctx.translate(-finger[0], -finger[1]);
    drawAll(1.1);
    // the magnet's reach
    ctx.beginPath(); ctx.arc(finger[0], finger[1], snapRadius, 0, 7); ctx.setLineDash([2, 3]); ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    ctx.beginPath(); ctx.roundRect(wx, wy, S, S, 18); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9); ctx.stroke();
    ctx.font = '600 11px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`${mag}×`, wx + S - 9, wy + S - 8);
  };
  window.__sets = { SNAP, FINGER, RIM, RIMF };
}, { SNAP, FINGER, RIM, RIMF });

await page.evaluate(() => { const { SNAP, FINGER } = window.__sets; window.__draw({ snap: SNAP, fingerPath: FINGER, upTo: 9 }); });
await page.screenshot({ path: 'corner-1.png' });
await page.evaluate(() => { const { RIM, RIMF } = window.__sets; window.__draw({ snap: RIM, fingerPath: RIMF, upTo: 7 }); });
await page.screenshot({ path: 'corner-2.png' });
await browser.close();
