// Bakes the static AR files (GLB for Android Scene Viewer, USDZ for iOS
// Quick Look) by loading the built page in headless Chromium and asking it
// to export the procedural bouquet. Also saves a screenshot for eyeballing.
//
//   npm run build && node tools/export-assets.mjs [Name]
//
// Writes public/<name>.usdz, public/<name>.glb and
// tools/preview-<name>.png (the PNG is git-ignored).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const NAME = process.argv[2] ?? 'Omaris'
const ROOT = resolve(new URL('..', import.meta.url).pathname)
const DIST = join(ROOT, 'dist')
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html missing — run `npm run build` first')
  process.exit(1)
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.usdz': 'model/vnd.usdz+zip', '.glb': 'model/gltf-binary', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path.endsWith('/')) path += 'index.html'
  try {
    const body = await readFile(join(DIST, path))
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2 })
page.on('console', (m) => m.type() !== 'log' && console.log('[page]', m.type(), m.text()))
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(`http://127.0.0.1:${port}/?to=${encodeURIComponent(NAME)}`)
await page.waitForFunction(() => window.__bouquet?.triangles > 0)
await page.waitForTimeout(1200)

const outDir = join(ROOT, 'public')
mkdirSync(outDir, { recursive: true })
const slug = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')
await page.screenshot({ path: join(ROOT, 'tools', `preview-${slug}.png`) })

const tris = await page.evaluate(() => window.__bouquet.triangles)
const { glb, usdz } = await page.evaluate(() => window.__bouquet.exportBase64())
writeFileSync(join(outDir, `${slug}.glb`), Buffer.from(glb, 'base64'))
writeFileSync(join(outDir, `${slug}.usdz`), Buffer.from(usdz, 'base64'))
console.log(`${NAME}: ${tris} triangles → ${slug}.glb (${(glb.length * 0.75 / 1024).toFixed(0)} KB), ${slug}.usdz (${(usdz.length * 0.75 / 1024).toFixed(0)} KB)`)

await browser.close()
server.close()

// Repack the ASCII USDZ as a binary crate (much smaller) and sanity-check it.
const repack = spawnSync('python3', [join(ROOT, 'tools', 'compact-usdz.py'), join(outDir, `${slug}.usdz`)], { stdio: 'inherit' })
if (repack.status !== 0) {
  console.error('compact-usdz.py failed; the ASCII USDZ was left in place')
  process.exit(repack.status ?? 1)
}
