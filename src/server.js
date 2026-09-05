'use strict';

/* HTTP service wrapper.
 *
 * n8n POSTs slide JSON and gets back either base64 PNGs or short-lived public
 * URLs. URL mode is the one to use from a workflow: it keeps huge base64 blobs
 * out of the execution payload, which is exactly the failure mode that made
 * earlier image work hard to debug.
 *
 * SECURITY: if API_KEY is set in the environment, every render request must
 * carry a matching x-api-key header. If API_KEY is NOT set the service runs
 * open, which is only acceptable on localhost. It logs a loud warning at boot
 * so an unauthenticated public deployment cannot happen quietly.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  renderSlides,
  FRAME_TYPES,
  THEMES,
  WIDTH,
  HEIGHT,
  DEFAULT_THEME,
  DEFAULT_BRAND,
} = require('./render');
const { CHART_KINDS } = require('./charts');
const {
  CHART_MIN_POINTS,
  CHART_MAX_POINTS,
  LAYOUTS,
  FRAME_LAYOUTS,
} = require('./contracts');

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const TTL_MS = Number(process.env.RENDER_TTL_MS || 30 * 60 * 1000);
const OUT_DIR = path.join(__dirname, '..', 'out');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const app = express();

/* Behind Render's / Railway's / Caddy's reverse proxy, Express otherwise sees
 * the proxy's IP and reports req.protocol as "http" even on HTTPS. That breaks
 * two things: rate limiting would bucket every caller together, and generated
 * image URLs would come back as http:// and get blocked as mixed content.
 * Trusting the proxy fixes both. Safe here because the service is only ever
 * reached through a proxy in hosted deployments. */
app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));

/* In-memory store of rendered batches, purged on a timer. Nothing is persisted
 * beyond TTL because these are disposable intermediates - the durable copies
 * live in Google Drive once n8n has uploaded them. */
const batches = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [id, batch] of batches.entries()) {
    if (now - batch.createdAt > TTL_MS) batches.delete(id);
  }
}
setInterval(purgeExpired, 60 * 1000).unref();

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const given = req.get('x-api-key') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid or missing x-api-key' });
  }
  return next();
}

/* ---------- simple fixed-window rate limit on the expensive endpoint ---------- */
const RATE_MAX = Number(process.env.RATE_MAX || 30);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60 * 1000);
const hits = new Map();

function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    return next();
  }
  rec.count += 1;
  if (rec.count > RATE_MAX) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - rec.start)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate limit exceeded', retry_after_seconds: retryAfter });
  }
  return next();
}

/* ---------- routes ---------- */

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    dimensions: `${WIDTH}x${HEIGHT}`,
    frame_types: FRAME_TYPES,
    layouts: LAYOUTS,
    chart_kinds: CHART_KINDS,
    themes: THEMES,
    auth_required: Boolean(API_KEY),
    batches_cached: batches.size,
  });
});

app.get('/templates', (req, res) => {
  res.json({
    dimensions: { width: WIDTH, height: HEIGHT, aspect_ratio: '4:5' },
    default_theme: DEFAULT_THEME,
    themes: THEMES,
    /* Frames are the caller-facing vocabulary; layouts are the structural
     * skeletons behind them. Exposed so a planner can reason about silhouette
     * variety across a carousel rather than picking frames blindly - two
     * consecutive slides on the same layout will look like the same slide. */
    layouts: LAYOUTS,
    frame_layouts: FRAME_LAYOUTS,
    /* Attribution is accepted on every frame and rendered on every slide. Omitting
     * it does not fail the render - it prints "Source not stated", which is
     * deliberately visible so a reviewer can catch it. */
    attribution: {
      sources: 'string | string[] | {name,url}[] - publication names or URLs; URLs resolve to a name',
      as_of: 'string - e.g. "Aug 2026". Include it for any figure that ages.',
      per_item: 'stats[], bullets[] and events[] each accept their own source / source_tier',
      source_tier: 'number 1-4. Tier 4 (social, blogs) is labelled "unverified" on the slide rather than dropped.',
    },
    /* Pagination is an INPUT, not something the renderer infers. Send these when
     * rendering part of a carousel; without them the renderer falls back to array
     * position, which is only correct for a one-shot render of the whole thing. */
    pagination: {
      total_slides: 'number - how many slides the finished carousel has',
      start_index: 'number - 1-based position of the first slide in this batch',
      per_slide: 'slide.slide_index and slide.total_slides override the batch values',
    },
    frame_types: {
      cover: {
        layout: 'editorial_hero (bottom-anchored)',
        required: ['headline'],
        optional: ['eyebrow', 'subheadline', 'sources', 'as_of'],
      },
      'big-text': {
        layout: 'editorial_hero (centre-anchored)',
        required: ['text'],
        optional: ['eyebrow', 'footnote', 'sources'],
        note: 'For one short statement. Keep under 120 chars.',
      },
      chart: {
        layout: 'chart_dominant',
        required: ['headline', 'chart'],
        optional: ['eyebrow', 'subheadline', 'takeaway'],
        note: 'headline should state the FINDING, not the chart subject. The chart draws its own source, so the footer line is suppressed on this frame.',
      },
      stat: {
        layout: 'metric_cards (single hero figure)',
        required: ['value'],
        optional: ['eyebrow', 'unit', 'label', 'body', 'sources', 'as_of'],
      },
      'stat-grid': {
        layout: 'metric_cards',
        required: ['headline', 'stats (2-4, each {value,label})'],
        optional: ['eyebrow', 'stats[].unit', 'stats[].source', 'stats[].lead'],
        note: 'One card is the lead and is set larger. Set lead:true to choose it; otherwise the first is used. Magnitude is never used to pick it.',
      },
      comparison: {
        layout: 'split_comparison (adversarial)',
        required: ['headline', 'left side content', 'right side content'],
        optional: ['eyebrow', 'leftLabel', 'rightLabel', 'leftValue', 'rightValue', 'leftItems', 'rightItems', 'leftText', 'rightText'],
        note: 'The right side carries the accent wash - put the side you are arguing for there.',
      },
      'two-column': {
        layout: 'split_comparison (neutral)',
        required: ['headline', 'leftLabel', 'rightLabel', 'leftItems', 'rightItems'],
        optional: ['eyebrow'],
        note: 'For two complementary facets, not an opposition. Use `comparison` for that.',
      },
      'bullet-list': {
        layout: 'evidence_list',
        required: ['headline', 'bullets (1-5)'],
        optional: ['eyebrow', 'subheadline'],
        note: 'Bullets may be plain strings, or {figure,text,source,source_tier} to get a large leading figure and per-row attribution.',
      },
      'numbered-steps': {
        layout: 'diagram_explainer',
        required: ['headline', 'steps (2-4)'],
        optional: ['eyebrow', 'steps[].detail'],
      },
      timeline: {
        layout: 'timeline_scaled',
        required: ['headline', 'events (2-4, each {date,text})'],
        optional: ['eyebrow', 'events[].source', 'events[].emphasis'],
        note: 'Gaps are drawn PROPORTIONAL to elapsed time. Use parseable dates (2026-03, "March 2026", 2026) or the rail falls back to even spacing.',
      },
      quote: {
        layout: 'quote_evidence',
        required: ['quote (under 240 chars)'],
        optional: ['attribution', 'attributionRole', 'sources'],
      },
      'image-caption': {
        layout: 'image_annotated (full bleed)',
        required: ['headline'],
        optional: ['eyebrow', 'caption', 'imageData', 'sources'],
        note: 'imageData must be a data: URI - network fetches are blocked during render. Without it a labelled placeholder is drawn rather than failing the batch.',
      },
      outro: {
        layout: 'conclusion_cta',
        required: ['headline'],
        optional: ['subheadline', 'cta', 'source_manifest'],
        note: 'source_manifest lists every source used across the carousel. When present it replaces the footer source line.',
      },
    },
    chart: {
      kinds: CHART_KINDS.map((kind) => ({
        kind,
        min_points: CHART_MIN_POINTS[kind],
        max_points: CHART_MAX_POINTS[kind],
      })),
      required: ['kind', 'unit', 'series (each point needs a label and a finite value)'],
      optional: ['sources or source', 'as_of', 'series_names (grouped-bar only)', 'sort', 'height'],
      series_point: {
        label: 'string - required, no unlabelled points',
        value: 'number - required and finite; null is refused, not drawn as zero',
        values: 'number[] - grouped-bar only, one per series',
        date: 'YYYY | YYYY-MM | YYYY-MM-DD - required for timeline-scaled',
        emphasis: 'boolean - marks the point the slide is about',
      },
      sort: {
        modes: ['none', 'asc', 'desc'],
        default: 'none',
        note: 'Opt-in on purpose: a comparison often leads with its subject, and reordering would change what the slide says. Rejected for line, progression and timeline-scaled, where order is the axis.',
      },
      rules: [
        'value axes always include zero; baselines cannot be truncated',
        'every point is labelled and the unit is stated on the chart',
        'the source is baked into the SVG so it cannot be lost',
        'a chart below its minimum point count is refused - use a metric card instead',
        'timeline-scaled requires real dates; spacing is never invented',
      ],
    },
  });
});

app.post('/render', requireKey, rateLimit, async (req, res) => {
  const started = Date.now();
  const body = req.body || {};
  const slides = body.slides;
  const responseMode = body.response_mode === 'base64' ? 'base64' : 'urls';

  try {
    const rendered = await renderSlides(slides, {
      theme: body.theme,
      brand: body.brand,
      // Pagination travels with the request so a batch of 3 out of 7 still
      // renders "4 / 7" rather than "1 / 3". Per-slide slide_index /
      // total_slides take precedence over these batch-level values.
      total_slides: body.total_slides,
      start_index: body.start_index,
    });

    const batchId = crypto.randomBytes(9).toString('hex');
    const nameFor = (r) => `slide_${String(r.index).padStart(2, '0')}.png`;

    if (responseMode === 'base64') {
      return res.json({
        batch_id: batchId,
        count: rendered.length,
        total_slides: rendered[0].totalSlides,
        dimensions: { width: WIDTH, height: HEIGHT },
        processing_ms: Date.now() - started,
        slides: rendered.map((r) => ({
          index: r.index,
          slide_index: r.slideIndex,
          total_slides: r.totalSlides,
          type: r.type,
          filename: nameFor(r),
          width: r.width,
          height: r.height,
          b64: r.buffer.toString('base64'),
        })),
      });
    }

    batches.set(batchId, {
      createdAt: Date.now(),
      slides: rendered.map((r) => ({
        index: r.index,
        type: r.type,
        filename: nameFor(r),
        buffer: r.buffer,
        width: r.width,
        height: r.height,
      })),
    });

    const base = PUBLIC_BASE_URL.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

    return res.json({
      batch_id: batchId,
      count: rendered.length,
      total_slides: rendered[0].totalSlides,
      dimensions: { width: WIDTH, height: HEIGHT },
      expires_in_seconds: Math.floor(TTL_MS / 1000),
      processing_ms: Date.now() - started,
      slides: rendered.map((r) => ({
        index: r.index,
        slide_index: r.slideIndex,
        total_slides: r.totalSlides,
        type: r.type,
        filename: nameFor(r),
        width: r.width,
        height: r.height,
        url: `${base}/render/${batchId}/${nameFor(r)}`,
      })),
    });
  } catch (err) {
    // Validation and overflow errors are the caller's problem (400); anything
    // else is ours (500). Either way the message is returned verbatim so a
    // workflow trace shows the real cause rather than "Bad request".
    //
    // Classified by an explicit marker rather than by pattern-matching the
    // message text: the earlier regex approach silently misclassified real
    // validation failures as 500s, which would have sent a workflow down an
    // error path instead of telling it to shorten the copy.
    const msg = err && err.message ? err.message : String(err);
    const isClient = err && err.isValidation === true;
    return res.status(isClient ? 400 : 500).json({ error: msg });
  }
});

app.get('/render/:batchId/:filename', (req, res) => {
  const batch = batches.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'batch not found or expired' });
  const slide = batch.slides.find((s) => s.filename === req.params.filename);
  if (!slide) return res.status(404).json({ error: 'slide not found in batch' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=300');
  return res.send(slide.buffer);
});

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`carousel-render-service listening on 0.0.0.0:${PORT}`);
  console.log(`  output: ${WIDTH}x${HEIGHT} (4:5)`);
  console.log(`  frames: ${FRAME_TYPES.join(', ')}`);
  console.log(`  themes: ${THEMES.join(', ')}`);
  console.log(`  public base url: ${PUBLIC_BASE_URL || '(derived from request host)'}`);
  if (!API_KEY) {
    console.warn('  WARNING: API_KEY is not set - this service is UNAUTHENTICATED.');
    console.warn('  Do not expose it publicly without setting API_KEY.');
  }
});
