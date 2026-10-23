import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LAYERS, MAX_SIDE, MIN_SCALE, MAX_SCALE, createProject, createImageLayer, addLayer, patchLayer,
  selectLayer, reorderLayer, duplicateLayer, removeLayer, layerMatrix,
  layerToCanvas, canvasToLayer, hitLayer, createHistory, historyState,
  recordHistory, travelHistory, reviveProject, combineAlpha, adjustPixels,
} from '../studio/model.js';

function scene() {
  const project = createProject('Ricky in the jungle', { id: 'project-1', width: 1200, height: 900 });
  const ricky = createImageLayer({ id: 'ricky', assetId: 'asset-ricky', name: 'Ricky', width: 600, height: 800, x: 400, y: 450 });
  const jungle = createImageLayer({ id: 'jungle', assetId: 'asset-jungle', name: 'Dinosaurs', width: 1200, height: 900 });
  return addLayer(addLayer(project, ricky), jungle, { behind: true });
}

test('the project is versioned, bounded, immutable and ordered from back to front', () => {
  const project = scene();
  assert.equal(project.version, 1);
  assert.deepEqual(project.layers.map((layer) => layer.id), ['jungle', 'ricky']);
  assert.equal(project.selectedId, 'jungle');
  assert.ok(Object.isFrozen(project) && Object.isFrozen(project.layers));
  assert.ok(Object.isFrozen(project.layers[0].adjustments));
  assert.throws(() => { project.layers[0].x = 1; }, TypeError);
  assert.equal(MAX_SIDE, 2048);
  assert.throws(() => createProject('Too big', { width: 2049, height: 100 }), /dimensions/);
  assert.throws(() => createImageLayer({ assetId: 'bad', width: 1200, height: 3000 }), /dimensions/);
});

test('layer edits merge adjustments and shadow while protecting source identity', () => {
  const before = scene();
  const next = patchLayer(before, 'ricky', {
    id: 'stolen', assetId: 'replacement', width: 1, name: 'Ricky cutout', x: 500,
    adjustments: { brightness: 1.2 }, shadow: { blur: 20, opacity: 0.4 },
  });
  const layer = next.layers[1];
  assert.equal(before.layers[1].x, 400);
  assert.equal(layer.x, 500);
  assert.deepEqual([layer.id, layer.assetId, layer.width], ['ricky', 'asset-ricky', 600]);
  assert.deepEqual(layer.adjustments, { brightness: 1.2, contrast: 1, saturation: 1 });
  assert.deepEqual(layer.shadow, { blur: 20, opacity: 0.4, offsetX: 0, offsetY: 0 });
  assert.equal(patchLayer(next, 'ricky', { x: 500 }), next, 'a no-op reuses the state');
  const bounded = patchLayer(next, 'ricky', { x: NaN, scale: 0, rotation: Infinity, opacity: 4, blend: 'unknown', adjustments: { saturation: -20 } }).layers[1];
  assert.deepEqual([bounded.x, bounded.scale, bounded.rotation, bounded.opacity, bounded.blend, bounded.adjustments.saturation], [500, MIN_SCALE, 0, 1, 'source-over', 0]);
});

test('layer creation validates transforms and shares scale bounds with edits and revival', () => {
  const source = { assetId: 'source', width: 8, height: 8 };
  for (const patch of [{ x: NaN }, { y: Infinity }, { scale: NaN }, { scale: Infinity }, { scale: 0 }, { scale: -1 }]) {
    assert.throws(() => createImageLayer({ ...source, ...patch }), /transform/);
  }
  for (const patch of [{ width: 1.5 }, { height: 0 }, { width: 2049 }, { assetId: 123 }, { id: '' }]) {
    assert.throws(() => createImageLayer({ ...source, ...patch }), /dimensions/);
  }
  assert.deepEqual([MIN_SCALE, MAX_SCALE], [1 / 4096, 4096]);
  for (const [scale, expected] of [[MIN_SCALE / 2, MIN_SCALE], [MAX_SCALE * 2, MAX_SCALE]]) {
    let project = addLayer(createProject('Bounded scale'), createImageLayer({ ...source, id: 'bounded', scale }));
    assert.equal(project.layers[0].scale, expected);
    project = patchLayer(project, 'bounded', { scale });
    assert.equal(project.layers[0].scale, expected);
    assert.deepEqual(reviveProject(JSON.parse(JSON.stringify(project))), project);
  }
});

test('small backgrounds and large photos on tiny canvases retain exact fitted scale on reopen', () => {
  const cases = [
    { id: 'small-background', canvas: 2048, image: 8, scale: 256 },
    { id: 'tiny-canvas', canvas: 1, image: 2048, scale: 1 / 2048 },
  ];
  for (const value of cases) {
    let project = createProject(value.id, { width: value.canvas, height: value.canvas });
    project = addLayer(project, createImageLayer({
      id: value.id, assetId: `asset-${value.id}`, width: value.image, height: value.image,
      x: value.canvas / 2, y: value.canvas / 2, scale: value.scale,
    }));
    const revived = reviveProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(revived, project);
    assert.equal(revived.layers[0].scale, value.scale);
    assert.deepEqual(layerToCanvas(revived.layers[0], 0, 0), [0, 0]);
    assert.deepEqual(layerToCanvas(revived.layers[0], value.image, value.image), [value.canvas, value.canvas]);
  }
});

test('reorder, duplicate, remove and selection preserve assets and stable layer identities', () => {
  let project = scene();
  project = patchLayer(project, 'ricky', { maskId: 'mask-ricky', adjustments: { saturation: 0.8 } });
  const old = project.layers[1];
  project = duplicateLayer(project, 'ricky', { newLayerId: 'ricky-copy' });
  assert.deepEqual(project.layers.map((layer) => layer.id), ['jungle', 'ricky', 'ricky-copy']);
  const copy = project.layers[2];
  assert.equal(copy.assetId, old.assetId, 'duplicating never duplicates the source Blob');
  assert.equal(copy.maskId, old.maskId, 'immutable masks can be shared');
  assert.deepEqual([copy.x, copy.y], [old.x + 24, old.y + 24]);
  project = patchLayer(project, copy.id, { x: 900, adjustments: { saturation: 1.5 }, maskId: 'mask-copy' });
  assert.equal(project.layers[1].maskId, 'mask-ricky');
  assert.equal(project.layers[1].adjustments.saturation, 0.8);
  project = reorderLayer(project, 'ricky-copy', -1);
  assert.deepEqual(project.layers.map((layer) => layer.id), ['jungle', 'ricky-copy', 'ricky']);
  assert.equal(reorderLayer(project, 'ricky', 1), project, 'frontmost layer cannot leave the stack');
  project = removeLayer(project, 'ricky-copy');
  assert.equal(project.selectedId, 'ricky');
  assert.equal(selectLayer(project, 'missing'), project);
  assert.equal(selectLayer(project, null).selectedId, null);
});

test('the eight-layer limit applies to imports and duplicates without modifying the scene', () => {
  let project = createProject('Eight');
  for (let i = 0; i < MAX_LAYERS; i++) project = addLayer(project, createImageLayer({ id: `layer-${i}`, assetId: 'shared-source', width: 10, height: 10 }));
  assert.equal(project.layers.length, 8);
  assert.throws(() => addLayer(project, createImageLayer({ assetId: 'ninth', width: 10, height: 10 })), /8 layers/);
  assert.throws(() => duplicateLayer(project, 'layer-0'), /8 layers/);
  assert.equal(project.layers.length, 8);
});

test('source/canvas transforms roundtrip at arbitrary scale, centre and rotation', () => {
  const base = scene().layers[1];
  for (let i = 0; i < 500; i++) {
    const layer = { ...base, x: i * 3.25 - 500, y: 300 - i * 0.75, scale: 0.05 + (i % 30) / 7, rotation: (i - 250) * 0.113 };
    const x = (i * 43) % layer.width, y = (i * 61) % layer.height;
    const point = layerToCanvas(layer, x, y), restored = canvasToLayer(layer, ...point);
    assert.ok(Math.abs(restored[0] - x) < 1e-8 && Math.abs(restored[1] - y) < 1e-8);
    const [a, b, c, d, e, f] = layerMatrix(layer);
    assert.ok(Math.abs(point[0] - (a * x + c * y + e)) < 1e-8);
    assert.ok(Math.abs(point[1] - (b * x + d * y + f)) < 1e-8);
    assert.deepEqual(layerToCanvas(layer, layer.width / 2, layer.height / 2).map((v) => Math.round(v * 1e6) / 1e6), [layer.x, layer.y]);
  }
  const turned = { ...base, rotation: Math.PI / 2, scale: 0.7 };
  assert.equal(hitLayer(turned, ...layerToCanvas(turned, 30, 40)), true);
  assert.equal(hitLayer(turned, ...layerToCanvas(turned, -10, 40)), false);
  assert.equal(hitLayer({ ...turned, visible: false }, turned.x, turned.y), false);
  assert.equal(hitLayer({ ...turned, opacity: 0 }, turned.x, turned.y), false);
});

test('history stores immutable mask recipes and restores exact states across branches', () => {
  const original = scene();
  let history = createHistory(original);
  const masked = patchLayer(original, 'ricky', { maskId: 'mask-v1' });
  history = recordHistory(history, masked, 'Cut out Ricky');
  const refined = patchLayer(masked, 'ricky', { maskId: 'mask-v2', x: 480, rotation: 0.2 });
  history = recordHistory(history, refined, 'Refine and move');
  assert.equal(recordHistory(history, refined, 'No change'), history);
  history = travelHistory(history, -1);
  assert.equal(historyState(history), masked);
  assert.equal(historyState(history).layers[1].maskId, 'mask-v1');
  const branch = patchLayer(masked, 'ricky', { x: 600 });
  history = recordHistory(history, branch, 'Move elsewhere');
  assert.equal(history.entries.length, 3, 'the abandoned redo branch is removed');
  assert.equal(travelHistory(history, 1), history);
  history = travelHistory(travelHistory(history, -1), -1);
  assert.deepEqual(historyState(history), original);
  assert.equal(travelHistory(history, -1), history);
  assert.ok(!JSON.stringify(history).includes('data:image'), 'snapshots contain no pixels');
});

test('project persistence preserves masks, alpha-related settings and independent transforms', () => {
  let project = scene();
  project = patchLayer(project, 'ricky', { maskId: 'mask-soft-hair', opacity: 0.8, blend: 'screen', rotation: -0.25, scale: 0.7, shadow: { opacity: 0.3, offsetY: 14 } });
  project = selectLayer(project, 'ricky');
  const revived = reviveProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(revived, project);
  assert.ok(Object.isFrozen(revived.layers[1]));
  assert.throws(() => reviveProject({ ...project, version: 2 }), /could not be opened/);
  assert.throws(() => reviveProject({ ...project, layers: [project.layers[0], project.layers[0]] }), /damaged/);
  assert.throws(() => reviveProject({ ...project, layers: [{ ...project.layers[0], scale: NaN }] }), /damaged/);
});

test('mask operations preserve holes, partial alpha and reversible immutable versions', () => {
  assert.equal(combineAlpha(255, 0, 'replace'), 0, 'a transparent interior hole stays a hole');
  assert.equal(combineAlpha(0, 127, 'replace'), 127, 'a soft hair edge keeps its alpha');
  assert.equal(combineAlpha(80, 127, 'add'), 127, 'adding a selection takes the alpha union');
  assert.equal(combineAlpha(127, 80, 'add'), 127, 're-adding the same boundary does not harden it');
  assert.equal(combineAlpha(255, 255, 'subtract'), 0);
  assert.equal(combineAlpha(128, 128, 'subtract'), 64);
  assert.equal(combineAlpha(255, 0, 'subtract'), 255);
  assert.throws(() => combineAlpha(0, 0, 'multiply'), /replace, add or subtract/);
});

test('adjustment identity is byte exact and every adjustment preserves original alpha', () => {
  const original = new Uint8ClampedArray([30, 80, 210, 0, 50, 120, 240, 128, 200, 220, 250, 255]);
  assert.equal(adjustPixels(original), original);
  assert.deepEqual([...original], [30, 80, 210, 0, 50, 120, 240, 128, 200, 220, 250, 255]);
  const changed = adjustPixels(original.slice(), { brightness: 1.2, contrast: 0.8, saturation: 1.5 });
  assert.deepEqual([changed[3], changed[7], changed[11]], [0, 128, 255]);
  assert.notDeepEqual(changed, original);
  const mono = adjustPixels(original.slice(), { saturation: 0 });
  for (let i = 0; i < mono.length; i += 4) assert.deepEqual([...mono.slice(i, i + 3)], [mono[i], mono[i], mono[i]]);
});
