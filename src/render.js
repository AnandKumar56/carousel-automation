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

const WIDTH = 1080;
const HEIGHT = 1350;

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const FRAMES_DIR = path.join(TEMPLATES_DIR, 'frames');

const FRAME_TYPES = [
  'cover',
  'bullet-list',
  'stat',
  'stat-grid',
  'comparison',
  'two-column',
  'numbered-steps',
  'timeline',
  'quote',
  'big-text',
  'image-caption',
  'outro',
];

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

  if (type === 'image-caption') {
    // imageData is optional by design - the template renders a labelled
    // placeholder instead of failing the whole batch.
    if (slide.imageData && !String(slide.imageData).startsWith('data:image/')) {
      throw validationError(`${where}.imageData must be a data URI starting with "data:image/" (network fetches are blocked)`);
    }
  }

  return type;
}

function buildHtml(slide, opts) {
  const type = opts.type;
  return env.render('shell.njk', {
    slide,
    theme: opts.theme,
    brand: opts.brand,
    slideNumber: opts.slideNumber,
    totalSlides: opts.totalSlides,
    baseCss,
    themesCss,
    fontCss,
    templateFile: `frames/${type}.njk`,
  });
}

/**
 * Render slides to PNG buffers.
 * @param {Array<object>} slides
 * @param {object} [options] theme, brand
 * @returns {Promise<Array<{index:number,type:string,buffer:Buffer,width:number,height:number}>>}
 */
async function renderSlides(slides, options = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw validationError('slides must be a non-empty array');
  }
  if (slides.length > 10) {
    throw validationError(`slides has ${slides.length} entries; Instagram carousels cap at 10`);
  }

  const theme = THEMES.includes(options.theme) ? options.theme : DEFAULT_THEME;
  const brand = options.brand || DEFAULT_BRAND;

  // Validate everything BEFORE launching a browser, so bad input costs nothing.
  const types = slides.map((s, i) => validateSlide(s, i));

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
        slideNumber: i + 1,
        totalSlides: slides.length,
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
        index: i + 1,
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
  FRAME_TYPES,
  THEMES,
  WIDTH,
  HEIGHT,
  DEFAULT_THEME,
  DEFAULT_BRAND,
};
