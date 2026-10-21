// Usage: node render.mjs <in.svg> <out.png> [size=512] [--mask]
// --mask clips to the iOS home-screen squircle so you see it as the phone will.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const [, , input, output, sizeArg = '512', flag] = process.argv;
const size = Number(sizeArg);
const svg = readFileSync(input, 'utf8');
const radius = flag === '--mask' ? `${size * 0.2237}px` : '0';
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: size, height: size });
await page.setContent(`<style>html,body{margin:0;background:transparent}#w{width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden}svg{display:block;width:100%;height:100%}</style><div id=w>${svg}</div>`);
await page.locator('#w').screenshot({ path: output, omitBackground: true });
await browser.close();
