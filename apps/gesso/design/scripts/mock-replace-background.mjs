import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SP = '/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const cdp = await ctx.newCDPSession(page);
const tp = ([x, y]) => ({ x, y, radiusX: 4, radiusY: 4, force: 0.6, id: 1 });
async function stroke(points) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(points[0])] });
  for (let i = 1; i < points.length; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(points[i])] }); await page.waitForTimeout(30); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
await page.goto('http://127.0.0.1:4174/gesso/');
await page.setInputFiles('#file', `${SP}/fixtures/coffee-12mp.jpg`);
await page.waitForSelector('#app[data-state="editing"]', { timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('#quick [data-quick="auto"]');
await page.waitForTimeout(1500);
await page.click('[data-tool="remove"]');
await page.waitForTimeout(600);
const RUB = [[292, 360], [288, 376], [283, 392], [272, 402], [258, 408], [252, 420], [260, 432], [274, 434], [284, 422], [280, 408], [266, 406], [258, 416], [266, 426], [276, 420], [270, 412], [264, 414]];
await stroke(RUB);
await page.waitForFunction(() => /Removed/.test(window.gesso.editor.history.entries.at(-1)?.label ?? ''), null, { timeout: 90000 });
await page.waitForTimeout(800);

await page.evaluate(() => {
  const stage = document.querySelector('#stage');
  const c = document.createElement('canvas'); c.id = 'mock';
  const r = stage.getBoundingClientRect(); c.width = r.width * 3; c.height = r.height * 3;
  Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 });
  stage.append(c);
  // Panel: Outline chip on, quick row = what to do with the loop, slot = backdrops.
  window.__panel = ({ backdrop, hint }) => {
    const dials = document.querySelector('#dials');
    let b = dials.querySelector('[data-dial="outline"]');
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.dataset.dial = 'outline'; b.className = 'dial dial--mode is-selected'; b.setAttribute('aria-pressed', 'true'); b.innerHTML = '<span class="dial__name">Outline</span><span class="dial__value">On</span>'; dials.insertBefore(b, dials.children[1] ?? null); }
    const quick = document.querySelector('#quick'); quick.textContent = '';
    for (const [id, label, sel] of [['inside', 'Remove inside', false], ['bg', 'Replace background', true]]) {
      const q = document.createElement('button'); q.type = 'button'; q.className = 'chip'; q.dataset.quick = id; q.setAttribute('aria-pressed', sel ? 'true' : 'false'); q.innerHTML = '<span></span>'; q.querySelector('span').textContent = label; quick.append(q);
    }
    const slot = document.querySelector('#slot'); slot.textContent = '';
    const wrap = document.createElement('div'); wrap.className = 'segment'; wrap.setAttribute('role', 'radiogroup');
    for (const [id, label] of [['studio', 'Studio'], ['charcoal', 'Charcoal'], ['blur', 'Blur'], ['photo', 'Photo…']]) {
      const s = document.createElement('button'); s.type = 'button'; s.dataset.segment = id; s.setAttribute('role', 'radio'); s.setAttribute('aria-pressed', id === backdrop ? 'true' : 'false'); s.setAttribute('aria-checked', id === backdrop ? 'true' : 'false'); s.textContent = label; wrap.append(s);
    }
    slot.append(wrap);
    document.querySelector('#hint').textContent = hint;
  };
  window.__draw = ({ backdrop }) => {
    const ed = window.gesso.editor; const v = ed.view; const out = ed.outputSize();
    const o = ed.readOutput({ maxSide: 2048, tone: true });
    const img = document.createElement('canvas'); img.width = o.width; img.height = o.height;
    img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(o.data.buffer, o.data.byteOffset, o.data.length), o.width, o.height), 0, 0);
    const ctx = c.getContext('2d'); ctx.setTransform(3, 0, 0, 3, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    const px = v.x, py = v.y, pw = out.width * v.scale, ph = out.height * v.scale;
    // the subject: saucer ellipse + cup rim ellipse + cup body
    // every subpath wound the same way (clockwise on screen), so nonzero = the union
    const subjectOn = (g) => {
      g.beginPath();
      g.ellipse(204.7, 304.7, 140, 105, 0, 0, Math.PI * 2);
      g.moveTo(305.7, 218.7); g.ellipse(218.3, 218.7, 87.4, 62, 0, 0, Math.PI * 2);
      g.moveTo(301, 262); g.lineTo(287, 340); g.lineTo(270, 357); g.lineTo(165, 355); g.lineTo(148, 338); g.lineTo(138.5, 262); g.closePath();
    };
    const subject = () => subjectOn(ctx);
    // the new backdrop over the photo
    ctx.save(); ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
    if (backdrop === 'studio') {
      const g = ctx.createRadialGradient(px + pw * 0.5, py + ph * 0.25, 10, px + pw * 0.5, py + ph * 0.6, pw * 0.8);
      g.addColorStop(0, '#fbfaf7'); g.addColorStop(0.6, '#ebe8e2'); g.addColorStop(1, '#cfcbc3');
      ctx.fillStyle = g; ctx.fillRect(px, py, pw, ph);
      // contact shadow under the saucer
      const sh = ctx.createRadialGradient(204.7, 318, 20, 204.7, 318, 165);
      sh.addColorStop(0, 'rgba(60,45,30,0.55)'); sh.addColorStop(0.55, 'rgba(60,45,30,0.22)'); sh.addColorStop(1, 'rgba(60,45,30,0)');
      ctx.save(); ctx.translate(0, 318); ctx.scale(1, 0.62); ctx.translate(0, -318); ctx.fillStyle = sh; ctx.fillRect(px, py, pw, ph); ctx.restore();
    } else if (backdrop === 'charcoal') {
      const g = ctx.createRadialGradient(px + pw * 0.45, py + ph * 0.3, 10, px + pw * 0.5, py + ph * 0.5, pw * 0.75);
      g.addColorStop(0, '#3a3634'); g.addColorStop(0.55, '#1b1918'); g.addColorStop(1, '#0a0909');
      ctx.fillStyle = g; ctx.fillRect(px, py, pw, ph);
      const sh = ctx.createRadialGradient(204.7, 322, 20, 204.7, 322, 170);
      sh.addColorStop(0, 'rgba(0,0,0,0.7)'); sh.addColorStop(0.6, 'rgba(0,0,0,0.3)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save(); ctx.translate(0, 322); ctx.scale(1, 0.6); ctx.translate(0, -322); ctx.fillStyle = sh; ctx.fillRect(px, py, pw, ph); ctx.restore();
      // a little warm spill on the floor in front
      const sp = ctx.createRadialGradient(204.7, 380, 5, 204.7, 380, 120);
      sp.addColorStop(0, 'rgba(255,140,70,0.16)'); sp.addColorStop(1, 'rgba(255,140,70,0)');
      ctx.fillStyle = sp; ctx.fillRect(px, py, pw, ph);
    }
    ctx.restore();
    // the subject, cut along the outline, with a 1 px soft edge
    ctx.save(); subject(); ctx.clip();
    ctx.drawImage(img, 0, 0, img.width, img.height, px, py, pw, ph);
    ctx.restore();
    // the outline itself along the union's outer edge only: stroke it on a scratch
    // canvas, then knock out everything inside the union
    const off = document.createElement('canvas'); off.width = c.width; off.height = c.height;
    const g = off.getContext('2d'); g.setTransform(3, 0, 0, 3, 0, 0);
    subjectOn(g); g.setLineDash([4, 3]); g.lineWidth = 3; g.strokeStyle = backdrop === 'studio' ? 'rgba(255,122,47,0.95)' : 'rgba(255,217,194,0.95)'; g.stroke();
    g.globalCompositeOperation = 'destination-out'; subjectOn(g); g.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.setTransform(3, 0, 0, 3, 0, 0);
  };
});
await page.evaluate(() => { window.__panel({ backdrop: 'studio', hint: 'Outside the outline is replaced. Tap a backdrop.' }); window.__draw({ backdrop: 'studio' }); });
await page.screenshot({ path: '07-background-studio.png' });
await page.evaluate(() => { window.__panel({ backdrop: 'charcoal', hint: 'Outside the outline is replaced. Tap a backdrop.' }); window.__draw({ backdrop: 'charcoal' }); });
await page.screenshot({ path: '08-background-charcoal.png' });
await browser.close();
