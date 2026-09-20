// Browser regression checks for the handoff to native AR, not a native AR test.
// Chromium does not implement Apple Quick Look. We advertise rel=ar support for
// the iOS cases, then inspect ordinary links and stop their native navigation.
// Custom bouquets really build/export; one URL-allocation failure tests retry.
// Run after npm run build: node tools/test-ar-flow.mjs
// The same script can live at tools/bouquet/test-ar-flow.mjs in Elsewhere.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(root, 'package.json'))) {
  const parent = dirname(root)
  assert.notEqual(parent, root, 'Could not locate package.json')
  root = parent
}
const dist = join(root, 'dist')
const hasNestedPage = existsSync(join(dist, 'Omaris', 'ar.html'))
const hasRootPage = existsSync(join(dist, 'ar.html'))
assert.ok(hasRootPage || hasNestedPage, 'Build the site before running AR flow checks')
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml',
  '.usdz': 'model/vnd.usdz+zip', '.glb': 'model/gltf-binary',
}
// A standalone build is also mounted under /Omaris/ to catch absolute model,
// poster, button and back-link regressions. In Elsewhere, use its real build.
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname)
    if (!hasNestedPage && pathname.startsWith('/Omaris/')) pathname = pathname.slice('/Omaris'.length)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = resolve(dist, `.${pathname}`)
    if (!file.startsWith(dist + sep)) throw new Error('Outside build directory')
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const agents = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
}

async function newPage(device = 'desktop', options = {}) {
  const context = await browser.newContext({
    ...(agents[device] ? { userAgent: agents[device] } : {}),
    viewport: { width: 430, height: 860 },
  })
  await context.addInitScript(({ quickLook, failFirstBlob }) => {
    window.__arAudit = { webgl: 0, syntheticClicks: 0, fetches: [], failedBlobURLs: 0 }
    if (quickLook) {
      const supports = DOMTokenList.prototype.supports
      DOMTokenList.prototype.supports = function (token) {
        return token === 'ar' || supports.call(this, token)
      }
    }
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (/webgl/i.test(type)) window.__arAudit.webgl++
      return getContext.call(this, type, ...args)
    }
    for (const Constructor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Constructor) continue
      const getExtension = Constructor.prototype.getExtension
      Constructor.prototype.getExtension = function (name) {
        const extension = getExtension.call(this, name)
        if (name === 'WEBGL_lose_context' && extension && !extension.__observed) {
          const lose = extension.loseContext.bind(extension)
          extension.loseContext = () => {
            sessionStorage.setItem('ar-test-context-released', 'yes')
            return lose()
          }
          extension.__observed = true
        }
        return extension
      }
    }
    const click = HTMLElement.prototype.click
    HTMLElement.prototype.click = function () {
      window.__arAudit.syntheticClicks++
      return click.call(this)
    }
    const fetch = window.fetch
    window.fetch = function (input, options) {
      window.__arAudit.fetches.push({ url: String(input), method: options?.method ?? 'GET' })
      return fetch.call(this, input, options)
    }
    if (failFirstBlob) {
      const create = URL.createObjectURL
      let fail = true
      URL.createObjectURL = function (blob) {
        if (fail && blob.type === 'model/vnd.usdz+zip') {
          fail = false
          window.__arAudit.failedBlobURLs++
          throw new Error('Intentional test: cannot allocate model URL')
        }
        return create.call(this, blob)
      }
    }
  }, { quickLook: device === 'ios' && options.quickLook !== false, failFirstBlob: options.failFirstBlob ?? false })
  const page = await context.newPage()
  const requests = []
  const errors = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method(), type: request.resourceType() }))
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(30000)
  return { context, page, requests, errors }
}

async function lightPage(test) {
  const audit = await test.page.evaluate(() => window.__arAudit)
  assert.equal(audit.webgl, 0, 'AR landing document must not create WebGL')
  assert.equal(audit.syntheticClicks, 0, 'Native AR must start from a real user tap')
  assert.equal(audit.fetches.length, 0, 'Static AR must not fetch or probe models before the user taps')
  assert.ok(!test.requests.some((r) => /(?:three|bouquet|ar-export)[^/]*\.js(?:\?|$)/i.test(r.url)), 'Default AR page loaded a 3D bundle')
  assert.ok(!test.requests.some((r) => /\.(usdz|glb)(?:[?#]|$)/i.test(r.url)), 'Default AR page prefetched a model')
  assert.ok(!test.requests.some((r) => r.method === 'HEAD'), 'AR launch must not depend on a HEAD probe')
  assert.deepEqual(test.errors, [])
}

async function assertNativeLink(page, path, expectBlob = false) {
  const details = await page.locator('#ar-link').evaluate((link) => ({
    href: link.href, rel: link.rel, hidden: link.hidden,
    children: Array.from(link.children, (child) => child.tagName),
    imageLoaded: link.firstElementChild.complete && link.firstElementChild.naturalWidth > 0,
  }))
  assert.equal(details.hidden, false)
  assert.equal(details.rel, 'ar')
  assert.deepEqual(details.children, ['IMG'], 'Quick Look link needs exactly one image child')
  assert.equal(details.imageLoaded, true)
  const url = new URL(details.href)
  assert.equal(url.hash, '#allowsContentScaling=0')
  if (expectBlob) assert.equal(url.protocol, 'blob:')
  else {
    assert.equal(url.pathname, path + 'omaris.usdz')
    assert.ok(url.searchParams.get('v'), 'Static model URL must carry a cache version')
  }
  // Observe the real pointer tap at the end of event propagation, then prevent
  // Chromium from downloading the USDZ. The application must not cancel it.
  await page.evaluate(() => document.addEventListener('click', (event) => {
    if (event.target.closest?.('#ar-link')) {
      window.__nativeTap = { trusted: event.isTrusted, canceledByApp: event.defaultPrevented }
      event.preventDefault()
    }
  }))
  await page.locator('#ar-link').click()
  assert.deepEqual(await page.evaluate(() => window.__nativeTap), { trusted: true, canceledByApp: false })
  assert.equal(await page.locator('#return-hint').isVisible(), true)
  assert.equal(await page.locator('#ar-link').isVisible(), true, 'Link must remain usable after returning from AR')
}

let passed = 0
async function check(label, action) {
  await action()
  passed++
  console.log(`PASS ${label}`)
}

try {
  const paths = hasRootPage ? ['/', '/Omaris/'] : ['/Omaris/']
  for (const path of paths) {
    await check(`iOS native link, lightweight document, query/back links at ${path}`, async () => {
      const test = await newPage('ios')
      try {
        const query = '?from=Mike&note=Hello%20%26%20goodnight&extra=keep%2Bme'
        await test.page.goto(origin + path + 'ar.html' + query)
        await assertNativeLink(test.page, path)
        assert.equal(await test.page.locator('#back-link').evaluate((link) => link.href), origin + path + query)
        assert.equal(await test.page.locator('#poster').evaluate((img) => img.complete && img.naturalWidth > 0), true)
        assert.equal(await test.page.locator('#retry').isVisible(), false)
        await lightPage(test)
      } finally { await test.context.close() }
    })

    await check(`Android Scene Viewer intent and readable fallback at ${path}`, async () => {
      const test = await newPage('android')
      try {
        const query = '?from=Mike&note=Keep%20this'
        await test.page.goto(origin + path + 'ar.html' + query)
        const link = test.page.locator('#ar-link')
        assert.equal(await link.isVisible(), true)
        assert.equal(await link.getAttribute('rel'), null)
        const intent = await link.getAttribute('href')
        assert.ok(intent.startsWith('intent://arvr.google.com/scene-viewer/1.0?'))
        const model = new URL(new URL(intent).searchParams.get('file'))
        assert.equal(model.pathname, path + 'omaris.glb')
        assert.ok(model.searchParams.get('v'))
        assert.equal(new URL(intent).searchParams.get('resizable'), 'false')
        const fallback = new URL(decodeURIComponent(intent.match(/S\.browser_fallback_url=([^;]+);/)[1]))
        assert.equal(fallback.pathname, path + 'ar.html')
        assert.equal(fallback.searchParams.get('note'), 'Keep this')
        assert.equal(fallback.searchParams.get('unavailable'), '1')
        await lightPage(test)
        await test.page.goto(fallback.href)
        assert.match(await test.page.locator('#ar-status').textContent(), /couldn.t open AR/i)
        assert.equal(await test.page.locator('#back-link').evaluate((a) => new URL(a.href).pathname), path)
      } finally { await test.context.close() }
    })
  }

  const primaryPath = hasRootPage ? '/' : '/Omaris/'
  for (const device of ['ios', 'android']) {
    await check(`${device} main page releases its renderer and preserves the query`, async () => {
      const test = await newPage(device)
      try {
        const query = '?to=Omaris&from=Mike&note=Hello%20%26%20goodnight'
        await test.page.goto(origin + primaryPath + query)
        await test.page.waitForFunction(() => window.__bouquet?.triangles > 0)
        const requestStart = test.requests.length
        await test.page.locator('#ar-button').click()
        await test.page.waitForURL(origin + primaryPath + 'ar.html' + query)
        await test.page.waitForLoadState('load')
        assert.equal(await test.page.evaluate(() => sessionStorage.getItem('ar-test-context-released')), 'yes')
        await lightPage({ ...test, requests: test.requests.slice(requestStart) })
      } finally { await test.context.close() }
    })
  }

  await check('personalized iOS export shows failure/retry, then a real USDZ blob link', async () => {
    const test = await newPage('ios', { failFirstBlob: true })
    try {
      const query = '?to=Juli%C3%A1n&from=Mike&note=Custom%20flowers'
      await test.page.goto(origin + primaryPath + 'ar.html' + query)
      assert.equal(await test.page.locator('#poster').isVisible(), false)
      await test.page.waitForFunction(() => document.querySelector('#retry').hidden === false)
      assert.match(await test.page.locator('#ar-status').textContent(), /couldn.t be prepared/i)
      assert.equal(await test.page.locator('#ar-link').isVisible(), false)
      assert.equal(await test.page.evaluate(() => window.__arAudit.failedBlobURLs), 1)
      await test.page.locator('#retry').click()
      await test.page.waitForFunction(() => document.querySelector('#ar-status').textContent.startsWith('Ready.'))
      assert.equal(await test.page.locator('#ar-name').textContent(), 'Julián')
      assert.equal(await test.page.locator('#retry').isVisible(), false)
      assert.equal(await test.page.locator('#back-link').evaluate((a) => new URL(a.href).search), query)
      await assertNativeLink(test.page, primaryPath, true)
      const audit = await test.page.evaluate(() => window.__arAudit)
      assert.equal(audit.webgl, 0, 'Personalized export must also avoid WebGL')
      assert.equal(audit.syntheticClicks, 0)
      assert.deepEqual(test.errors, [])
      const asset = await test.page.evaluate(async () => {
        const response = await fetch(document.querySelector('#ar-link').href)
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { type: response.headers.get('content-type'), size: bytes.length, magic: [...bytes.slice(0, 4)] }
      })
      assert.equal(asset.type, 'model/vnd.usdz+zip')
      assert.ok(asset.size > 100000, 'Custom USDZ should contain the actual model')
      assert.deepEqual(asset.magic, [80, 75, 3, 4])
    } finally { await test.context.close() }
  })

  for (const device of ['desktop', 'ios']) {
    await check(`${device} without Quick Look gets a usable fallback`, async () => {
      const test = await newPage(device, { quickLook: false })
      try {
        await test.page.goto(origin + primaryPath + 'ar.html?from=Mike')
        assert.equal(await test.page.locator('#ar-link').isVisible(), false)
        assert.match(await test.page.locator('#instructions').textContent(), /Safari/)
        assert.equal(await test.page.locator('#back-link').isVisible(), true)
        await lightPage(test)
      } finally { await test.context.close() }
    })
  }

  console.log(`${passed} browser-flow checks passed. Native iPhone Quick Look/camera placement still requires a real-device test.`)
  if (hasRootPage && !hasNestedPage) console.log('/Omaris/ checks used a prefix mount of the standalone build.')
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
