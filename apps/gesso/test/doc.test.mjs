import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECTS, LOOK_IDS, TEXT_STYLES, DIALS, DEFAULTS, dialById, createDoc, reviveDoc, setIn, getIn,
  deepEqual, changedDials, isUnedited, developInput, describeChange,
} from '../lib/doc.js';
import {
  initialCrop, orientedSize, rectFits, setAspect, setAngle, rotateQuarter, flipHorizontal,
  dragHandle, moveRect, MAX_STRAIGHTEN,
} from '../lib/geometry.js';
import { lookById, resolve, PARAM_KEYS } from '../lib/develop.js';
import { RULERS } from '../lib/ruler.js';
import { SWATCHES } from '../lib/text-layout.js';

const W = 4000, H = 3000;
const fresh = (over = {}) => createDoc({ id: 'doc1', sourceType: 'jpeg', natW: 8000, natH: 6000, w: W, h: H, now: 1_700_000_000_000, ...over });
const json = (v) => JSON.parse(JSON.stringify(v));
const cropFits = (doc) => {
  const o = orientedSize(doc.source.w, doc.source.h, doc.crop.quarter);
  return rectFits(doc.crop.rect, o.width, o.height, doc.crop.angle);
};
const withCrop = (doc, fn) => ({ ...doc, crop: fn(doc.crop) });
const caption = (over = {}) => ({ id: 'c1', text: 'Hello', style: 'classic', color: '#ffffff', cx: 0.5, cy: 0.78, size: 0.08, angle: 0, ...over });

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ constants

test('DIALS are well-formed, unique, and their paths resolve to the defaults', () => {
  const doc = fresh();
  const ids = new Set();
  for (const d of DIALS) {
    assert.ok(!ids.has(d.id), `duplicate ${d.id}`);
    ids.add(d.id);
    assert.ok(['light', 'color', 'crop', 'remove', 'text'].includes(d.group), d.id);
    assert.ok(typeof d.label === 'string' && d.label.length > 0);
    assert.ok(d.min < d.max && d.def >= d.min && d.def <= d.max, d.id);
    assert.equal(typeof d.unit, 'string');
    assert.ok(Object.isFrozen(d));
    if (d.path) assert.equal(getIn(doc, d.path), d.def, `${d.id} default`);
    else assert.ok(d.group === 'remove' || d.field, `${d.id} needs a path or a field`);
  }
  for (const k of Object.keys(DEFAULTS.light)) assert.equal(dialById(k).def, DEFAULTS.light[k]);
  for (const k of ['warmth', 'tint', 'vividness', 'strength']) assert.equal(dialById(k).def, DEFAULTS.color[k]);
  assert.equal(dialById('straighten').max, MAX_STRAIGHTEN);
  assert.equal(dialById('nope'), null);
  assert.ok(Object.isFrozen(DIALS) && Object.isFrozen(DEFAULTS.light) && Object.isFrozen(LOOK_IDS));
  assert.equal(DEFAULTS.caption.size, dialById('textSize').def);
});

test('DIALS and the ruler agree on every dial', () => {
  // Two tables describe the same dials (where values live vs how the ruler moves
  // them); if they drift, the ruler could set values that revive clamps away.
  for (const d of DIALS) {
    const r = RULERS[d.id];
    assert.ok(r, `ruler for ${d.id}`);
    assert.deepEqual([r.label, r.min, r.max, r.def], [d.label, d.min, d.max, d.def], d.id);
  }
});

test('every look id is a develop look, with a human label', () => {
  assert.deepEqual([...LOOK_IDS], ['none', 'vivid', 'warm', 'cool', 'film', 'mono']);
  for (const id of LOOK_IDS) assert.equal(lookById(id).id, id);
  assert.equal(ASPECTS.square, 1); // re-exported from geometry, not copied
});

// ------------------------------------------------------------------ createDoc

test('createDoc makes an unedited doc with an identity crop', () => {
  const d = fresh();
  assert.equal(d.v, 1);
  assert.equal(d.id, 'doc1');
  assert.equal(d.createdAt, 1_700_000_000_000);
  assert.deepEqual(d.source, { type: 'jpeg', natW: 8000, natH: 6000, w: W, h: H });
  assert.deepEqual(d.light, { brightness: 0, contrast: 0, highlights: 0, shadows: 0 });
  assert.deepEqual(d.color, { warmth: 0, tint: 0, vividness: 0, look: 'none', strength: 100 });
  assert.deepEqual(d.crop, initialCrop(W, H));
  assert.deepEqual([d.paint, d.remove, d.text], [[], [], []]);
  assert.ok(isUnedited(d));
  assert.equal(changedDials(d).size, 0);
  // Fresh objects: editing one doc never leaks into DEFAULTS or another doc.
  assert.notEqual(d.light, DEFAULTS.light);
  assert.notEqual(fresh().paint, d.paint);
});

test('createDoc defaults the natural size and type, and is deterministic', () => {
  const d = createDoc({ id: 'x', w: 10, h: 20 });
  assert.deepEqual(d.source, { type: 'unknown', natW: 10, natH: 20, w: 10, h: 20 });
  assert.deepEqual(createDoc({ id: 'x', w: 10, h: 20, natW: null, natH: null, sourceType: '' }).source, d.source);
  // a long panorama: the original may be far wider than any working image
  const pano = createDoc({ id: 'p', w: 8192, h: 1536, natW: 48000, natH: 9000 });
  assert.deepEqual(reviveDoc(json(pano)).source, pano.source);
  assert.equal(d.createdAt, 0);
  assert.deepEqual(createDoc({ id: 'x', w: 10, h: 20 }), d);
});

test('createDoc clamps createdAt as reviveDoc does, so a new doc survives autosave exactly', () => {
  // Regression: createDoc kept any finite `now` (negative, 1e300) while reviveDoc
  // clamps to 0..MAX_SAFE_INTEGER, so the first resume changed the doc.
  for (const now of [-5, 1e300, Infinity, -Infinity, NaN, -0, 1.5, 1_700_000_000_000]) {
    const d = createDoc({ id: 'x', w: 10, h: 20, now });
    assert.ok(Number.isFinite(d.createdAt) && d.createdAt >= 0 && d.createdAt <= Number.MAX_SAFE_INTEGER, String(now));
    assert.deepEqual(reviveDoc(json(d)), d, `now ${now}`);
  }
  assert.equal(createDoc({ id: 'x', w: 10, h: 20, now: -5 }).createdAt, 0);
  assert.equal(createDoc({ id: 'x', w: 10, h: 20, now: 1e300 }).createdAt, Number.MAX_SAFE_INTEGER);
});

test('createDoc rejects unusable input', () => {
  assert.throws(() => createDoc(), /id/);
  assert.throws(() => createDoc({ id: '', w: 10, h: 10 }), /id/);
  assert.throws(() => createDoc({ id: 'a', w: 0, h: 10 }), /working size/);
  assert.throws(() => createDoc({ id: 'a', w: 10.5, h: 10 }), /working size/);
  assert.throws(() => createDoc({ id: 'a', w: NaN, h: 10 }), /working size/);
  assert.throws(() => createDoc({ id: 'a', w: 10, h: 10, natW: -1 }), /natW/);
});

// ------------------------------------------------------------------ reviveDoc

test('reviveDoc round-trips a fresh doc and a busy one exactly', () => {
  const d = fresh();
  assert.deepEqual(reviveDoc(json(d)), d);
  assert.deepEqual(reviveDoc(JSON.stringify(d)), d); // a JSON string works too
  let busy = setIn(d, ['light', 'brightness'], 18);
  busy = setIn(busy, ['color'], { warmth: -6, tint: 3, vividness: 40, look: 'film', strength: 60 });
  busy = { ...busy, paint: ['s1', 's2'], remove: ['p1'], text: [caption(), caption({ id: 'c2', text: 'Two\nlines', angle: -180, cx: 0, cy: 1 })] };
  busy = withCrop(busy, (c) => setAngle(setAspect(c, W, H, '4:5'), W, H, -2.8));
  assert.deepEqual(reviveDoc(json(busy)), busy);
});

test('reviveDoc round-trips crops made by every geometry operation (fuzz)', () => {
  const rng = mulberry32(7);
  const keys = Object.keys(ASPECTS);
  for (let trial = 0; trial < 80; trial++) {
    // Tiny images too: below MIN_CROP, and where 45° shrinks the frame under 1 px.
    const side = () => (rng() < 0.2 ? 1 + Math.floor(rng() * 8) : 50 + Math.floor(rng() * 5000));
    const w = side(), h = side();
    let doc = createDoc({ id: `d${trial}`, w, h });
    for (let k = 0; k < 6; k++) {
      const pick = Math.floor(rng() * 6);
      doc = withCrop(doc, (c) => {
        if (pick === 0) return setAspect(c, w, h, keys[Math.floor(rng() * keys.length)]);
        if (pick === 1) return setAngle(c, w, h, (rng() - 0.5) * 100);
        if (pick === 2) return rotateQuarter(c, w, h);
        if (pick === 3) return flipHorizontal(c);
        if (pick === 4) return dragHandle(c, w, h, ['n', 'se', 'w', 'ne'][Math.floor(rng() * 4)], (rng() - 0.5) * w, (rng() - 0.5) * h);
        return moveRect(c, w, h, (rng() - 0.5) * w, (rng() - 0.5) * h);
      });
    }
    assert.ok(cropFits(doc), `trial ${trial} fits`);
    assert.deepEqual(reviveDoc(json(doc)), doc, `trial ${trial}`);
  }
});

test('reviveDoc clamps and cleans every field, and drops unknown ones', () => {
  const raw = json(fresh());
  raw.extra = 1;
  raw.createdAt = 'yesterday';
  raw.source = { ...raw.source, type: 42, natW: -5, natH: 'x', w: 4000.4, junk: true };
  raw.light = { brightness: 250, contrast: -3.6, highlights: '12', shadows: null, exposure: 50 };
  raw.color = { warmth: NaN, tint: -101, vividness: true, look: 'noir', strength: -5 };
  raw.paint = ['s1', 's1', '', 7, null, 's2'];
  raw.remove = 'p1';
  raw.text = [
    caption({ size: 9, cx: -1, cy: 3, angle: 270, style: 'comic', color: 'url(x)', text: 5, extra: 1 }),
    caption(), // duplicate id: dropped
    { text: 'no id' },
    'nonsense',
  ];
  const d = reviveDoc(raw);
  assert.ok(!('extra' in d));
  assert.equal(d.createdAt, 0);
  assert.deepEqual(d.source, { type: 'unknown', natW: 4000, natH: 3000, w: 4000, h: 3000 });
  assert.deepEqual(d.light, { brightness: 100, contrast: -4, highlights: 0, shadows: 0 });
  assert.deepEqual(d.color, { warmth: 0, tint: -100, vividness: 0, look: 'none', strength: 0 });
  assert.deepEqual(d.paint, ['s1', 's2']);
  assert.deepEqual(d.remove, []);
  assert.equal(d.text.length, 1);
  assert.deepEqual(d.text[0], { id: 'c1', text: '', style: 'classic', color: '#ffffff', cx: 0, cy: 1, size: 0.3, angle: -90 });
  assert.ok(!Object.is(reviveDoc({ ...raw, light: { brightness: -0.2 } }).light.brightness, -0), 'no negative zero');
});

test('reviveDoc keeps legal caption values and wraps only out-of-range angles', () => {
  const raw = json(fresh());
  raw.text = [caption({ angle: 180 }), caption({ id: 'c2', angle: -180 }), caption({ id: 'c3', angle: 540 }), caption({ id: 'c4', angle: -190, color: 'Yellow', size: 0.001 })];
  const t = reviveDoc(raw).text;
  assert.deepEqual(t.map((c) => c.angle), [180, -180, 180, 170]);
  assert.equal(t[3].color, 'Yellow');
  assert.equal(t[3].size, 0.03);
  const long = '😀'.repeat(2500);
  const clipped = reviveDoc({ ...raw, text: [caption({ text: long })] }).text[0].text;
  assert.equal(Array.from(clipped).length, 2000); // cut by code point, never mid-emoji
});

test('reviveDoc keeps only caption colours a canvas understands', () => {
  // Regression: /#[0-9a-f]{3,8}/ let #rrggb and #rrggbba through. A canvas ignores
  // those and paints with the previous fillStyle, and text-layout cannot parse them.
  const raw = json(fresh());
  const colorOf = (c) => reviveDoc({ ...raw, text: [caption({ color: c })] }).text[0].color;
  for (const ok of ['#fff', '#fff8', '#ffd60a', '#FFD60A80', 'white', 'Yellow']) assert.equal(colorOf(ok), ok);
  for (const bad of ['#fffff', '#fffffff', '#ff', '#fffffffff', '#ggg', 'url(x)', 'rgb(1,2,3)', '', '#', 7, null]) {
    assert.equal(colorOf(bad), DEFAULTS.caption.color, String(bad));
  }
  // every colour the Text tool offers survives a resume
  for (const s of SWATCHES) assert.equal(colorOf(s.hex), s.hex, s.id);
});

test('reviveDoc throws on records that cannot describe a photo', () => {
  const ok = json(fresh());
  assert.throws(() => reviveDoc(null), /not an object/);
  assert.throws(() => reviveDoc([ok]), /not an object/);
  assert.throws(() => reviveDoc('{nope'), SyntaxError);
  assert.throws(() => reviveDoc({ ...ok, v: 2 }), /version/);
  assert.throws(() => reviveDoc({ ...ok, v: undefined }), /version/);
  assert.throws(() => reviveDoc({ ...ok, id: '' }), /id/);
  assert.throws(() => reviveDoc({ ...ok, id: 'x'.repeat(500) }), /id/);
  assert.throws(() => reviveDoc({ ...ok, source: undefined }), /source/);
  assert.throws(() => reviveDoc({ ...ok, source: { ...ok.source, w: 0 } }), /source size/);
  assert.throws(() => reviveDoc({ ...ok, source: { ...ok.source, h: 'big' } }), /source size/);
  assert.throws(() => reviveDoc({ ...ok, source: { ...ok.source, w: 1e9 } }), /source size/);
});

test('reviveDoc repairs a crop that does not fit or does not parse', () => {
  const base = json(fresh());
  // missing crop -> identity
  assert.deepEqual(reviveDoc({ ...base, crop: undefined }).crop, initialCrop(W, H));
  // rect off the image -> slid back inside, size kept where possible
  const off = reviveDoc({ ...base, crop: { ...base.crop, rect: { x: 1000, y: -500, width: 2000, height: 1000 } } });
  assert.ok(cropFits(off));
  assert.ok(Math.abs(off.crop.rect.width - 2000) < 1e-6 && Math.abs(off.crop.rect.height - 1000) < 1e-6);
  // too big -> shrunk to fit
  const big = reviveDoc({ ...base, crop: { ...base.crop, rect: { x: -5000, y: -5000, width: 10000, height: 10000 } } });
  assert.ok(cropFits(big));
  // an angle beyond the limit is clamped, and the rect shrinks to suit it
  const steep = reviveDoc({ ...base, crop: { ...base.crop, angle: 90 } });
  assert.equal(steep.crop.angle, 45);
  assert.ok(cropFits(steep));
  // junk rect -> largest centred rect
  const junk = reviveDoc({ ...base, crop: { ...base.crop, angle: 5, rect: { x: 0, y: 0, width: NaN, height: 1 } } });
  assert.ok(cropFits(junk));
  assert.ok(Math.abs(junk.crop.rect.width / junk.crop.rect.height - W / H) < 1e-9);
  // quarter and aspect are normalised
  const q = reviveDoc({ ...base, crop: { ...setAspect(initialCrop(W, H), W, H, 'square'), quarter: 5, aspect: 'square' } });
  assert.equal(q.crop.quarter, 1);
  assert.ok(cropFits(q));
  assert.equal(reviveDoc({ ...base, crop: { ...base.crop, quarter: 1.5, aspect: '7:5', flip: 'yes' } }).crop.quarter, 0);
  const odd = reviveDoc({ ...base, crop: { ...base.crop, aspect: '7:5', flip: 'yes', tall: true } }).crop;
  assert.equal(odd.aspect, 'free');
  assert.equal(odd.flip, false);
  assert.deepEqual(Object.keys(odd).sort(), ['angle', 'aspect', 'flip', 'quarter', 'rect']);
});

test('reviveDoc frees a locked aspect whose rect has another shape, keeping the framing', () => {
  const base = json(fresh());
  const rect = { x: -1000, y: -500, width: 2000, height: 1000 }; // 2:1, not 4:5
  const d = reviveDoc({ ...base, crop: { ...base.crop, aspect: '4:5', rect } });
  assert.equal(d.crop.aspect, 'free');
  assert.deepEqual(d.crop.rect, rect);
  // a matching one is left alone
  const sq = setAspect(initialCrop(W, H), W, H, 'square');
  assert.deepEqual(reviveDoc({ ...base, crop: sq }).crop, sq);
});

test('reviveDoc never mutates its input', () => {
  const raw = deepFreeze({ ...json(fresh()), light: { brightness: 900 }, crop: { quarter: 9, rect: { x: 1e6, y: 0, width: 5, height: 5 } } });
  assert.doesNotThrow(() => reviveDoc(raw));
});

// ------------------------------------------------------------------ setIn / getIn

test('setIn copies only the path and shares everything else', () => {
  const d = deepFreeze(fresh());
  const e = setIn(d, ['light', 'brightness'], 18);
  assert.equal(e.light.brightness, 18);
  assert.equal(d.light.brightness, 0);
  assert.notEqual(e, d);
  assert.notEqual(e.light, d.light);
  assert.equal(e.color, d.color);
  assert.equal(e.crop, d.crop);
  assert.equal(e.text, d.text);
  // setting the same value is a no-op by identity
  assert.equal(setIn(d, ['light', 'brightness'], 0), d);
  assert.equal(setIn(d, ['crop', 'rect'], d.crop.rect), d);
  assert.equal(setIn(d, [], 5), 5);
});

test('setIn handles arrays, missing branches and bad paths', () => {
  const d = deepFreeze({ ...fresh(), text: [caption(), caption({ id: 'c2' })] });
  const moved = setIn(d, ['text', 1, 'cx'], 0.25);
  assert.equal(moved.text[1].cx, 0.25);
  assert.equal(moved.text[0], d.text[0]);
  assert.ok(Array.isArray(moved.text));
  const appended = setIn(d, ['text', 2], caption({ id: 'c3' }));
  assert.equal(appended.text.length, 3);
  assert.deepEqual(setIn({}, ['a', 'b'], 1), { a: { b: 1 } });
  assert.deepEqual(setIn(undefined, [0], 'x'), ['x']);
  assert.throws(() => setIn(d, ['text', 5], 1), RangeError);
  assert.throws(() => setIn(d, ['text', 'x'], 1), TypeError);
  assert.throws(() => setIn(d, ['text', -1], 1), RangeError);
  assert.throws(() => setIn(d, ['light', 'brightness', 'x'], 1), TypeError);
  assert.throws(() => setIn(d, 'light.brightness', 1), TypeError);
  assert.throws(() => setIn(d, ['__proto__', 'polluted'], 1), /refusing/);
  assert.throws(() => setIn(d, ['constructor'], 1), /refusing/);
  assert.equal({}.polluted, undefined);
});

test('getIn reads paths and returns undefined for missing ones', () => {
  const d = fresh();
  assert.equal(getIn(d, ['crop', 'rect', 'width']), W);
  assert.equal(getIn(d, ['crop', 'nope', 'width']), undefined);
  assert.equal(getIn(d, ['light', 'brightness', 'x']), undefined);
  assert.equal(getIn(d, ['toString']), undefined);
});

test('deepEqual compares plain data', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1], { 0: 1 }));
  assert.ok(!deepEqual(null, {}));
  assert.ok(deepEqual(0, -0));
});

// ------------------------------------------------------------------ describeChange

const d0 = fresh();
const set = (path, v, doc = d0) => setIn(doc, path, v);

test('describeChange names dial steps with the new value and a true minus sign', () => {
  assert.equal(describeChange(d0, set(['light', 'brightness'], 18)), 'Brightness +18');
  const contrast = describeChange(d0, set(['light', 'contrast'], -12));
  assert.equal(contrast, 'Contrast −12');
  assert.ok(!contrast.includes('-'), 'hyphen-minus is not a minus');
  assert.equal(describeChange(d0, set(['color', 'warmth'], 6)), 'Warmth +6');
  assert.equal(describeChange(set(['light', 'shadows'], 24), d0), 'Shadows 0');
  assert.equal(describeChange(d0, set(['color', 'vividness'], -30)), 'Vividness −30');
  // Softer moves two dials: the bigger move names the step
  let softer = set(['light', 'contrast'], -15);
  softer = set(['light', 'shadows'], 10, softer);
  assert.equal(describeChange(d0, softer), 'Contrast −15');
});

test('describeChange names looks and their strength', () => {
  const film = set(['color', 'look'], 'film');
  assert.equal(describeChange(d0, film), 'Look: Film');
  assert.equal(describeChange(film, set(['color', 'strength'], 60, film)), 'Film strength 60');
  assert.equal(describeChange(film, d0), 'Look: None');
  // tapping a look also resets strength: still named after the look
  const weak = set(['color', 'strength'], 30, film);
  const warm = setIn(weak, ['color'], { ...weak.color, look: 'warm', strength: 100 });
  assert.equal(describeChange(weak, warm), 'Look: Warm');
  assert.equal(describeChange(d0, set(['color', 'strength'], 40)), 'Strength 40');
});

test('describeChange names crop steps by their cause', () => {
  const crop = (fn) => withCrop(d0, fn);
  const four5 = crop((c) => setAspect(c, W, H, '4:5'));
  assert.equal(describeChange(d0, four5), 'Crop 4:5');
  assert.equal(describeChange(four5, withCrop(four5, (c) => setAspect(c, W, H, '5:4'))), 'Crop 5:4');
  assert.equal(describeChange(d0, crop((c) => setAspect(c, W, H, 'square'))), 'Crop Square');
  assert.equal(describeChange(d0, crop((c) => dragHandle(c, W, H, 'se', -300, -200))), 'Crop');
  assert.equal(describeChange(d0, crop((c) => setAngle(c, W, H, 2.8))), 'Straightened 2.8°');
  assert.equal(describeChange(d0, crop((c) => setAngle(c, W, H, -3))), 'Straightened 3°');
  const tilted = crop((c) => setAngle(c, W, H, 4));
  assert.equal(describeChange(tilted, withCrop(tilted, (c) => setAngle(c, W, H, 0))), 'Straighten 0°');
  assert.equal(describeChange(d0, crop((c) => rotateQuarter(c, W, H))), 'Rotated');
  assert.equal(describeChange(four5, withCrop(four5, (c) => rotateQuarter(c, W, H))), 'Rotated');
  assert.equal(describeChange(tilted, withCrop(tilted, flipHorizontal)), 'Flipped');
});

test('describeChange names paint and remove steps', () => {
  assert.equal(describeChange(d0, { ...d0, paint: ['s1'] }), 'Painted light');
  assert.equal(describeChange({ ...d0, paint: ['s1'] }, { ...d0, paint: ['s1', 's2'] }), 'Painted light');
  assert.equal(describeChange({ ...d0, paint: ['s1', 's2'] }, { ...d0, paint: ['s1'] }), 'Removed paint');
  assert.equal(describeChange({ ...d0, paint: ['s1'] }, d0), 'Cleared paint');
  assert.equal(describeChange(d0, { ...d0, remove: ['p1'] }), 'Removed spot');
  assert.equal(describeChange({ ...d0, remove: ['p1'] }, { ...d0, remove: ['p1', 'p2'] }), 'Removed spot');
  assert.equal(describeChange(d0, { ...d0, remove: ['p1', 'p2'] }), 'Removed 2 spots');
  assert.equal(describeChange({ ...d0, remove: ['p1', 'p2'] }, { ...d0, remove: ['p1', 'p3'] }), 'Tried another');
  assert.equal(describeChange({ ...d0, remove: ['p1', 'p2'] }, { ...d0, remove: ['p1'] }), 'Remove');
});

test('describeChange names caption steps', () => {
  const one = { ...d0, text: [caption()] };
  assert.equal(describeChange(d0, one), 'Caption “Hello”');
  assert.equal(describeChange(one, set(['text', 0, 'text'], 'Bye', one)), 'Caption “Bye”');
  assert.equal(describeChange(one, set(['text', 0, 'cx'], 0.3, one)), 'Moved caption');
  assert.equal(describeChange(one, set(['text', 0, 'size'], 0.2, one)), 'Resized caption');
  assert.equal(describeChange(one, set(['text', 0, 'angle'], 12, one)), 'Rotated caption');
  assert.equal(describeChange(one, set(['text', 0, 'style'], 'bold', one)), 'Style: Bold');
  assert.equal(describeChange(one, set(['text', 0, 'color'], '#ffd60a', one)), 'Caption color');
  assert.equal(describeChange(one, d0), 'Deleted caption');
  // pinch: size, angle and position together are a resize
  const pinched = setIn(one, ['text', 0], { ...one.text[0], size: 0.1, angle: 5, cx: 0.4 });
  assert.equal(describeChange(one, pinched), 'Resized caption');
  // long, multi-line, emoji: one line, clipped by code point
  const long = describeChange(d0, { ...d0, text: [caption({ text: 'A very long caption\nthat goes on 😀😀😀' })] });
  assert.equal(long, 'Caption “A very long caption…”');
  const emoji = describeChange(d0, { ...d0, text: [caption({ text: '😀'.repeat(30) })] });
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), 'no lone surrogate');
  assert.equal(describeChange(d0, { ...d0, text: [caption({ text: '   ' })] }), 'Caption');
  const two = { ...d0, text: [caption(), caption({ id: 'c2' })] };
  assert.equal(describeChange(d0, two), 'Edited captions');
  assert.equal(describeChange(two, { ...two, text: [two.text[1], two.text[0]] }), 'Edited captions');
});

test('describeChange clips caption labels by character, never inside a flag or ZWJ emoji', () => {
  // Regression: the cut was by code point, so a flag (2 code points), a skin-toned
  // thumb (2) or a family (5) could be cut in half, leaving a stray letter or person.
  const label = (text) => describeChange(d0, { ...d0, text: [caption({ text })] });
  const flags = '🇯🇵'.repeat(15); // 15 characters, 30 code points: short enough to show whole
  assert.equal(label(flags), `Caption “${flags}”`);
  const family = '👨‍👩‍👧';
  assert.equal(label(family.repeat(25)), `Caption “${family.repeat(19)}…”`);
  const thumbs = '👍🏽'.repeat(21);
  assert.equal(label(thumbs), `Caption “${'👍🏽'.repeat(19)}…”`);
  // exactly 20 characters is not clipped; 21 is
  assert.equal(label('x'.repeat(20)), `Caption “${'x'.repeat(20)}”`);
  assert.equal(label('x'.repeat(21)), `Caption “${'x'.repeat(19)}…”`);
});

test('describeChange falls back to Edit for several groups or none', () => {
  assert.equal(describeChange(d0, d0), 'Edit');
  assert.equal(describeChange(d0, json(d0)), 'Edit');
  const both = set(['color', 'warmth'], 10, set(['light', 'brightness'], 10));
  assert.equal(describeChange(d0, both), 'Edit');
  assert.equal(describeChange(null, d0), 'Edit');
  assert.equal(describeChange(d0, { ...d0, crop: null }), 'Edit');
  // only bookkeeping changed
  assert.equal(describeChange(d0, { ...d0, createdAt: 5 }), 'Edit');
});

// ------------------------------------------------------------------ status

test('changedDials reports the dots, and strength only while a look is on', () => {
  let d = set(['light', 'shadows'], 24);
  d = set(['color', 'strength'], 60, d);
  assert.deepEqual([...changedDials(d)].sort(), ['shadows']);
  d = set(['color', 'look'], 'mono', d);
  assert.deepEqual([...changedDials(d)].sort(), ['shadows', 'strength']);
  d = withCrop(d, (c) => setAngle(c, W, H, -1.5));
  assert.deepEqual([...changedDials(d)].sort(), ['shadows', 'straighten', 'strength']);
});

test('isUnedited follows what the output would show', () => {
  assert.ok(isUnedited(d0));
  assert.ok(!isUnedited(set(['light', 'highlights'], -1)));
  assert.ok(!isUnedited(set(['color', 'tint'], 2)));
  assert.ok(!isUnedited(set(['color', 'look'], 'vivid')));
  assert.ok(isUnedited(set(['color', 'strength'], 0, set(['color', 'look'], 'vivid'))), 'a look at 0 shows nothing');
  assert.ok(isUnedited(set(['color', 'strength'], 40)), 'strength alone shows nothing');
  assert.ok(!isUnedited({ ...d0, paint: ['s'] }));
  assert.ok(!isUnedited({ ...d0, remove: ['p'] }));
  assert.ok(!isUnedited({ ...d0, text: [caption()] }));
  assert.ok(!isUnedited(withCrop(d0, (c) => setAspect(c, W, H, 'square'))));
  assert.ok(!isUnedited(withCrop(d0, flipHorizontal)));
  assert.ok(!isUnedited(withCrop(d0, (c) => rotateQuarter(c, W, H))));
  assert.ok(isUnedited(withCrop(d0, (c) => setAspect(c, W, H, 'original'))), 'Original aspect is the whole photo');
});

// ------------------------------------------------------------------ develop mapping

test('developInput maps the doc onto develop params and look', () => {
  let d = set(['light', 'brightness'], 18);
  d = setIn(d, ['color'], { warmth: -6, tint: 4, vividness: 30, look: 'film', strength: 60 });
  const { adjust, look } = developInput(d);
  assert.deepEqual(Object.keys(adjust).sort(), [...PARAM_KEYS].sort());
  assert.equal(adjust.brightness, 18);
  assert.equal(adjust.vibrance, 30);
  assert.equal(adjust.warmth, -6);
  assert.equal(adjust.tint, 4);
  for (const k of ['exposure', 'blacks', 'whites', 'saturation', 'vignette', 'grain']) assert.equal(adjust[k], 0, k);
  assert.deepEqual(look, { id: 'film', amount: 60 });
  // and develop accepts it: the look moves params by 60% of its recipe
  const r = resolve(adjust, look);
  assert.equal(r.params.brightness, 18);
  assert.ok(r.fade > 0);
});

test('developInput of an unedited doc resolves to the identity', () => {
  const r = resolve(...Object.values(developInput(d0)));
  assert.ok(Object.values(r.params).every((v) => v === 0));
  assert.equal(r.fade, 0);
  assert.equal(r.mono, 0);
});
