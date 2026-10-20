import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLES, SWATCHES, SIZE_MIN, SIZE_MAX, SIZE_DEFAULT, WRAP_FRACTION, LINE_HEIGHT, PAD, EMPTY_WIDTH,
  ANGLE_DETENT_DEG, PLACEHOLDER_TEXT, styleById, newCaption, layoutCaption, captionPaint, captionMatrix,
  captionBounds, hitCaption, snapPosition, cornerHandle, applyHandleDrag, applyPinch,
} from '../lib/text-layout.js';
import { DEFAULTS, TEXT_STYLES, dialById } from '../lib/doc.js';
import { apply, invert } from '../lib/geometry.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const pxOf = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
// A fake monospace font: every code point is half an em wide.
const mono = (text, font) => Array.from(text).length * pxOf(font) * 0.5;
const cap = (over = {}) => ({ ...newCaption('c1'), text: 'Hello', ...over });

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ------------------------------------------------------------------ styles and defaults

test('six styles in Quick-row order, matching the ids lib/doc.js accepts', () => {
  assert.deepEqual(STYLES.map((s) => s.id), [...TEXT_STYLES]);
  assert.deepEqual(STYLES.map((s) => s.label), ['Classic', 'Bold', 'Box', 'Serif', 'Mono', 'Round']);
  assert.ok(Object.isFrozen(STYLES) && STYLES.every(Object.isFrozen));
  for (const s of STYLES) {
    assert.equal(typeof s.family, 'string');
    assert.ok(Number.isInteger(s.weight) && s.weight >= 100 && s.weight <= 900, s.id);
    assert.equal(typeof s.box, 'boolean');
    assert.equal(typeof s.shadow, 'boolean');
  }
});

test('style fonts use the §8 system stacks with fallbacks', () => {
  assert.match(styleById('classic').family, /^system-ui\b/);
  assert.match(styleById('serif').family, /^ui-serif, "New York", Georgia, serif$/);
  assert.match(styleById('round').family, /^ui-rounded, system-ui\b/);
  assert.match(styleById('mono').family, /^ui-monospace, "SF Mono", Menlo, monospace$/);
  assert.ok(styleById('bold').weight > styleById('classic').weight);
  // Only Box draws a box, and it needs no shadow.
  assert.deepEqual(STYLES.filter((s) => s.box).map((s) => s.id), ['box']);
  assert.equal(styleById('box').shadow, false);
  assert.ok(STYLES.filter((s) => !s.box).every((s) => s.shadow));
});

test('styleById falls back to Classic for unknown or missing ids', () => {
  assert.equal(styleById('nope').id, 'classic');
  assert.equal(styleById(undefined).id, 'classic');
  assert.equal(styleById('__proto__').id, 'classic');
  assert.equal(styleById('mono').id, 'mono');
});

test('eight swatches, white first, as hex', () => {
  assert.deepEqual(SWATCHES.map((s) => s.id), ['white', 'black', 'yellow', 'orange', 'red', 'pink', 'blue', 'green']);
  assert.equal(SWATCHES[0].hex, '#ffffff');
  assert.equal(SWATCHES[1].hex, '#000000');
  for (const s of SWATCHES) assert.match(s.hex, /^#[0-9a-f]{6}$/);
  assert.equal(new Set(SWATCHES.map((s) => s.hex)).size, 8);
  assert.ok(Object.isFrozen(SWATCHES) && SWATCHES.every(Object.isFrozen));
});

test('newCaption is the §F11 default and matches lib/doc.js', () => {
  const c = newCaption('cap-7');
  assert.deepEqual(c, { id: 'cap-7', text: 'Your words', style: 'classic', color: '#ffffff', cx: 0.5, cy: 0.78, size: 0.08, angle: 0 });
  const { id, ...rest } = c;
  assert.equal(id, 'cap-7');
  assert.deepEqual(rest, { ...DEFAULTS.caption });
  // The edit bar selects 0..10, the whole placeholder.
  assert.equal(PLACEHOLDER_TEXT.length, 10);
  assert.notEqual(newCaption('a'), newCaption('a'), 'a fresh object every time');
});

test('size range and default match the textSize dial', () => {
  const d = dialById('textSize');
  assert.equal(SIZE_MIN, d.min);
  assert.equal(SIZE_MAX, d.max);
  assert.equal(SIZE_DEFAULT, d.def);
});

// ------------------------------------------------------------------ layoutCaption

test('a short caption is one line with the box around it', () => {
  const L = layoutCaption(cap({ size: 0.1 }), 1000, 800, mono);
  assert.deepEqual(L.lines, ['Hello']);
  assert.equal(L.fontPx, 80); // 0.1 x short side 800
  assert.equal(L.font, `600 80px ${styleById('classic').family}`);
  assert.deepEqual(L.lineWidths, [200]);
  assert.equal(L.pad, 80 * PAD);
  assert.equal(L.lineHeight, 80 * LINE_HEIGHT);
  assert.equal(L.boxW, 200 + 2 * L.pad);
  assert.equal(L.boxH, L.lineHeight + 2 * L.pad);
  assert.equal(L.style, 'classic');
  assert.equal(L.empty, false);
  assert.ok(L.radius > 0);
});

test('font size follows the short side, in either orientation', () => {
  assert.equal(layoutCaption(cap(), 3000, 4000, mono).fontPx, 240);
  assert.equal(layoutCaption(cap(), 4000, 3000, mono).fontPx, 240);
});

test('the measurer sees the exact font string, and each style its own font', () => {
  for (const s of STYLES) {
    const seen = new Set();
    const L = layoutCaption(cap({ style: s.id, text: 'one two' }), 1000, 1000, (t, f) => { seen.add(f); return mono(t, f); });
    assert.deepEqual([...seen], [L.font]);
    assert.equal(L.font, `${s.weight} 80px ${s.family}`);
  }
});

test('words wrap greedily so the box stays within 85% of the output width', () => {
  const text = 'the quick brown fox jumps over the lazy dog and keeps on running far away';
  const outW = 1000, outH = 1000;
  const L = layoutCaption(cap({ text, size: 0.08 }), outW, outH, mono);
  const limit = outW * WRAP_FRACTION - 2 * L.pad;
  assert.ok(L.lines.length > 1);
  assert.equal(L.lines.join(' '), text, 'no word lost, reordered or split');
  for (const [i, line] of L.lines.entries()) {
    assert.ok(L.lineWidths[i] <= limit, `line ${i} fits`);
    assert.equal(L.lineWidths[i], mono(line, L.font));
    // Greedy: the next word would not have fitted on this line.
    const next = L.lines[i + 1]?.split(' ')[0];
    if (next) assert.ok(mono(`${line} ${next}`, L.font) > limit);
  }
  assert.ok(L.boxW <= outW * WRAP_FRACTION + 1e-9);
  assert.equal(L.boxW, Math.max(...L.lineWidths) + 2 * L.pad);
  assert.ok(near(L.boxH, L.lines.length * L.lineHeight + 2 * L.pad));
});

test('typed newlines are kept, including blank lines and CRLF', () => {
  const L = layoutCaption(cap({ text: 'top\n\nbottom\r\nend\rlast' }), 1000, 1000, mono);
  assert.deepEqual(L.lines, ['top', '', 'bottom', 'end', 'last']);
  assert.equal(L.lineWidths[1], 0);
  assert.ok(near(L.boxH, 5 * L.lineHeight + 2 * L.pad));
  const trailing = layoutCaption(cap({ text: 'abc\n' }), 1000, 1000, mono);
  assert.deepEqual(trailing.lines, ['abc', ''], 'a fresh line shows while typing');
});

test('runs of spaces collapse and line-end spaces vanish (pre-line)', () => {
  const L = layoutCaption(cap({ text: '  a   b\t c  ' }), 1000, 1000, mono);
  assert.deepEqual(L.lines, ['a b c']);
  // No-break spaces hold words together instead.
  const nb = layoutCaption(cap({ text: 'a b' }), 1000, 1000, mono);
  assert.deepEqual(nb.lines, ['a b']);
});

test('an empty caption still has a box to see and grab', () => {
  for (const text of ['', '   ', '\n', undefined, null, 42]) {
    const L = layoutCaption(cap({ text }), 1000, 1000, mono);
    assert.equal(L.empty, true, String(text));
    assert.ok(L.lines.length >= 1 && L.lines.every((l) => l === ''));
    assert.equal(L.boxW, EMPTY_WIDTH * L.fontPx + 2 * L.pad);
    assert.ok(L.boxH > 0);
  }
  assert.equal(layoutCaption(cap({ text: '\n' }), 1000, 1000, mono).lines.length, 2);
});

test('a word longer than a line breaks between characters', () => {
  const word = 'x'.repeat(100);
  const L = layoutCaption(cap({ text: `go ${word} now`, size: 0.1 }), 1000, 1000, mono);
  const limit = 1000 * WRAP_FRACTION - 2 * L.pad;
  assert.equal(L.lines.join('').replace(/ /g, ''), `go${word}now`);
  for (const w of L.lineWidths) assert.ok(w <= limit);
  assert.equal(L.lines[0], 'go', 'the long word starts its own line');
  assert.ok(L.lines.length >= 3);
});

test('forced breaks never split a grapheme (flags, ZWJ emoji)', () => {
  const flags = '🇫🇷'.repeat(40);
  const L = layoutCaption(cap({ text: flags, size: 0.1 }), 1000, 1000, mono);
  assert.ok(L.lines.length > 1);
  assert.equal(L.lines.join(''), flags);
  for (const line of L.lines) assert.match(line, /^(?:🇫🇷)+$/u);
  const family = '👩‍👩‍👧‍👦'.repeat(20);
  const F = layoutCaption(cap({ text: family, size: 0.1 }), 1000, 1000, mono);
  assert.ok(F.lines.length > 1);
  for (const line of F.lines) assert.match(line, /^(?:👩‍👩‍👧‍👦)+$/u);
});

test('a huge paste lays out without blowing the stack', () => {
  const lines = layoutCaption(cap({ text: 'w\n'.repeat(300000) }), 1000, 1000, mono);
  assert.equal(lines.lines.length, 300001);
  const word = layoutCaption(cap({ text: 'x'.repeat(300000), size: 0.3 }), 100, 100, mono);
  assert.equal(word.lines.join(''), 'x'.repeat(300000));
  assert.ok(word.lines.length > 1000);
});

test('a glyph wider than any line still makes progress', () => {
  const huge = (t) => Array.from(t).length * 1e6;
  const L = layoutCaption(cap({ text: 'abc de' }), 100, 100, huge);
  assert.deepEqual(L.lines, ['a', 'b', 'c', 'd', 'e']);
});

test('a tall, narrow output wraps within its own width', () => {
  const L = layoutCaption(cap({ text: 'abcdefgh', size: 0.3 }), 50, 2000, mono);
  // fontPx 15 (short side 50), pad 4.5, so lines up to 33.5 px: four glyphs
  assert.equal(L.fontPx, 15);
  assert.deepEqual(L.lines, ['abcd', 'efgh']);
  assert.ok(L.boxW <= 50 * WRAP_FRACTION);
});

test('size is clamped to the dial range and bad values use the default', () => {
  assert.equal(layoutCaption(cap({ size: 5 }), 1000, 1000, mono).fontPx, 300);
  assert.equal(layoutCaption(cap({ size: 0.001 }), 1000, 1000, mono).fontPx, 30);
  for (const size of [NaN, -1, 0, undefined, '0.2']) {
    assert.equal(layoutCaption(cap({ size }), 1000, 1000, mono).fontPx, 80, String(size));
  }
  assert.equal(layoutCaption(cap({ style: 'nope' }), 1000, 1000, mono).style, 'classic');
  // Tiny outputs never give a zero font.
  assert.equal(layoutCaption(cap(), 1, 1, mono).fontPx, 1);
});

test('font px is rounded so the font string stays tidy', () => {
  const L = layoutCaption(cap({ size: 0.08 }), 3024, 4032, mono); // 241.92000000000002
  assert.equal(L.fontPx, 241.92);
  assert.match(L.font, / 241\.92px /);
});

test('a broken measurer cannot break the layout', () => {
  for (const bad of [() => NaN, () => -5, () => Infinity, () => undefined, () => 'wide']) {
    const L = layoutCaption(cap({ text: 'hello there' }), 1000, 1000, bad);
    assert.ok(Number.isFinite(L.boxW) && L.boxW > 0);
    assert.ok(Number.isFinite(L.boxH) && L.boxH > 0);
  }
  // No measurer at all: a rough estimate, still a sensible box.
  const est = layoutCaption(cap({ text: 'hello' }), 1000, 1000);
  assert.ok(est.boxW > 2 * est.pad && est.boxW < 1000);
});

test('a caption with words is never flagged empty, even when nothing measures', () => {
  // Regression: `empty` used to mean "widest line measured 0", so a failing
  // measurer (or ink-less text) made the UI draw the placeholder over real words.
  for (const [text, measure] of [['hello there', () => NaN], ['hello', () => 0], ['​', mono], ['​', () => 0]]) {
    const L = layoutCaption(cap({ text }), 1000, 1000, measure);
    assert.equal(L.empty, false, JSON.stringify(text));
    assert.ok(L.lines.some((l) => l !== ''));
    if (L.lineWidths.every((w) => w === 0)) assert.equal(L.boxW, EMPTY_WIDTH * L.fontPx + 2 * L.pad, 'still a box to grab');
  }
  assert.equal(layoutCaption(cap({ text: ' \n\t ' }), 1000, 1000, () => NaN).empty, true);
});

test('layout depends only on the words, style, size and output size', () => {
  const a = layoutCaption(cap({ cx: 0.1, cy: 0.9, angle: 30, color: '#000000' }), 1200, 900, mono);
  const b = layoutCaption(cap(), 1200, 900, mono);
  assert.deepEqual(a, b);
});

test('laying out at twice the output size doubles everything (preview = export)', () => {
  const text = 'a caption long enough that it has to wrap onto more lines than one';
  const s = layoutCaption(cap({ text, size: 0.1 }), 1000, 800, mono);
  const l = layoutCaption(cap({ text, size: 0.1 }), 2000, 1600, mono);
  assert.deepEqual(l.lines, s.lines);
  assert.ok(near(l.boxW, 2 * s.boxW) && near(l.boxH, 2 * s.boxH));
});

test('layout is deterministic and never mutates the caption', () => {
  const c = deepFreeze(cap({ text: 'freeze me please, all of me' }));
  assert.deepEqual(layoutCaption(c, 640, 480, mono), layoutCaption(c, 640, 480, mono));
});

test('layout rejects an unusable output size', () => {
  for (const [w, h] of [[0, 100], [100, -1], [NaN, 100], [Infinity, 100]]) {
    assert.throws(() => layoutCaption(cap(), w, h, mono), RangeError);
  }
});

// ------------------------------------------------------------------ captionPaint

test('captionPaint: plain styles paint the colour with a shadow', () => {
  const L = layoutCaption(cap(), 1000, 1000, mono);
  const p = captionPaint(cap(), L);
  assert.equal(p.ink, '#ffffff');
  assert.equal(p.box, null);
  assert.match(p.shadow.color, /^rgba\(0, 0, 0/);
  assert.ok(p.shadow.blur > 0 && p.shadow.offsetY > 0);
  // Black words would vanish into a black shadow: they get a light halo.
  assert.match(captionPaint(cap({ color: '#000' }), L).shadow.color, /^rgba\(255, 255, 255/);
});

test('captionPaint: Box fills with the colour and picks readable words', () => {
  const L = layoutCaption(cap({ style: 'box' }), 1000, 1000, mono);
  const ink = (hex) => captionPaint(cap({ style: 'box', color: hex }), L).ink;
  const byId = Object.fromEntries(SWATCHES.map((s) => [s.id, ink(s.hex)]));
  assert.deepEqual(byId, {
    white: '#000000', black: '#ffffff', yellow: '#000000', orange: '#000000',
    red: '#ffffff', pink: '#ffffff', blue: '#ffffff', green: '#000000',
  });
  const p = captionPaint(cap({ style: 'box', color: '#ff453a' }), L);
  assert.equal(p.box, '#ff453a');
  assert.equal(p.shadow, null);
});

test('captionPaint copes with names, short hex and junk colours', () => {
  const L = layoutCaption(cap({ style: 'box' }), 1000, 1000, mono);
  const ink = (color) => captionPaint(cap({ style: 'box', color }), L).ink;
  assert.equal(ink('black'), '#ffffff');
  assert.equal(ink('WHITE'), '#000000');
  assert.equal(ink('#000'), '#ffffff');
  assert.equal(ink('#000f'), '#ffffff');
  assert.equal(ink('#000000ff'), '#ffffff');
  for (const junk of ['constructor', '__proto__', 'tomato', '#12', '#zzzzzz', '']) {
    assert.doesNotThrow(() => ink(junk), junk);
  }
  assert.equal(captionPaint(cap({ color: undefined }), L).ink, '#ffffff');
  assert.doesNotThrow(() => captionPaint(cap(), undefined));
});

test('captionPaint scales the shadow to the drawing context (canvas shadows ignore the transform)', () => {
  // Regression: the shadow was always in output px. A stage preview draws the
  // layout through setTransform(scale), which canvas does not apply to shadowBlur
  // or shadowOffset, so the preview showed a shadow `1 / scale` times too big.
  const L = layoutCaption(cap({ size: 0.1 }), 4000, 3000, mono); // fontPx 300
  const full = captionPaint(cap(), L);
  assert.equal(full.shadow.blur, 300 * 0.12);
  assert.equal(full.shadow.offsetY, 300 * 0.04);
  assert.deepEqual(captionPaint(cap(), L, 1), full, 'scale 1 is the export raster');
  const preview = captionPaint(cap(), L, 0.25);
  assert.ok(near(preview.shadow.blur, full.shadow.blur * 0.25));
  assert.ok(near(preview.shadow.offsetY, full.shadow.offsetY * 0.25));
  assert.equal(preview.shadow.offsetX, 0);
  assert.equal(preview.shadow.color, full.shadow.color);
  assert.equal(preview.ink, full.ink);
  for (const bad of [0, -2, NaN, Infinity, undefined, '2']) {
    assert.deepEqual(captionPaint(cap(), L, bad), full, String(bad));
  }
  assert.equal(captionPaint(cap({ style: 'box' }), L, 0.5).shadow, null);
  assert.equal(captionPaint(cap(), { fontPx: Infinity }).shadow.blur, 0);
});

// ------------------------------------------------------------------ captionMatrix

const box = { boxW: 200, boxH: 60 };

test('captionMatrix centres the box on (cx, cy) of the output', () => {
  const m = captionMatrix(cap({ cx: 0.25, cy: 0.75 }), box, 1000, 800);
  assert.deepEqual(m, [1, 0, -0, 1, 150, 570]);
  assert.deepEqual(apply(m, 100, 30), [250, 600]);
});

test('captionMatrix turns clockwise about the centre, exactly at quarter turns', () => {
  const m = captionMatrix(cap({ angle: 90 }), box, 1000, 1000);
  const X = 500, Y = 780;
  assert.deepEqual(apply(m, 100, 30), [X, Y]);
  assert.deepEqual(apply(m, 0, 0), [X + 30, Y - 100]);
  assert.deepEqual(apply(m, 200, 30), [X, Y + 100], 'the right end points down');
  const flipped = captionMatrix(cap({ angle: 180 }), box, 1000, 1000);
  assert.deepEqual(apply(flipped, 0, 0), [X + 100, Y + 30]);
  const ccw = captionMatrix(cap({ angle: -90 }), box, 1000, 1000);
  assert.deepEqual(apply(ccw, 200, 30), [X, Y - 100]);
});

test('captionMatrix is a rigid motion that keeps the centre fixed', () => {
  for (const angle of [-170, -33.3, 12, 45, 135]) {
    const c = cap({ angle, cx: 0.3, cy: 0.6 });
    const m = captionMatrix(c, box, 1200, 900);
    const [x, y] = apply(m, 100, 30);
    assert.ok(near(x, 360, 1e-9) && near(y, 540, 1e-9));
    const [ax, ay] = apply(m, 0, 0), [bx, by] = apply(m, 200, 0);
    assert.ok(near(Math.hypot(bx - ax, by - ay), 200, 1e-9));
    // Positive angles turn clockwise on a y-down screen: the right end drops.
    const [, ry] = apply(m, 200, 30);
    assert.equal(Math.sign(ry - 540), Math.sign(Math.sin((angle * Math.PI) / 180)));
    const back = apply(invert(m), x, y);
    assert.ok(near(back[0], 100, 1e-9) && near(back[1], 30, 1e-9));
  }
});

test('captionMatrix tolerates missing numbers on the caption', () => {
  const m = captionMatrix({ id: 'x' }, box, 1000, 1000);
  assert.deepEqual(apply(m, 100, 30), [500, 500]);
  assert.ok(m.every(Number.isFinite));
  assert.throws(() => captionMatrix(cap(), box, 0, 10), RangeError);
});

test('captionBounds is the box when upright and swaps at a quarter turn', () => {
  assert.deepEqual(captionBounds(cap(), box, 1000, 1000), { x: 400, y: 750, width: 200, height: 60 });
  assert.deepEqual(captionBounds(cap({ angle: 90 }), box, 1000, 1000), { x: 470, y: 680, width: 60, height: 200 });
  const t = captionBounds(cap({ angle: 30 }), box, 1000, 1000);
  assert.ok(t.width > 60 && t.width < 260 && t.height > 60);
});

// ------------------------------------------------------------------ hitCaption

test('hitCaption hits inside the box, misses outside, with slop for near misses', () => {
  const c = cap({ id: 'a' });
  // box centred at (500, 780), 200 x 60
  assert.equal(hitCaption([c], [box], 500, 780, 1000, 1000), 'a');
  assert.equal(hitCaption([c], [box], 599, 809, 1000, 1000), 'a');
  assert.equal(hitCaption([c], [box], 610, 780, 1000, 1000), 'a', 'within the default 12 px slop');
  assert.equal(hitCaption([c], [box], 613, 780, 1000, 1000), null);
  assert.equal(hitCaption([c], [box], 610, 780, 1000, 1000, 0), null);
  assert.equal(hitCaption([c], [box], 640, 780, 1000, 1000, 40), 'a');
  for (const slop of [NaN, -5]) assert.equal(hitCaption([c], [box], 601, 780, 1000, 1000, slop), null);
});

test('hitCaption follows the caption when it is turned', () => {
  const c = cap({ id: 'a', angle: 90 });
  // Turned upright: 60 wide, 200 tall around (500, 780).
  assert.equal(hitCaption([c], [box], 500, 870, 1000, 1000, 0), 'a');
  assert.equal(hitCaption([c], [box], 590, 780, 1000, 1000, 0), null);
  const d = cap({ id: 'd', angle: 45 });
  const along = 90 / Math.SQRT2;
  assert.equal(hitCaption([d], [box], 500 + along, 780 + along, 1000, 1000, 0), 'd');
  assert.equal(hitCaption([d], [box], 500 + along, 780 - along, 1000, 1000, 0), null);
});

test('hitCaption prefers the topmost, but a direct hit beats a near miss', () => {
  const lower = cap({ id: 'lower' });
  const upper = cap({ id: 'upper' });
  assert.equal(hitCaption([lower, upper], [box, box], 500, 780, 1000, 1000), 'upper');
  // Upper sits just right of lower: a touch inside lower but in upper's slop.
  const right = cap({ id: 'right', cx: 0.705 }); // box spans 605..805
  assert.equal(hitCaption([lower, right], [box, box], 597, 780, 1000, 1000), 'lower');
  assert.equal(hitCaption([lower, right], [box, box], 603, 780, 1000, 1000), 'right');
});

test('hitCaption takes layouts as an array, a Map or an object by id', () => {
  const a = cap({ id: 'a' }), b = cap({ id: 'b', cy: 0.2 });
  const at = (layouts) => [hitCaption([a, b], layouts, 500, 780, 1000, 1000), hitCaption([a, b], layouts, 500, 200, 1000, 1000)];
  assert.deepEqual(at([box, box]), ['a', 'b']);
  assert.deepEqual(at(new Map([['a', box], ['b', box]])), ['a', 'b']);
  assert.deepEqual(at({ a: box, b: box }), ['a', 'b']);
  assert.deepEqual(at({ a: box }), ['a', null], 'a caption without a layout cannot be hit');
  assert.deepEqual(at([box, { boxW: NaN, boxH: 1 }]), ['a', null]);
});

test('hitCaption with nothing to hit', () => {
  assert.equal(hitCaption([], [], 1, 1, 10, 10), null);
  assert.equal(hitCaption(null, null, 1, 1, 10, 10), null);
  assert.equal(hitCaption([cap()], [box], NaN, 780, 1000, 1000), null);
  assert.equal(hitCaption([null, cap({ id: 'z' })], [box, box], 500, 780, 1000, 1000), 'z');
  assert.equal(hitCaption([cap()], null, 500, 780, 1000, 1000), null);
});

test('hitCaption agrees with captionMatrix for real layouts', () => {
  const c = cap({ id: 'r', text: 'turn and hit', angle: -27, cx: 0.4, cy: 0.35 });
  const L = layoutCaption(c, 1600, 1200, mono);
  const m = captionMatrix(c, L, 1600, 1200);
  for (const [u, v, hit] of [[0.5, 0.5, true], [0.02, 0.05, true], [0.98, 0.95, true], [1.2, 0.5, false], [0.5, -0.3, false]]) {
    const [x, y] = apply(m, u * L.boxW, v * L.boxH);
    assert.equal(hitCaption([c], [L], x, y, 1600, 1200, 0), hit ? 'r' : null, `${u},${v}`);
  }
});

// ------------------------------------------------------------------ snapPosition

test('snapPosition snaps each axis to the centre and the thirds, with guides', () => {
  assert.deepEqual(snapPosition(0.51, 0.5), { cx: 0.5, cy: 0.5, guides: [{ axis: 'x', at: 0.5 }, { axis: 'y', at: 0.5 }] });
  assert.deepEqual(snapPosition(0.32, 0.68), { cx: 1 / 3, cy: 2 / 3, guides: [{ axis: 'x', at: 1 / 3 }, { axis: 'y', at: 2 / 3 }] });
  assert.deepEqual(snapPosition(0.4, 0.78), { cx: 0.4, cy: 0.78, guides: [] });
  assert.deepEqual(snapPosition(0.49, 0.9), { cx: 0.5, cy: 0.9, guides: [{ axis: 'x', at: 0.5 }] });
});

test('snapPosition threshold is inclusive and adjustable', () => {
  assert.equal(snapPosition(0.52, 0.1).cx, 0.5);
  assert.equal(snapPosition(0.5201, 0.1).cx, 0.5201);
  assert.equal(snapPosition(0.45, 0.1, 0.06).cx, 0.5);
  assert.equal(snapPosition(0.45, 0.1, 0).cx, 0.45);
  assert.equal(snapPosition(0.5, 0.1, 0).cx, 0.5);
  for (const t of [NaN, -1]) assert.deepEqual(snapPosition(0.49, 0.1, t).guides, []);
  // A huge threshold picks the nearest target, never a farther one.
  assert.equal(snapPosition(0.6, 0.1, 1).cx, 2 / 3);
  assert.equal(snapPosition(0.45, 0.1, 1).cx, 0.5);
});

test('snapPosition keeps the centre on the photo', () => {
  assert.deepEqual(snapPosition(-0.3, 1.7), { cx: 0, cy: 1, guides: [] });
  const bad = snapPosition(NaN, Infinity);
  assert.equal(bad.cx, 0.5, 'NaN has no side, so it goes to the middle');
  assert.equal(bad.cy, 1);
  assert.equal(snapPosition(undefined, -Infinity).cy, 0);
  assert.equal(snapPosition('0.4', 0.1).cx, 0.5);
});

// ------------------------------------------------------------------ handle drag

test('cornerHandle is the bottom-right corner of the turned box', () => {
  assert.deepEqual(cornerHandle(cap(), box, 1000, 1000), { x: 600, y: 810 });
  assert.deepEqual(cornerHandle(cap({ angle: 90 }), box, 1000, 1000), { x: 470, y: 880 });
  assert.deepEqual(cornerHandle(cap({ angle: 180 }), box, 1000, 1000), { x: 400, y: 750 });
});

const C = [500, 780]; // centre of cap() on a 1000 x 1000 output
const around = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)];
};

test('dragging the handle away from the centre scales the caption', () => {
  const c = cap({ size: 0.1 });
  const from = { x: 600, y: 810 };
  const twice = applyHandleDrag(c, box, 1000, 1000, from, { x: 700, y: 840 });
  assert.equal(twice.size, 0.2);
  assert.equal(twice.angle, 0);
  const half = applyHandleDrag(c, box, 1000, 1000, from, { x: 550, y: 795 });
  assert.equal(half.size, 0.05);
  assert.equal(c.size, 0.1, 'input untouched');
});

test('size from a handle drag is clamped to the dial range', () => {
  const c = cap({ size: 0.1 });
  assert.equal(applyHandleDrag(c, box, 1000, 1000, [600, 810], [1500, 1080]).size, SIZE_MAX);
  assert.equal(applyHandleDrag(c, box, 1000, 1000, [600, 810], [502, 780.6]).size, SIZE_MIN);
});

test('turning the finger about the centre turns the caption', () => {
  const c = cap({ angle: 10 });
  const r = applyHandleDrag(c, box, 1000, 1000, around(20, 150), around(65, 150));
  assert.equal(r.angle, 55);
  assert.equal(r.size, c.size);
  const back = applyHandleDrag(c, box, 1000, 1000, around(20, 150), around(-40, 150));
  assert.equal(back.angle, -50);
});

test('angle detents at 0 and ±90 within 3 degrees, not at 180', () => {
  const at = (start, turn) => applyHandleDrag(cap({ angle: start }), box, 1000, 1000, around(30, 150), around(30 + turn, 150)).angle;
  assert.equal(at(10, -8), 0);
  assert.equal(at(10, -13), 0, 'exactly 3 degrees still snaps');
  assert.equal(at(10, -13.5), -3.5);
  assert.equal(at(80, 8), 90);
  assert.equal(at(80, 13.5), 93.5);
  assert.equal(at(-80, -12), -90);
  assert.equal(at(178, 0), 178);
  assert.equal(ANGLE_DETENT_DEG, 3);
});

test('angles wrap into (-180, 180]', () => {
  const at = (start, turn) => applyHandleDrag(cap({ angle: start }), box, 1000, 1000, around(0, 150), around(turn, 150)).angle;
  assert.equal(at(170, 20), -170);
  assert.equal(at(-170, -20), 170);
  assert.equal(at(170, 10), 180);
  assert.equal(at(-175, -5), 180);
});

test('a no-op gesture keeps a stored -180 rather than rewriting it as 180', () => {
  const c = cap({ angle: -180, size: 0.1 });
  assert.equal(applyPinch(c, 1, 0), c);
  assert.equal(applyHandleDrag(c, box, 1000, 1000, [600, 810], [600, 810]), c);
  const bigger = applyPinch(c, 2, 0);
  assert.equal(bigger.size, 0.2);
  assert.equal(bigger.angle, -180, 'only the size changed');
  assert.equal(applyPinch(c, 1, Math.PI / 18).angle, -170);
});

test('the drag is absolute: same start and finger, same result, no drift', () => {
  const c = deepFreeze(cap({ size: 0.12, angle: 20 }));
  const from = around(40, 120), to = around(75, 180);
  const a = applyHandleDrag(c, box, 1000, 1000, from, to);
  const b = applyHandleDrag(c, box, 1000, 1000, from, to);
  assert.deepEqual(a, b);
  assert.equal(a.size, 0.18);
  assert.equal(a.angle, 55);
  assert.deepEqual(Object.keys(a), Object.keys(c), 'same fields, nothing extra');
});

test('fromXY null starts from the handle itself', () => {
  const c = cap({ size: 0.1 });
  const h = cornerHandle(c, box, 1000, 1000);
  const r = applyHandleDrag(c, box, 1000, 1000, null, { x: 2 * h.x - 500, y: 2 * h.y - 780 });
  assert.equal(r.size, 0.2);
  assert.equal(r.angle, 0);
  assert.equal(applyHandleDrag(c, null, 1000, 1000, null, { x: 1, y: 1 }), c);
});

test('degenerate drags change nothing or only shrink', () => {
  const c = cap({ size: 0.1, angle: 40 });
  assert.equal(applyHandleDrag(c, box, 1000, 1000, C, [900, 900]), c, 'starting on the centre');
  assert.equal(applyHandleDrag(c, box, 1000, 1000, [600, 810], null), c);
  assert.equal(applyHandleDrag(c, box, 1000, 1000, [600, 810], [NaN, 3]), c);
  assert.equal(applyHandleDrag(c, box, 1000, 1000, [600, 810], [600, 810]), c, 'no movement: same object');
  const toCentre = applyHandleDrag(c, box, 1000, 1000, [600, 810], C);
  assert.equal(toCentre.size, SIZE_MIN);
  assert.equal(toCentre.angle, 40, 'no direction at the centre, so no turn');
});

// ------------------------------------------------------------------ pinch

test('applyPinch scales and twists from the caption at pinch start', () => {
  const c = cap({ size: 0.1, angle: 10 });
  const r = applyPinch(c, 1.5, Math.PI / 4);
  assert.equal(r.size, 0.15);
  assert.equal(r.angle, 55);
  assert.equal(applyPinch(c, 10, 0).size, SIZE_MAX);
  assert.equal(applyPinch(c, 0.01, 0).size, SIZE_MIN);
  assert.equal(applyPinch(c, 1, (-12 * Math.PI) / 180).angle, 0, 'detent');
  assert.equal(applyPinch(c, 1, Math.PI * 2).angle, 10, 'a full turn comes back round');
  assert.equal(applyPinch(cap({ angle: 170 }), 1, Math.PI / 9).angle, -170);
});

test('a gesture leaves the value it did not move exactly as stored', () => {
  // Regression: every gesture rounded both fields, so on a caption whose size or
  // angle was off the 4-decimal / 0.1° grid (an imported or older record) a pure
  // twist also "resized" it (labelled "Resized caption") and a no-op pinch was
  // not the identity.
  const odd = cap({ size: 0.123456, angle: 12.34 });
  assert.equal(applyPinch(odd, 1, 0), odd, 'no-op: same object');
  const twisted = applyPinch(odd, 1, Math.PI / 6);
  assert.equal(twisted.size, 0.123456, 'a pure twist keeps the size');
  assert.equal(twisted.angle, 42.3);
  const grown = applyPinch(odd, 1.5, 0);
  assert.equal(grown.angle, 12.34, 'a pure resize keeps the angle');
  assert.equal(grown.size, 0.1852);
  // A handle drag round a circle: float noise in r1 / r0 is not a resize.
  const h = applyHandleDrag(odd, box, 1000, 1000, around(10, 150), around(40, 150));
  assert.equal(h.size, 0.123456);
  assert.equal(h.angle, 42.3);
  // A detent still claims an unmoved angle on a pure resize.
  assert.equal(applyPinch(cap({ size: 0.1, angle: 2 }), 2, 0).angle, 0);
  assert.equal(applyPinch(cap({ size: 0.1, angle: -88.5 }), 2, 0).angle, -90);
});

test('a gesture repairs a stored size or angle that is not a number', () => {
  // Regression: a NaN or missing angle compared equal to 0 and was kept, so the
  // caption came out of the gesture still holding NaN.
  for (const angle of [NaN, undefined, Infinity, '30']) {
    const c = cap({ size: 0.1, angle });
    const still = applyPinch(c, 1, 0);
    assert.notEqual(still, c, String(angle));
    assert.equal(still.angle, 0, String(angle));
    assert.equal(applyPinch(c, 2, 0).angle, 0);
    assert.equal(applyPinch(c, 1, Math.PI / 4).angle, 45);
  }
  // An out-of-range stored angle comes back normalized, never as stored.
  assert.equal(applyPinch(cap({ size: 0.1, angle: 540 }), 1, 0).angle, 180);
  assert.equal(applyPinch(cap({ size: 0.1, angle: -200 }), 2, 0).angle, 160);
  assert.equal(applyPinch(cap({ size: 0.1, angle: 180 }), 1, 0).angle, 180);
  for (const size of [NaN, undefined, -1, 0.5]) {
    const r = applyPinch(cap({ size, angle: 10 }), 1, 0);
    assert.ok(Number.isFinite(r.size) && r.size >= SIZE_MIN && r.size <= SIZE_MAX, String(size));
    assert.equal(r.angle, 10);
  }
});

test('applyPinch ignores unusable numbers', () => {
  const c = cap({ size: 0.1, angle: 33 });
  for (const [s, r] of [[NaN, NaN], [0, 0], [-2, Infinity], [1, 0]]) {
    assert.equal(applyPinch(c, s, r), c, `${s}, ${r}`);
  }
});
