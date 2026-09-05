'use strict';

/* Slide rendering core.
 *
 * Contract that must not be broken: every PNG is EXACTLY 1080x1350.
 * That is guaranteed structurally rather than by hope -
 *   1. the viewport is set to 1080x1350
 *   2. #slide is fixed at 1080x1350 in base.css
 *   3. the screenshot uses an explicit clip of 1080x1350 at origin
 *   4. renderSlides asserts the decoded PNG header afterwards and throws
 *      if a single pixel is off
 * If a template ever overflows, we get a loud failure, not a silently
 * cropped post.
 */

const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');
const { chromium } = require('playwright');
const { renderChart } = require('./charts');
const { prepareSlide } = require('./slidemodel');

const WIDTH = 1080;
const HEIGHT = 1350;

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const FRAMES_DIR = path.join(TEMPLATES_DIR, 'frames');

const FRAME_TYPES = [
  'cover',
  'bullet-list',
  'stat',
  'stat-grid',
  'chart',
  'comparison',
  'two-column',
  'numbered-steps',
  'timeline',
  'quote',
  'big-text',
  'image-caption',
  'outro',
];

/* Instagram's hard ceiling. Enforced against the CAROUSEL total rather than the
 * length of whatever array arrived, because renders are batched. */
const MAX_CAROUSEL_SLIDES = 10;

/* Vertical budget for a chart inside the `chart` frame: the 1350 canvas less the
 * 96px safe-area padding top and bottom, less the eyebrow, headline, takeaway and
 * footer rows. Charts whose natural height exceeds this are scaled down by the
 * browser (the SVG has a viewBox), which is why the value is generous - the
 * alternative, letting the chart push the footer off the canvas, would trip the
 * overflow guard and fail the whole batch. */
const CHART_HEIGHT_BUDGET = 700;

const THEMES = [
  'dark-tech',
  'editorial',
  'minimal',
  'dramatic',
  'data',
  'brand-google',
  'brand-apple',
  'brand-openai',
  'terminal',
  'paper',
  'neon',
];

const DEFAULT_THEME = 'dark-tech';
const DEFAULT_BRAND = '@techunlocked_in';

const env = nunjucks.configure([TEMPLATES_DIR, FRAMES_DIR], {
  autoescape: true,
  noCache: true,
});

const baseCss = fs.readFileSync(path.join(TEMPLATES_DIR, 'base.css'), 'utf8');
const layoutsCss = fs.readFileSync(path.join(TEMPLATES_DIR, 'layouts.css'), 'utf8');
const themesCss = fs.readFileSync(path.join(TEMPLATES_DIR, 'themes.css'), 'utf8');

/* Local font CSS is optional. If a fonts dir with face declarations exists we
 * inline it; otherwise templates fall back to the system stack declared in
 * themes.css. We deliberately do NOT fetch Google Fonts at render time - a
 * network hiccup would silently change typography mid-carousel. */
let fontCss = '';
const fontCssPath = path.join(TEMPLATES_DIR, 'fonts.css');
if (fs.existsSync(fontCssPath)) {
  fontCss = fs.readFileSync(fontCssPath, 'utf8');
}

function readPngSize(buf) {
  // PNG: 8-byte signature, then IHDR length+type, then width/height big-endian.
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* Caller-fault errors are tagged so the HTTP layer can return 400 rather than
 * 500. Tagging is explicit because classifying by message text is fragile - a
 * reworded message would silently start being reported as a server fault, and a
 * workflow would take an error path instead of being told to shorten its copy. */
function validationError(message) {
  const err = new Error(message);
  err.isValidation = true;
  return err;
}

function validateSlide(slide, index) {
  const where = `slides[${index}]`;
  if (!slide || typeof slide !== 'object') {
    throw validationError(`${where} must be an object`);
  }
  const type = String(slide.type || '').trim();
  if (!type) {
    throw validationError(`${where}.type is required (one of: ${FRAME_TYPES.join(', ')})`);
  }
  if (!FRAME_TYPES.includes(type)) {
    throw validationError(`${where}.type "${type}" is not supported. Supported: ${FRAME_TYPES.join(', ')}`);
  }

  // Per-type minimum content, so a malformed slide fails fast and loudly
  // rather than rendering an empty frame that looks deliberate.
  const needHeadline = ['cover', 'outro', 'bullet-list', 'comparison', 'two-column', 'numbered-steps', 'timeline'];
  if (needHeadline.includes(type) && !slide.headline) {
    throw validationError(`${where}.headline is required for type "${type}"`);
  }

  if (type === 'bullet-list') {
    if (!Array.isArray(slide.bullets) || slide.bullets.length === 0) {
      throw validationError(`${where}.bullets must be a non-empty array for type "bullet-list"`);
    }
    if (slide.bullets.length > 5) {
      throw validationError(`${where}.bullets has ${slide.bullets.length} items; max 5 fit legibly at 1080x1350`);
    }
  }

  if (type === 'stat') {
    if (!slide.value) throw validationError(`${where}.value is required for type "stat"`);
  }

  if (type === 'stat-grid') {
    if (!Array.isArray(slide.stats) || slide.stats.length < 2) {
      throw validationError(`${where}.stats must be an array of at least 2 for type "stat-grid"`);
    }
    if (slide.stats.length > 4) {
      throw validationError(`${where}.stats has ${slide.stats.length} entries; max 4 fit legibly`);
    }
    slide.stats.forEach((s, si) => {
      if (!s || !s.value) throw validationError(`${where}.stats[${si}].value is required`);
      if (!s.label) throw validationError(`${where}.stats[${si}].label is required`);
    });
  }

  if (type === 'comparison') {
    const hasLeft = slide.leftValue || slide.leftText || (slide.leftItems && slide.leftItems.length);
    const hasRight = slide.rightValue || slide.rightText || (slide.rightItems && slide.rightItems.length);
    if (!hasLeft || !hasRight) {
      throw validationError(`${where} needs content on both sides (leftValue/leftText/leftItems and rightValue/rightText/rightItems)`);
    }
  }

  if (type === 'two-column') {
    if (!Array.isArray(slide.leftItems) || slide.leftItems.length === 0) {
      throw validationError(`${where}.leftItems must be a non-empty array for type "two-column"`);
    }
    if (!Array.isArray(slide.rightItems) || slide.rightItems.length === 0) {
      throw validationError(`${where}.rightItems must be a non-empty array for type "two-column"`);
    }
    if (slide.leftItems.length > 5 || slide.rightItems.length > 5) {
      throw validationError(`${where} columns cap at 5 items each`);
    }
    if (!slide.leftLabel || !slide.rightLabel) {
      throw validationError(`${where}.leftLabel and .rightLabel are required for type "two-column"`);
    }
  }

  if (type === 'numbered-steps') {
    if (!Array.isArray(slide.steps) || slide.steps.length < 2) {
      throw validationError(`${where}.steps must be an array of at least 2 for type "numbered-steps"`);
    }
    if (slide.steps.length > 4) {
      throw validationError(`${where}.steps has ${slide.steps.length}; max 4 read legibly at phone size`);
    }
  }

  if (type === 'timeline') {
    if (!Array.isArray(slide.events) || slide.events.length < 2) {
      throw validationError(`${where}.events must be an array of at least 2 for type "timeline"`);
    }
    if (slide.events.length > 4) {
      throw validationError(`${where}.events has ${slide.events.length}; max 4 fit`);
    }
    slide.events.forEach((e, ei) => {
      if (!e || !e.date) throw validationError(`${where}.events[${ei}].date is required`);
      if (!e.text) throw validationError(`${where}.events[${ei}].text is required`);
    });
  }

  if (type === 'quote') {
    if (!slide.quote) throw validationError(`${where}.quote is required for type "quote"`);
    if (String(slide.quote).length > 240) {
      throw validationError(`${where}.quote is ${String(slide.quote).length} chars; keep under 240 so it stays legible`);
    }
  }

  if (type === 'big-text') {
    if (!slide.text) throw validationError(`${where}.text is required for type "big-text"`);
    if (String(slide.text).length > 120) {
      throw validationError(`${where}.text is ${String(slide.text).length} chars; big-text is for SHORT statements, keep under 120`);
    }
  }

  if (type === 'chart') {
    if (!slide.headline) {
      throw validationError(`${where}.headline is required for type "chart" - a chart without a stated finding makes the reader do the interpreting`);
    }
    if (!slide.chart || typeof slide.chart !== 'object') {
      throw validationError(`${where}.chart must be an object with { kind, unit, series }`);
    }
    // The chart is BUILT here, during validation, so a malformed spec fails
    // before a browser is launched and the caller gets charts.js's specific
    // message ("needs at least 3 points") rather than a generic render failure.
    try {
      slide.__chart = renderChart(slide.chart, { width: 888, height: slide.chart.height });
    } catch (err) {
      // charts.js already tags caller-fault errors; re-scope the message so the
      // caller knows which slide to fix.
      const e = validationError(`${where}: ${err && err.message ? err.message : String(err)}`);
      if (err && err.isValidation !== true) { e.isValidation = false; }
      throw e;
    }
    if (slide.__chart.height > CHART_HEIGHT_BUDGET) {
      throw validationError(
        `${where}.chart renders ${slide.__chart.height}px tall, over the ${CHART_HEIGHT_BUDGET}px budget for this frame`
        + ` - reduce the number of data points or set chart.height`
      );
    }
  }

  if (type === 'image-caption') {
    // imageData is optional by design - the template renders a labelled
    // placeholder instead of failing the whole batch.
    if (slide.imageData && !String(slide.imageData).startsWith('data:image/')) {
      throw validationError(`${where}.imageData must be a data URI starting with "data:image/" (network fetches are blocked)`);
    }
  }

  return type;
}

/* ------------------------------------------------------------------ pagination */

function firstNumber(/* ...candidates */) {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v === null || v === undefined || v === '') { continue; }
    const n = Number(v);
    if (Number.isFinite(n)) { return n; }
  }
  return null;
}

/**
 * Work out "n / N" for every slide in a request.
 *
 * THE BUG THIS FIXES: the renderer used to compute `totalSlides: slides.length`
 * from whatever array it was handed. Because the workflow renders in batches of
 * 3, a 7-slide carousel came out labelled "1/3 2/3 3/3 1/3 2/3 3/3 1/3". The
 * pager was describing the batch, not the carousel.
 *
 * The fix is that pagination is now an INPUT, not something inferred: the plan
 * knows the carousel length, so it states it. Array position is used only when
 * nothing was supplied at all, which is the correct answer for a one-shot render
 * of a whole carousel and keeps existing callers working.
 */
function resolvePagination(slides, options) {
  const opts = options || {};

  const batchTotal = firstNumber(opts.total_slides, opts.totalSlides);
  // A batch may state where it sits in the carousel instead of numbering each
  // slide, e.g. "these 3 slides start at 4". 1-based to match the pager.
  const startIndex = firstNumber(opts.start_index, opts.startIndex, opts.slide_offset);

  if (batchTotal !== null && (!Number.isInteger(batchTotal) || batchTotal < 1)) {
    throw validationError(`total_slides must be a positive integer, got ${JSON.stringify(opts.total_slides ?? opts.totalSlides)}`);
  }
  if (startIndex !== null && (!Number.isInteger(startIndex) || startIndex < 1)) {
    throw validationError(`start_index must be a positive integer (1-based), got ${JSON.stringify(opts.start_index ?? opts.startIndex ?? opts.slide_offset)}`);
  }

  const anySlideStatesTotal = slides.some(function (s) {
    return firstNumber(s && s.total_slides, s && s.totalSlides) !== null;
  });
  const supplied = batchTotal !== null || startIndex !== null || anySlideStatesTotal;

  // Checked before per-slide numbering so the caller gets the cause ("you sent
  // 4 slides for a 3-slide carousel") rather than the symptom ("slide 4 of 3").
  if (batchTotal !== null && slides.length > batchTotal) {
    throw validationError(`request carries ${slides.length} slides but total_slides is ${batchTotal}`);
  }

  const pages = slides.map(function (slide, i) {
    const s = slide || {};
    const index = firstNumber(s.slide_index, s.slideIndex, s.index)
      ?? (startIndex !== null ? startIndex + i : i + 1);
    const total = firstNumber(s.total_slides, s.totalSlides)
      ?? batchTotal
      ?? (startIndex !== null ? startIndex + slides.length - 1 : slides.length);
    return { index: index, total: total };
  });

  pages.forEach(function (p, i) {
    if (!Number.isInteger(p.index) || p.index < 1) {
      throw validationError(`slides[${i}].slide_index must be a positive integer, got ${JSON.stringify(p.index)}`);
    }
    if (!Number.isInteger(p.total) || p.total < 1) {
      throw validationError(`slides[${i}].total_slides must be a positive integer, got ${JSON.stringify(p.total)}`);
    }
    if (p.index > p.total) {
      throw validationError(`slides[${i}] is numbered ${p.index} of ${p.total} - the index cannot exceed the total`);
    }
    if (p.total > MAX_CAROUSEL_SLIDES) {
      throw validationError(`slides[${i}].total_slides is ${p.total}; Instagram carousels cap at ${MAX_CAROUSEL_SLIDES}`);
    }
  });

  // One request must describe one carousel. Disagreeing totals mean the caller
  // merged two carousels, and the resulting pagination would be nonsense.
  const totals = {};
  pages.forEach(function (p) { totals[p.total] = true; });
  const distinct = Object.keys(totals);
  if (distinct.length > 1) {
    throw validationError(`slides disagree on total_slides (${distinct.join(', ')}); every slide in one carousel must state the same total`);
  }

  // Duplicate numbering silently produces two slides labelled "3 / 7".
  const seen = {};
  pages.forEach(function (p, i) {
    if (seen[p.index] !== undefined) {
      throw validationError(`slides[${i}] and slides[${seen[p.index]}] are both numbered ${p.index}`);
    }
    seen[p.index] = i;
  });

  // Only meaningful when the caller told us the carousel size: a batch of 4
  // cannot fit inside a 3-slide carousel.
  if (supplied && slides.length > pages[0].total) {
    throw validationError(`request carries ${slides.length} slides but total_slides is ${pages[0].total}`);
  }

  return pages;
}

function buildHtml(slide, opts) {
  const type = opts.type;
  return env.render('shell.njk', {
    slide,
    /* The view model: everything the template must not compute itself -
     * attribution, proportional timeline gaps, lead-figure selection. Built in
     * slidemodel.js so the logic is testable without a browser and cannot drift
     * between the thirteen frames the way the original per-template rules did. */
    view: prepareSlide(slide, type),
    // Pre-rendered SVG plus its metadata, attached by validateSlide. Passed
    // separately from `slide` so the template never has to know that a field
    // beginning with __ is internal.
    chart: slide.__chart || null,
    theme: opts.theme,
    brand: opts.brand,
    slideNumber: opts.slideNumber,
    totalSlides: opts.totalSlides,
    baseCss,
    layoutsCss,
    themesCss,
    fontCss,
    templateFile: `frames/${type}.njk`,
  });
}

/**
 * Render slides to PNG buffers.
 *
 * @param {Array<object>} slides
 * @param {object} [options] theme, brand, and optionally total_slides /
 *   start_index so a partial batch paginates against the real carousel length.
 * @returns {Promise<Array<{index:number,slideIndex:number,totalSlides:number,type:string,buffer:Buffer,width:number,height:number}>>}
 */
async function renderSlides(slides, options = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw validationError('slides must be a non-empty array');
  }
  if (slides.length > MAX_CAROUSEL_SLIDES) {
    throw validationError(`slides has ${slides.length} entries; Instagram carousels cap at ${MAX_CAROUSEL_SLIDES}`);
  }

  const theme = THEMES.includes(options.theme) ? options.theme : DEFAULT_THEME;
  const brand = options.brand || DEFAULT_BRAND;

  // Validate everything BEFORE launching a browser, so bad input costs nothing.
  const types = slides.map((s, i) => validateSlide(s, i));
  const pages = resolvePagination(slides, options);

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      // Blocking external requests keeps rendering deterministic and offline-safe.
      offline: false,
    });

    // Hard-fail nothing, but never wait on third-party assets.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      return route.abort();
    });

    const page = await context.newPage();
    const out = [];

    for (let i = 0; i < slides.length; i++) {
      const html = buildHtml(slides[i], {
        type: types[i],
        theme: slides[i].theme && THEMES.includes(slides[i].theme) ? slides[i].theme : theme,
        brand,
        slideNumber: pages[i].index,
        totalSlides: pages[i].total,
      });

      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts && document.fonts.ready);

      const el = await page.$('#slide');
      // A missing #slide means the template shell is broken - that is our bug,
      // not the caller's, so it stays a 500.
      if (!el) throw new Error(`slides[${i}] produced no #slide element`);

      // Guard against a template overflowing its box.
      const box = await el.evaluate((n) => ({
        w: n.getBoundingClientRect().width,
        h: n.getBoundingClientRect().height,
        scrollH: n.scrollHeight,
      }));
      // Wrong box geometry means a template broke the size contract - our bug.
      if (Math.round(box.w) !== WIDTH || Math.round(box.h) !== HEIGHT) {
        throw new Error(`slides[${i}] (${types[i]}) box is ${box.w}x${box.h}, expected ${WIDTH}x${HEIGHT}`);
      }
      // Overflow means the supplied copy is too long - the caller can fix this,
      // so it is a 400 and the message says what to do.
      const overflow = box.scrollH - HEIGHT;
      if (overflow > 2) {
        throw validationError(
          `slides[${i}] (${types[i]}) content overflows by ${overflow}px - shorten the text or reduce bullets`
        );
      }

      const buffer = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });

      const size = readPngSize(buffer);
      // Wrong output dimensions would be a renderer fault, never the caller's.
      if (!size || size.width !== WIDTH || size.height !== HEIGHT) {
        throw new Error(
          `slides[${i}] rendered ${size ? size.width + 'x' + size.height : 'unreadable PNG'}, expected ${WIDTH}x${HEIGHT}`
        );
      }

      out.push({
        // `index` is the slide's position in the CAROUSEL, not in this request,
        // so filenames and Drive ordering stay correct across batched renders.
        index: pages[i].index,
        slideIndex: pages[i].index,
        totalSlides: pages[i].total,
        batchPosition: i + 1,
        type: types[i],
        buffer,
        width: size.width,
        height: size.height,
      });
    }

    return out;
  } finally {
    await browser.close();
  }
}

module.exports = {
  renderSlides,
  resolvePagination,
  validationError,
  FRAME_TYPES,
  THEMES,
  WIDTH,
  HEIGHT,
  MAX_CAROUSEL_SLIDES,
  CHART_HEIGHT_BUDGET,
  DEFAULT_THEME,
  DEFAULT_BRAND,
};
