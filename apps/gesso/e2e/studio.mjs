#!/usr/bin/env node
// Real Canvas2D/IndexedDB checks. Run after the timing-sensitive legacy suite.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { profiledJpeg, profiledPng } from './color-fixture.mjs';

async function loadPlaywright() {
  const paths = [process.env.PLAYWRIGHT_MODULE, 'playwright'];
  try { paths.push(pathToFileURL(join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright/index.mjs')).href); } catch {}
  paths.push('/opt/homebrew/lib/node_modules/playwright/index.mjs');
  for (const path of paths.filter(Boolean)) { try { const module = await import(path); if (module.chromium && module.webkit) return module; } catch {} }
  throw new Error('Playwright is unavailable; set PLAYWRIGHT_MODULE to its index.mjs.');
}
const { chromium, webkit } = await loadPlaywright();
const base = process.env.GESSO_BASE || 'http://127.0.0.1:4174/gesso/';
const out = process.env.GESSO_STUDIO_OUT || '/tmp/gesso-scratch/studio-browser';
await mkdir(out, { recursive: true });
const results = [];
for (const [name, browserType] of Object.entries({ chromium, webkit })) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.route('**/__studio_engine_test__', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Studio renderer test</title>' }));
    await page.goto(new URL('__studio_engine_test__', base).href);
    const checks = await page.evaluate(async (base) => {
      const { createStudio } = await import(new URL('studio/engine.js', base).href);
      const check = (ok, message) => { if (!ok) throw Error(message); window.__studioTestStep = message; return message; };
      const passed = [];
      const surface = (w = 200, h = 160) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
      const blob = (c, type = 'image/png') => new Promise((resolve) => c.toBlob(resolve, type));
      const file = async (c, name) => new File([await blob(c)], name, { type: 'image/png' });
      const read = async (blob) => { const b = await createImageBitmap(blob); const c = surface(b.width, b.height); c.getContext('2d').drawImage(b, 0, 0); b.close(); return c.getContext('2d').getImageData(0, 0, c.width, c.height); };
      const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
      const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const engine = await createStudio();
      check(engine.persistent, 'IndexedDB is available');
      const source = surface(), sourceCtx = source.getContext('2d');
      sourceCtx.fillStyle = '#ff0000'; sourceCtx.fillRect(20, 20, 160, 120);
      await engine.addPhoto(await file(source, 'Foreground.png'));
      const foreground = engine.selected.id, firstId = engine.project.id;
      const transparent = await read(await engine.exportImage());
      passed.push(check(pixel(transparent, 0, 0)[3] === 0, 'PNG source and export retain original alpha'));
      const jpeg = await read(await engine.exportImage({ type: 'image/jpeg' }));
      passed.push(check(pixel(jpeg, 0, 0).slice(0, 3).every((v) => v > 248), 'JPEG has a white ground'));
      const background = surface(); background.getContext('2d').fillStyle = '#0000ff'; background.getContext('2d').fillRect(0, 0, 200, 160);
      await engine.addPhoto(await file(background, 'Background.png'), { behind: true });
      passed.push(check(engine.project.layers[0].name === 'Background', 'Background is placed below the subject'));
      const mask = surface(), m = mask.getContext('2d');
      m.fillStyle = '#fff'; m.fillRect(20, 20, 80, 120); m.clearRect(40, 40, 20, 20);
      m.globalAlpha = 0.5; m.fillRect(100, 20, 40, 120);
      await engine.setMask(foreground, mask);
      let image = await read(await engine.exportImage());
      passed.push(check(equal(pixel(image, 50, 50), [0, 0, 255, 255]), 'Interior mask holes reveal the background'));
      passed.push(check(pixel(image, 110, 80)[0] > 120 && pixel(image, 110, 80)[0] < 135 && pixel(image, 110, 80)[2] > 120, 'Fractional mask alpha blends rather than thresholds'));
      const masked = image.data.slice(), maskId = engine.project.layers[1].maskId;
      await engine.undo(); image = await read(await engine.exportImage());
      passed.push(check(equal(pixel(image, 150, 80), [255, 0, 0, 255]), 'Undo restores the previous unmasked source'));
      await engine.redo();
      passed.push(check(equal((await read(await engine.exportImage())).data, masked), 'Redo restores exact masked pixels'));
      engine.begin(); engine.updateLayer(foreground, { x: 126, rotation: 0.3 }, { commit: false }); engine.cancel();
      passed.push(check(engine.project.layers[1].x === 100 && engine.project.layers[1].rotation === 0, 'Cancelled transform restores the original position'));
      engine.updateLayer(foreground, { opacity: 0.7, adjustments: { saturation: 0.6 }, shadow: { blur: 4, opacity: 0.3, offsetY: 5 } });
      const beforeOpen = (await read(await engine.exportImage())).data.slice();
      await engine.flush(); await engine.newProject('Second project'); await engine.open(firstId);
      passed.push(check(engine.project.layers.length === 2 && engine.project.layers[1].maskId === maskId && engine.canUndo, 'Projects restore separate layers, masks, adjustments and history'));
      passed.push(check(equal((await read(await engine.exportImage())).data, beforeOpen), 'Reopened composition matches exported pixels exactly'));
      engine.select(foreground); engine.duplicate(foreground); const copyId = engine.selected.id;
      const replacement = surface(); replacement.getContext('2d').fillStyle = '#fff'; replacement.getContext('2d').fillRect(0, 0, 10, 10);
      await engine.setMask(copyId, replacement);
      passed.push(check(engine.project.layers.find((l) => l.id === foreground).maskId === maskId && engine.selected.maskId !== maskId, 'Duplicate mask edits never modify the original cutout'));
      engine.remove(copyId); await engine.undo();
      passed.push(check(engine.project.layers.length === 3 && engine.getLayerImage(copyId) && engine.getMask(copyId), 'Undo removal reloads retained source and mask assets'));
      while (engine.project.layers.length < 8) engine.duplicate(foreground);
      let bounded = false; try { engine.duplicate(foreground); } catch (err) { bounded = /8 layers/.test(err.message); }
      passed.push(check(bounded && engine.project.layers.length === 8, 'Layer limit fails explicitly without corrupting the project'));
      await engine.flush();
      const original = engine.project, originalPixels = (await read(await engine.exportImage())).data.slice();
      const db = await new Promise((resolve) => { const r = indexedDB.open('gesso-studio', 1); r.onsuccess = () => resolve(r.result); });
      const broken = structuredClone(original); broken.id = 'missing-resource-project'; broken.name = 'Broken'; broken.layers[0].assetId = 'missing-asset';
      await new Promise((resolve, reject) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put({ id: broken.id, project: broken, createdAt: Date.now(), updatedAt: Date.now() }); tx.oncomplete = resolve; tx.onerror = reject; });
      db.close(); let failed = false; try { await engine.open(broken.id); } catch { failed = true; }
      passed.push(check(failed && engine.project.id === original.id && equal((await read(await engine.exportImage())).data, originalPixels), 'Damaged project open preserves the current artwork and assets'));
      await engine.removeProject('missing-resource-project'); await engine.removeProject(firstId);
      const remaining = await engine.projects();
      passed.push(check(remaining.length === 1 && remaining[0].name === 'Second project', 'Deleting one project preserves other projects'));
      await engine.newProject('Rapid redo');
      const rapidId = engine.project.id;
      await engine.addPhoto(await file(source, 'Rapid.png'));
      await engine.setMask(engine.selected.id, mask);
      const rapidPixels = (await read(await engine.exportImage())).data.slice();
      await engine.undo(); await engine.undo();
      const redo1 = engine.redo(), redo2 = engine.redo(), boundary = engine.redo();
      await engine.flush();
      passed.push(check(equal((await read(await engine.exportImage())).data, rapidPixels), 'Rapid redo at history boundary finishes loading before flush and export'));
      await Promise.all([redo1, redo2, boundary]); await engine.removeProject(rapidId);
      engine.dispose(); return passed;
    }, base);
    results.push({ browser: name, engineChecks: checks });
    console.log(`${name}: ${checks.length} Studio engine checks pass`);
    const colorChecks = [];
    for (const [format, make] of [['JPEG', profiledJpeg], ['PNG', profiledPng]]) {
      const fixture = await make(page);
      const colors = await page.evaluate(async ({ base, bytes, format }) => {
        const { createStudio } = await import(new URL('studio/engine.js', base).href);
        // Empty MIME also checks that reopening detects the original by magic.
        const file = new File([new Uint8Array(bytes)], `Synthetic.${format.toLowerCase()}`);
        const engine = await createStudio(); await engine.addPhoto(file);
        const id = engine.project.id, layerId = engine.selected.id;
        const reference = document.createElement('canvas'); reference.width = engine.project.width; reference.height = engine.project.height;
        const url = URL.createObjectURL(file), image = new Image();
        image.src = url; await image.decode(); reference.getContext('2d').drawImage(image, 0, 0, reference.width, reference.height); URL.revokeObjectURL(url);
        const sample = (c) => [[.25, .25], [.75, .25], [.25, .75], [.75, .75], [.5, .5], [.1, .1]].map(([x, y]) => [...c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data]);
        const expected = sample(reference), initial = sample(engine.getLayerImage(layerId));
        const output = document.createElement('canvas'); output.width = reference.width; output.height = reference.height;
        engine.render(output.getContext('2d')); const rendered = sample(output);
        await engine.flush(); engine.dispose();
        const reader = await createStudio(); await reader.open(id); const restored = sample(reader.getLayerImage(layerId));
        await reader.removeProject(id); reader.dispose();
        return { expected, initial, rendered, restored };
      }, { base, bytes: [...fixture], format });
      const sameColors = (actual) => actual.every((pixel, i) => pixel.every((value, channel) => Math.abs(value - colors.expected[i][channel]) <= (channel === 3 ? 0 : 1)));
      // ColorSync can quantize one RGB step differently between two identical
      // HTML decode/draw passes. Alpha stays exact; a profile failure is much larger.
      assert.ok(sameColors(colors.initial), `${format} source preserves color-managed pixels`);
      assert.ok(sameColors(colors.rendered), `${format} composition preserves color and alpha`);
      assert.ok(sameColors(colors.restored), `${format} colors survive reopening with empty MIME`);
      if (format === 'PNG') {
        assert.equal(colors.restored[4][3], 0, 'profile-bearing PNG keeps its hole');
        assert.equal(colors.restored[5][3], 128, 'profile-bearing PNG keeps half opacity');
      }
      colorChecks.push(`${format} profile import/render/reopen`);
    }
    results.at(-1).colorChecks = colorChecks;
    console.log(`${name}: 2 color-profile regressions pass`);
    if (process.env.GESSO_STUDIO_ENGINE_ONLY === '1') continue;
    await page.goto(new URL('studio/', base).href);
    await page.waitForFunction(() => !!window.gessoStudio?.engine, { timeout: 15000 });
    assert.equal(await page.locator('#start').isVisible(), true);
    await page.screenshot({ path: join(out, `${name}-empty.png`) });
    const fixture = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 240; c.height = 180;
      const g = c.getContext('2d'); g.fillStyle = '#244663'; g.fillRect(0, 0, 240, 180);
      g.fillStyle = '#f4d0a2'; g.fillRect(40, 35, 160, 110);
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.locator('#photo-input').setInputFiles({ name: 'Outline fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixture) });
    await page.waitForFunction(() => window.gessoStudio.engine.project?.layers.length === 1);
    await page.locator('[data-tool="select"]').click();
    const move = async (x, y) => {
      const point = await page.evaluate(([x, y]) => {
        const p = window.gessoStudio.sourceToScreen(x, y), r = document.querySelector('#artwork').getBoundingClientRect();
        return { x: p.x + r.left, y: p.y + r.top };
      }, [x, y]);
      await page.mouse.move(point.x, point.y, { steps: 8 });
    };
    await move(40, 35); await page.mouse.down(); await move(120, 35); await page.mouse.up();
    let state = await page.evaluate(() => ({ outline: window.gessoStudio.outline, mask: window.gessoStudio.engine.selected.maskId, selection: window.gessoStudio.selection }));
    assert.equal(state.outline.paused, true, 'lifting pauses an open outline');
    assert.equal(state.mask, undefined, 'lifting does not apply a mask');
    assert.equal(state.selection, null, 'lifting does not close the selection');
    const firstPath = state.outline.path;
    const navPoints = await page.evaluate(() => {
      const r = document.querySelector('#artwork').getBoundingClientRect();
      return [window.gessoStudio.sourceToScreen(45, 130), window.gessoStudio.sourceToScreen(190, 130)].map((p) => ({ x: p.x + r.left, y: p.y + r.top }));
    });
    if (name === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const points = navPoints.map((p, id) => ({ ...p, id, radiusX: 3, radiusY: 3, force: 1 }));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points.map((p) => ({ ...p, x: p.x + 12, y: p.y - 18 })) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      // WebKit's Playwright transport has no multi-touch API. Exercise the same
      // pointer handlers; physical iPhone checks still cover OS gesture delivery.
      await page.evaluate((points) => {
        const c = document.querySelector('#artwork'), capture = c.setPointerCapture;
        c.setPointerCapture = () => {};
        const send = (type, i, dx = 0, dy = 0) => c.dispatchEvent(new PointerEvent(type, { pointerId: 70 + i, pointerType: 'touch', clientX: points[i].x + dx, clientY: points[i].y + dy, bubbles: true }));
        try { send('pointerdown', 0); send('pointerdown', 1); send('pointermove', 0, 12, -18); send('pointermove', 1, 12, -18); send('pointerup', 0, 12, -18); send('pointerup', 1, 12, -18); }
        finally { c.setPointerCapture = capture; }
      }, navPoints);
    }
    assert.deepEqual(await page.evaluate(() => window.gessoStudio.outline.path), firstPath, 'two-finger navigation leaves the paused outline untouched');
    await page.locator('[data-tool="move"]').click();
    assert.deepEqual(await page.evaluate(() => window.gessoStudio.outline.path), firstPath, 'Move preserves an unfinished outline');
    await page.locator('[data-tool="select"]').click();
    await move(120, 35); await page.mouse.down(); await move(200, 35); await move(200, 145); await page.mouse.up();
    state = await page.evaluate(() => window.gessoStudio.outline);
    assert.equal(state.paused, true); assert.equal(state.segments, 2, 'another thumb stroke resumes the same outline');
    assert.deepEqual(state.path.slice(0, 2), firstPath.slice(0, 2), 'the initial anchor survives repositioning');
    await move(200, 145); await page.mouse.down(); await move(40, 145); await page.mouse.up();
    await page.getByRole('button', { name: 'Close outline', exact: true }).click();
    assert.equal(await page.evaluate(() => window.gessoStudio.outline), null);
    assert.ok(await page.evaluate(() => window.gessoStudio.selection), 'explicit Close creates a selection preview');
    assert.equal(await page.evaluate(() => window.gessoStudio.engine.selected.maskId), undefined, 'selection review still does not alter source');
    await page.getByRole('button', { name: 'Keep selected', exact: true }).click();
    await page.waitForFunction(() => !!window.gessoStudio.engine.selected.maskId);
    await page.waitForFunction(() => document.querySelector('#busy').hidden);
    const alpha = await page.evaluate(() => {
      const m = window.gessoStudio.engine.getMask(window.gessoStudio.engine.selected.id), ctx = m.getContext('2d');
      return [ctx.getImageData(0, 0, 1, 1).data[3], ctx.getImageData(120, 90, 1, 1).data[3]];
    });
    assert.deepEqual(alpha, [0, 255], 'the traced selection keeps its interior and hides its exterior');
    const beforeMaskWrite = await page.evaluate(() => {
      const e = window.gessoStudio.engine, original = e.setMask.bind(e);
      window.__originalStudioSetMask = e.setMask;
      e.setMask = async (...args) => { await new Promise((resolve) => { window.__resumeStudioMask = resolve; }); return original(...args); };
      return JSON.stringify(e.project);
    });
    await move(85, 85); await page.mouse.down(); await move(100, 85); await page.mouse.up();
    await page.waitForFunction(() => typeof window.__resumeStudioMask === 'function');
    assert.equal(await page.locator('#undo').isDisabled(), true, 'Undo is locked during a mask write');
    await page.evaluate(() => document.querySelector('#undo').click());
    assert.equal(await page.evaluate(() => JSON.stringify(window.gessoStudio.engine.project)), beforeMaskWrite, 'one attempted Undo cannot cancel a mask and undo an earlier edit');
    await page.evaluate(() => { window.gessoStudio.engine.setMask = window.__originalStudioSetMask; window.__resumeStudioMask(); });
    await page.waitForFunction(() => document.querySelector('#busy').hidden);
    const projectId = await page.evaluate(async () => { await window.gessoStudio.engine.flush(); return window.gessoStudio.engine.project.id; });
    await page.screenshot({ path: join(out, `${name}-masked.png`) });
    await page.reload(); await page.waitForFunction(() => !!window.gessoStudio?.engine?.project?.layers.length);
    assert.equal(await page.evaluate(() => window.gessoStudio.engine.project.id), projectId, 'last project reopens automatically');
    assert.ok(await page.evaluate(() => window.gessoStudio.engine.selected.maskId), 'the repaired mask remains editable after reload');
    await page.locator('#export').click();
    await page.waitForFunction(() => !document.querySelector('#share-export').disabled);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: () => new Promise((resolve) => { window.__finishStudioShare = resolve; }) });
    });
    const beforeShortcut = await page.evaluate(() => JSON.stringify(window.gessoStudio.engine.project));
    await page.locator('#share-export').click();
    assert.equal(await page.locator('[data-format="png"]').isDisabled(), true, 'format cannot unlock an active share');
    assert.equal(await page.locator('#save-export').isDisabled(), true, 'Save stays locked during Share');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => JSON.stringify(window.gessoStudio.engine.project)), beforeShortcut, 'Undo shortcut cannot change a prepared export');
    await page.evaluate(() => window.__finishStudioShare());
    await page.waitForFunction(() => !document.querySelector('#share-export').disabled);
    await page.locator('#export-sheet [data-close]').click();
    results.at(-1).interactionChecks = ['thumb lift pauses', 'two fingers preserve the paused path', 'Move preserves the pending outline', 'stroke resumes same outline', 'explicit Close previews selection', 'Keep applies editable mask', 'pending mask write locks Undo', 'last project and mask restore across reload', 'share and format remain locked', 'modal shortcuts preserve exported state'];
    console.log(`${name}: 10 Studio interaction checks pass`);
    const offlineContext = await browser.newContext({ viewport: { width: 393, height: 852 }, serviceWorkers: 'allow' });
    try {
      const offlinePage = await offlineContext.newPage();
      await offlinePage.goto(new URL('studio/', base).href);
      await offlinePage.evaluate(() => navigator.serviceWorker.ready);
      await offlinePage.reload();
      await offlineContext.setOffline(true);
      await offlinePage.goto(new URL('studio/?offline=1', base).href);
      await offlinePage.waitForFunction(() => !!window.gessoStudio?.engine);
      assert.equal(await offlinePage.locator('#start').isVisible(), true, 'Studio starts from its cached shell offline');
      results.at(-1).offline = true;
      console.log(`${name}: Studio offline entry passes`);
    } finally { await offlineContext.close(); }
  } catch (error) {
    console.error(name, await page.evaluate(() => ({ lastCheck: window.__studioTestStep, title: document.title })).catch(() => ({})));
    throw error;
  } finally { await context.close(); await browser.close(); }
}
await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
