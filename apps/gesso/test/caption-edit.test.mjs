import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAPTION_CHARS, EDIT_BAR_H, clipCaptionText, findCaption, withCaption, withoutCaption, updateCaption,
  freeSpot, moveCaption, snapThreshold, editSelection, editBarTop, isKeyboardUp, stageShift, captionId,
  handleWins,
} from '../lib/caption-edit.js';
import { newCaption, PLACEHOLDER_TEXT } from '../lib/text-layout.js';
import { createDoc, reviveDoc, deepEqual, describeChange } from '../lib/doc.js';

const doc0 = () => createDoc({ id: 'd1', w: 400, h: 300 });
const withTwo = () => {
  const a = { ...newCaption('a'), text: 'One' };
  const b = { ...newCaption('b'), text: 'Two', cy: 0.5 };
  return { ...doc0(), text: [a, b] };
};

// ------------------------------------------------------------------ text clipping

test('clipCaptionText keeps short text as it is', () => {
  assert.equal(clipCaptionText('Hello'), 'Hello');
  assert.equal(clipCaptionText(''), '');
  assert.equal(clipCaptionText(undefined), '');
  const exact = 'x'.repeat(MAX_CAPTION_CHARS);
  assert.equal(clipCaptionText(exact), exact);
});

test('clipped text survives reviveDoc unchanged, never splitting an emoji', () => {
  const flag = '🇫🇷'; // two code points, four UTF-16 units
  const long = 'a' + flag.repeat(700); // 2801 units
  const clipped = clipCaptionText(long);
  assert.ok(clipped.length <= MAX_CAPTION_CHARS);
  assert.equal(clipped.length, 1 + 4 * 499); // 499 whole flags fit, the 500th would not
  assert.ok(clipped.endsWith(flag));
  const doc = { ...doc0(), text: [{ ...newCaption('c'), text: clipped }] };
  assert.ok(deepEqual(reviveDoc(JSON.parse(JSON.stringify(doc))), doc));
});

test('a single grapheme longer than the cap is cut by code point', () => {
  const zalgo = 'e' + '́'.repeat(3000);
  const clipped = clipCaptionText(zalgo);
  assert.equal(clipped.length, MAX_CAPTION_CHARS);
  assert.ok(clipped.startsWith('é'));
});

// ------------------------------------------------------------------ doc edits

test('findCaption finds by id and tolerates junk', () => {
  const d = withTwo();
  assert.equal(findCaption(d, 'b').text, 'Two');
  assert.equal(findCaption(d, 'zz'), null);
  assert.equal(findCaption(d, null), null);
  assert.equal(findCaption({}, 'a'), null);
});

test('withCaption replaces in place, appends new ones on top, and is identity for the same object', () => {
  const d = withTwo();
  const a2 = { ...d.text[0], text: 'Uno' };
  const r = withCaption(d, a2);
  assert.notEqual(r, d);
  assert.deepEqual(r.text.map((c) => c.text), ['Uno', 'Two']);
  assert.equal(r.text[1], d.text[1], 'untouched captions are shared');
  assert.equal(r.light, d.light, 'the rest of the doc is shared');
  assert.equal(withCaption(d, d.text[0]), d);
  const c = newCaption('c');
  assert.deepEqual(withCaption(d, c).text.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(d.text.length, 2, 'never mutates');
});

test('withoutCaption removes one caption, identity when absent', () => {
  const d = withTwo();
  assert.deepEqual(withoutCaption(d, 'a').text.map((c) => c.id), ['b']);
  assert.equal(withoutCaption(d, 'zz'), d);
  assert.equal(describeChange(d, withoutCaption(d, 'a')), 'Deleted caption');
});

test('updateCaption merges fields and reports no-ops by identity', () => {
  const d = withTwo();
  const r = updateCaption(d, 'b', { style: 'box' });
  assert.equal(findCaption(r, 'b').style, 'box');
  assert.equal(describeChange(d, r), 'Style: Box');
  assert.equal(updateCaption(d, 'b', { style: 'classic' }), d);
  assert.equal(updateCaption(d, 'nope', { style: 'box' }), d);
  assert.equal(describeChange(d, updateCaption(d, 'a', { color: '#ffd60a' })), 'Caption color');
});

test('adding a new caption reads as a caption step in the undo label', () => {
  const d = doc0();
  const c = { ...newCaption('n'), text: 'Hello there' };
  assert.equal(describeChange(d, withCaption(d, c)), 'Caption “Hello there”');
});

// ------------------------------------------------------------------ placement

test('freeSpot starts at 78% and avoids a caption already there', () => {
  assert.equal(freeSpot([]), 0.78);
  assert.equal(freeSpot(undefined), 0.78);
  assert.equal(freeSpot([newCaption('a')]), 0.5);
  assert.equal(freeSpot([newCaption('a'), { ...newCaption('b'), cy: 0.5 }]), 0.22);
  // a caption off to the side does not block the middle column
  assert.equal(freeSpot([{ ...newCaption('a'), cx: 0.95 }]), 0.78);
  // everything taken: back to the default
  const all = [0.78, 0.5, 0.22, 0.64, 0.36].map((cy, i) => ({ ...newCaption(`c${i}`), cy }));
  assert.equal(freeSpot(all), 0.78);
});

test('moveCaption moves by normalized deltas and snaps to the centre and thirds', () => {
  const c = { ...newCaption('a'), cx: 0.2, cy: 0.2 };
  const free = moveCaption(c, 0.05, 0.01, 0.01);
  assert.deepEqual([free.caption.cx, free.caption.cy], [0.25, 0.21]);
  assert.deepEqual(free.guides, []);
  const snapped = moveCaption(c, 0.295, 0.13, 0.01);
  assert.equal(snapped.caption.cx, 0.5);
  assert.equal(snapped.caption.cy, 1 / 3);
  assert.deepEqual(snapped.guides.map((g) => g.axis).sort(), ['x', 'y']);
  // positions stay on the photo
  const off = moveCaption(c, -2, 5, 0.01);
  assert.deepEqual([off.caption.cx, off.caption.cy], [0, 1]);
});

test('moveCaption returns the caption itself when nothing moved', () => {
  const c = { ...newCaption('a'), cx: 0.25, cy: 0.25 };
  assert.equal(moveCaption(c, 0, 0, 0.01).caption, c);
});

test('moveCaption keeps 5 decimals off the snap lines', () => {
  const c = { ...newCaption('a'), cx: 0.1, cy: 0.1 };
  const r = moveCaption(c, 0.0123456789, 0.0000001, 0.001);
  assert.equal(r.caption.cx, 0.11235);
  assert.equal(r.caption.cy, 0.1);
});

test('snapThreshold is a fixed reach on screen along the short side', () => {
  assert.equal(snapThreshold(600, 300, 6), 0.02);
  assert.equal(snapThreshold(0, 300), 0.02, 'no size yet: the library default');
  assert.equal(snapThreshold(100000, 100000), 0.004);
  assert.equal(snapThreshold(10, 10), 0.05);
});

// ------------------------------------------------------------------ editing

test('handleWins: a big caption keeps its whole 44pt handle target', () => {
  const centre = [200, 300], handle = [320, 330]; // a wide caption's bottom-right corner
  assert.equal(handleWins([320, 330], handle, centre, 22), true); // on the disc
  assert.equal(handleWins([305, 318], handle, centre, 22), true); // inside the box, near the corner
  assert.equal(handleWins([336, 342], handle, centre, 22), true); // outside, past the corner
  assert.equal(handleWins([345, 330], handle, centre, 22), false); // out of reach
});

test('handleWins: on a small caption the half nearer the centre stays the caption', () => {
  const centre = [220, 362], handle = [227, 369]; // 8pt text: the corner is 10pt away
  assert.equal(handleWins(centre, handle, centre, 22), false); // tap the words: edit them
  assert.equal(handleWins([216, 360], handle, centre, 22), false); // drag from the words: move
  assert.equal(handleWins([227, 369], handle, centre, 22), true); // the disc itself
  assert.equal(handleWins([235, 377], handle, centre, 22), true); // past the corner
});

test('handleWins tolerates missing points', () => {
  assert.equal(handleWins([1, 1], null, [0, 0], 22), false);
  assert.equal(handleWins([NaN, 1], [1, 1], [0, 0], 22), false);
});

test('editSelection selects the placeholder, puts the caret after real words', () => {
  assert.deepEqual(editSelection(PLACEHOLDER_TEXT), [0, 10]);
  assert.deepEqual(editSelection('Hello'), [5, 5]);
  assert.deepEqual(editSelection(''), [0, 0]);
});

test('editBarTop pins the bar to the bottom of the visual viewport', () => {
  assert.equal(editBarTop(0, 956), 956 - EDIT_BAR_H);
  assert.equal(editBarTop(120, 520), 120 + 520 - 52);
  assert.equal(editBarTop(0, 20), 0, 'never above the top');
  assert.equal(editBarTop(NaN, 600), 548);
});

test('isKeyboardUp needs a real loss of height', () => {
  assert.equal(isKeyboardUp(956, 956), false);
  assert.equal(isKeyboardUp(956, 900), false);
  assert.equal(isKeyboardUp(956, 560), true);
  assert.equal(isKeyboardUp(undefined, 560), false);
});

test('stageShift centres the caption above the bar, and only ever slides up', () => {
  assert.equal(stageShift({ captionY: 480, visibleTop: 0, barTop: 500, keyboardUp: true }), -230);
  assert.equal(stageShift({ captionY: 100, visibleTop: 0, barTop: 500, keyboardUp: true }), 0);
  assert.equal(stageShift({ captionY: 480, visibleTop: 0, barTop: 500, keyboardUp: false }), 0);
  assert.equal(stageShift({ captionY: NaN, visibleTop: 0, barTop: 500, keyboardUp: true }), 0);
});

test('captionId never repeats an id in use and stays a valid doc id', () => {
  const fixed = () => 0.5;
  const first = captionId([], 1000, fixed);
  assert.match(first, /^t[0-9a-z]+$/);
  const second = captionId([{ id: first }], 1000, fixed);
  assert.notEqual(second, first);
  const doc = { ...doc0(), text: [{ ...newCaption(first), text: 'x' }] };
  assert.equal(reviveDoc(doc).text[0].id, first);
});
