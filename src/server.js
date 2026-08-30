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
    frame_types: {
      cover: { required: ['headline'], optional: ['eyebrow', 'subheadline', 'source'] },
      'bullet-list': { required: ['headline', 'bullets (1-5)'], optional: ['eyebrow', 'subheadline'] },
      stat: { required: ['value'], optional: ['eyebrow', 'unit', 'label', 'body'] },
      comparison: {
        required: ['headline', 'left side content', 'right side content'],
        optional: ['eyebrow', 'leftLabel', 'rightLabel', 'leftValue', 'rightValue', 'leftItems', 'rightItems', 'leftText', 'rightText'],
      },
      outro: { required: ['headline'], optional: ['eyebrow', 'subheadline', 'cta', 'sources'] },
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
    });

    const batchId = crypto.randomBytes(9).toString('hex');

    if (responseMode === 'base64') {
      return res.json({
        batch_id: batchId,
        count: rendered.length,
        dimensions: { width: WIDTH, height: HEIGHT },
        processing_ms: Date.now() - started,
        slides: rendered.map((r) => ({
          index: r.index,
          type: r.type,
          filename: `slide_${String(r.index).padStart(2, '0')}.png`,
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
        filename: `slide_${String(r.index).padStart(2, '0')}.png`,
        buffer: r.buffer,
        width: r.width,
        height: r.height,
      })),
    });

    const base = PUBLIC_BASE_URL.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

    return res.json({
      batch_id: batchId,
      count: rendered.length,
      dimensions: { width: WIDTH, height: HEIGHT },
      expires_in_seconds: Math.floor(TTL_MS / 1000),
      processing_ms: Date.now() - started,
      slides: rendered.map((r) => ({
        index: r.index,
        type: r.type,
        filename: `slide_${String(r.index).padStart(2, '0')}.png`,
        width: r.width,
        height: r.height,
        url: `${base}/render/${batchId}/slide_${String(r.index).padStart(2, '0')}.png`,
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
