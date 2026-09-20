// Render the gift-card share image from the existing transparent bouquet.
// Run: node tools/render-social-card.mjs
// Also supports tools/bouquet/render-social-card.mjs in the multi-site project.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(root, 'package.json'))) {
  const parent = dirname(root)
  if (parent === root) throw new Error('Could not find the project package.json.')
  root = parent
}

const publicRoot = join(root, 'public')
const assets = existsSync(join(publicRoot, 'omaris-poster.png'))
  ? publicRoot
  : join(publicRoot, 'Omaris')
const poster = join(assets, 'omaris-poster.png')
if (!existsSync(poster)) throw new Error(`Bouquet poster not found: ${poster}`)
const output = join(assets, 'social-card.png')
const imageURL = `data:image/png;base64,${readFileSync(poster).toString('base64')}`
const executablePath = [
  process.env.CHROME_PATH,
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].find((candidate) => candidate && existsSync(candidate))

const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  await page.setContent(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>To: Omaris, From: Mike :)</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
    body { background: #f9eff0; color: #523a43; }
    .card { position: relative; width: 100%; height: 100%; }
    .card::before {
      content: ''; position: absolute; inset: 30px;
      border: 1px solid #dfcdd1;
    }
    .message {
      position: absolute; left: 91px; top: 242px; z-index: 1;
      margin: 0; font: 400 46px/1.48 Georgia, 'Times New Roman', serif;
      letter-spacing: -0.025em;
    }
    .message::before {
      content: ''; position: absolute; left: 2px; top: -30px;
      width: 57px; height: 1px; background: #b59098;
    }
    .message span { display: block; white-space: nowrap; }
    .bouquet {
      position: absolute; width: 900px; height: 900px;
      left: 392px; top: -139px; object-fit: contain;
    }
  </style>
</head>
<body>
  <main class="card">
    <p class="message"><span>To: Omaris,</span><span>From: Mike :)</span></p>
    <img class="bouquet" src="${imageURL}" alt="Pink flowers in Omaris's vase">
  </main>
</body>
</html>`, { waitUntil: 'load' })
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((image) => image.decode()))
  })
  await page.screenshot({ path: output, type: 'png' })
  console.log(`Rendered 1200 × 630 gift card: ${output}`)
} finally {
  await browser.close()
}
