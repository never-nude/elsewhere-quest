// Usage: node sheet.mjs <icons.json> <out.png>
// icons.json: [{title, svg, direction, rationale}]. Renders a contact sheet: large masked tiles
// plus a mock iPhone home-screen at true 60pt size on dark and light wallpapers.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const [, , listPath, out] = process.argv;
const icons = JSON.parse(readFileSync(listPath, 'utf8'));
// Inlined SVGs share one ID namespace, so prefix every id (and its references) per instance.
let uid = 0;
const svgOf = (p) => {
  const pre = `u${uid++}-`;
  return readFileSync(p, 'utf8')
    .replace(/<\?xml[^>]*>/, '')
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${pre}${id}"`)
    .replace(/url\(\s*#([^)\s]+)\s*\)/g, (_, id) => `url(#${pre}${id})`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, a, id) => `${a}="#${pre}${id}"`);
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const tile = (ic, i) => `<figure><div class="big">${svgOf(ic.svg)}</div>
  <figcaption><b>${i + 1}. ${esc(ic.title)}</b><span>${esc(ic.direction)}</span></figcaption></figure>`;
const homeIcon = (ic, i) => `<div class="app"><div class="sm">${svgOf(ic.svg)}</div><span>${i + 1}. ${esc(ic.title.split(' ')[0])}</span></div>`;
const html = `<!doctype html><meta charset=utf-8><style>
  body{margin:0;background:#141311;color:#eee8df;font:15px -apple-system,system-ui,Helvetica,sans-serif;padding:28px;width:1100px}
  h1{font-weight:650;font-size:26px;margin:0 0 4px} p.sub{margin:0 0 22px;color:#a39d93}
  .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:22px 18px}
  figure{margin:0} .big{width:180px;height:180px;border-radius:40px;overflow:hidden;box-shadow:0 6px 24px #0008}
  .big svg,.sm svg{display:block;width:100%;height:100%}
  figcaption{margin-top:8px;display:flex;flex-direction:column;gap:2px} figcaption span{color:#8d877d;font-size:13px}
  .homes{display:flex;gap:22px;margin-top:30px}
  .home{flex:1;border-radius:28px;padding:22px 16px;display:grid;grid-template-columns:repeat(5,1fr);gap:18px 6px}
  .home.dark{background:radial-gradient(120% 90% at 20% 0%,#3a3f55,#0d0f17)} .home.light{background:radial-gradient(120% 90% at 80% 0%,#f4d9b8,#9db7d6)}
  .app{display:flex;flex-direction:column;align-items:center;gap:5px}
  .sm{width:60px;height:60px;border-radius:13.4px;overflow:hidden;box-shadow:0 1px 4px #0005}
  .app span{font-size:11px;color:#fff;text-shadow:0 1px 2px #0009;white-space:nowrap}
  .label{font-size:13px;color:#a39d93;margin:26px 0 -18px}
</style><h1>Gesso — icon directions</h1><p class="sub">Large tiles at 180px; below, every icon at true home-screen size (60pt) on dark and light wallpapers.</p>
<div class="grid">${icons.map(tile).join('')}</div>
<div class="label">Home screen, actual size</div>
<div class="homes"><div class="home dark">${icons.map(homeIcon).join('')}</div><div class="home light">${icons.map(homeIcon).join('')}</div></div>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setViewportSize({ width: 1156, height: 800 });
await page.setContent(html);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
