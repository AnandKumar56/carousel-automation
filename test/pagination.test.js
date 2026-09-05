'use strict';

/* Pagination regression tests.
 *
 * THE BUG: the renderer computed `totalSlides: slides.length` from whatever
 * array it was handed. The workflow renders in batches of 3, so a 7-slide
 * carousel came out labelled "1/3 2/3 3/3 1/3 2/3 3/3 1/3" - the pager was
 * describing the batch, not the carousel.
 *
 * These tests run against resolvePagination directly rather than through
 * renderSlides, because launching Chromium to check two integers would make the
 * suite too slow to run on every change.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolvePagination } = require('../src/render');

/* Frame type is irrelevant to pagination; these stand in for real slides. */
function slides(n, extra) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Object.assign({ type: 'big-text', text: 'x' }, extra ? extra(i) : {}));
  }
  return out;
}

function pagerStrings(pages) {
  return pages.map(function (p) { return p.index + '/' + p.total; });
}

test('a batch of 3 from a 7-slide carousel paginates against 7, not 3', () => {
  // The exact failing case: slides 4, 5, 6 of 7.
  const pages = resolvePagination(slides(3), { total_slides: 7, start_index: 4 });
  assert.deepEqual(pagerStrings(pages), ['4/7', '5/7', '6/7']);
});

test('every batch of a 7-slide carousel numbers correctly end to end', () => {
  const all = [];
  [1, 4, 7].forEach(function (start) {
    const count = Math.min(3, 7 - start + 1);
    resolvePagination(slides(count), { total_slides: 7, start_index: start })
      .forEach(function (p) { all.push(p); });
  });
  assert.deepEqual(pagerStrings(all), ['1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7']);
});

test('per-slide slide_index and total_slides win over batch-level values', () => {
  const pages = resolvePagination(
    slides(2, function (i) { return { slide_index: 5 + i, total_slides: 9 }; }),
    { total_slides: 3, start_index: 1 }
  );
  assert.deepEqual(pagerStrings(pages), ['5/9', '6/9']);
});

test('array position is used only when nothing was supplied', () => {
  // Preserves the existing one-shot behaviour for callers that send a whole
  // carousel and say nothing about pagination.
  const pages = resolvePagination(slides(5), {});
  assert.deepEqual(pagerStrings(pages), ['1/5', '2/5', '3/5', '4/5', '5/5']);
});

test('total_slides alone paginates by array position within the stated total', () => {
  const pages = resolvePagination(slides(3), { total_slides: 8 });
  assert.deepEqual(pagerStrings(pages), ['1/8', '2/8', '3/8']);
});

test('start_index alone infers the carousel length from the batch tail', () => {
  // Without a stated total the best available answer is "the last slide here is
  // the last slide"; it must at least never be smaller than the highest index.
  const pages = resolvePagination(slides(3), { start_index: 5 });
  assert.deepEqual(pagerStrings(pages), ['5/7', '6/7', '7/7']);
});

test('camelCase aliases are accepted', () => {
  // n8n Set nodes produce both conventions depending on how a field was typed.
  const pages = resolvePagination(
    slides(2, function (i) { return { slideIndex: 2 + i, totalSlides: 6 }; }),
    {}
  );
  assert.deepEqual(pagerStrings(pages), ['2/6', '3/6']);
});

test('an index above the total is rejected', () => {
  assert.throws(
    () => resolvePagination(slides(1, () => ({ slide_index: 9, total_slides: 7 })), {}),
    (e) => e.isValidation === true && /cannot exceed the total/.test(e.message)
  );
});

test('slides disagreeing on the total are rejected', () => {
  assert.throws(
    () => resolvePagination([
      { type: 'big-text', text: 'a', slide_index: 1, total_slides: 7 },
      { type: 'big-text', text: 'b', slide_index: 2, total_slides: 8 },
    ], {}),
    (e) => e.isValidation === true && /disagree on total_slides/.test(e.message)
  );
});

test('duplicate slide numbers are rejected', () => {
  // Two slides labelled "3 / 7" is the silent-corruption case: it renders fine.
  assert.throws(
    () => resolvePagination([
      { type: 'big-text', text: 'a', slide_index: 3, total_slides: 7 },
      { type: 'big-text', text: 'b', slide_index: 3, total_slides: 7 },
    ], {}),
    (e) => e.isValidation === true && /both numbered 3/.test(e.message)
  );
});

test('a total above the Instagram cap is rejected', () => {
  assert.throws(
    () => resolvePagination(slides(2), { total_slides: 11 }),
    (e) => e.isValidation === true && /cap at 10/.test(e.message)
  );
});

test('a batch larger than the stated carousel is rejected', () => {
  assert.throws(
    () => resolvePagination(slides(4), { total_slides: 3 }),
    (e) => e.isValidation === true && /carries 4 slides but total_slides is 3/.test(e.message)
  );
});

test('non-integer and zero pagination values are rejected as caller errors', () => {
  assert.throws(
    () => resolvePagination(slides(2), { total_slides: 0 }),
    (e) => e.isValidation === true
  );
  assert.throws(
    () => resolvePagination(slides(2), { start_index: 0 }),
    (e) => e.isValidation === true
  );
  assert.throws(
    () => resolvePagination(slides(2), { total_slides: 2.5 }),
    (e) => e.isValidation === true
  );
});

test('numeric strings are accepted', () => {
  // HTTP bodies assembled in n8n expressions frequently arrive as strings.
  const pages = resolvePagination(slides(2), { total_slides: '7', start_index: '4' });
  assert.deepEqual(pagerStrings(pages), ['4/7', '5/7']);
});
