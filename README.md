# carousel-render-service

Renders Instagram 4:5 carousel slides from JSON using HTML/CSS templates and
Playwright. **No AI image generation** — the only per-post cost is the LLM
tokens spent deciding what goes on each slide.

Every PNG is exactly **1080 × 1350**.

---

## Why this exists

AI image generation is expensive per image and unreliable at rendering text —
a slide with a garbled headline is worthless regardless of how good the art is.
Template rendering is deterministic, free, and text is always perfect because
it is real text in a browser, not pixels a model guessed at.

## The dimension guarantee

1080 × 1350 is enforced by four independent layers, so it cannot drift:

1. Playwright viewport fixed at 1080 × 1350
2. `#slide` fixed at 1080 × 1350 in `base.css`
3. Screenshot taken with an explicit `clip` of 1080 × 1350 at origin
4. The decoded PNG header is asserted after capture and **throws** if a single
   pixel is off

There is also an overflow check: if content is too long for its frame, the
render **fails loudly** rather than silently producing a cropped post.

## Library

**12 frame types × 11 themes = 132 combinations**, all verified.

### Frame types

| Type | Use for | Required |
|---|---|---|
| `cover` | Opening slide | `headline` |
| `bullet-list` | 1–5 short points | `headline`, `bullets[]` |
| `stat` | One hero number | `value` |
| `stat-grid` | 2–4 numbers together | `stats[{value,label}]` |
| `comparison` | Before/after, this vs that | `headline`, both sides |
| `two-column` | Two related lists | `headline`, `leftLabel`, `rightLabel`, both `*Items[]` |
| `numbered-steps` | 2–4 sequential steps | `headline`, `steps[]` |
| `timeline` | 2–4 dated events | `headline`, `events[{date,text}]` |
| `quote` | Attributed statement (≤240 chars) | `quote` |
| `big-text` | One short line, max impact (≤120 chars) | `text` |
| `image-caption` | Reference image + caption | none (`imageData` optional) |
| `outro` | Closing slide, CTA | `headline` |

Every frame also accepts optional `eyebrow`. Carousel frames show a `n / total`
pager automatically.

### Themes

`dark-tech` (default) · `editorial` · `minimal` · `dramatic` · `data` ·
`brand-google` · `brand-apple` · `brand-openai` · `terminal` · `paper` · `neon`

A theme only changes colour, font and decoration — **never geometry**. That is
why adding one is cheap and cannot break layout.

The `brand-*` themes are stylistic homage for stories centred on that company.
They reproduce no logos or wordmarks.

---

## Run locally

```bash
npm install          # also downloads Chromium
npm run smoke        # renders all 132 combinations, asserts dimensions
npm run smoke -- full  # additionally writes every PNG to out/
npm start            # serves on :8080
```

## Run in Docker

```bash
export CAROUSEL_API_KEY="$(openssl rand -hex 24)"
export CAROUSEL_PUBLIC_BASE_URL="https://carousel.example.com"
docker compose up -d --build
```

`shm_size: 1gb` is required — Chromium crashes mid-batch on the 64MB default.

---

## API

### `GET /health`
Status, dimensions, available frames and themes, whether auth is enabled.

### `GET /templates`
Machine-readable field contract for every frame type. Useful for prompting an
LLM with the current catalogue rather than hardcoding it.

### `POST /render`

```json
{
  "theme": "dark-tech",
  "brand": "@techunlocked_in",
  "response_mode": "urls",
  "slides": [
    { "type": "cover", "eyebrow": "AI & Tech", "headline": "..." },
    { "type": "stat", "value": "3,400", "unit": "tokens / second", "label": "..." },
    { "type": "outro", "headline": "...", "cta": "Save this" }
  ]
}
```

`response_mode`:
- `urls` (default) — returns short-lived image URLs. **Use this from n8n**;
  it keeps large base64 blobs out of the execution payload.
- `base64` — returns bytes inline.

A per-slide `theme` overrides the batch theme, if a slide needs to stand out.

Max 10 slides (Instagram's carousel limit).

Errors return the real message, not a wrapped generic one: content problems are
`400`, service faults are `500`.

### `GET /render/:batchId/:filename`
Serves a rendered PNG. Batches expire after `RENDER_TTL_MS` (default 30 min) —
they are disposable intermediates; the durable copies belong in Drive once n8n
has uploaded them.

---

## Security

- Set **`API_KEY`** and send it as `x-api-key`. Compared with
  `crypto.timingSafeEqual`.
- **If `API_KEY` is unset the service is unauthenticated** and logs a loud
  warning at boot. Only acceptable on localhost.
- Rate limited to `RATE_MAX` requests per `RATE_WINDOW_MS` (default 30/min) on
  `/render`.
- All outbound network requests are **blocked** during rendering. Fonts fall
  back to the system stack rather than fetching from Google Fonts — a network
  hiccup would otherwise silently change typography mid-carousel. Consequently
  `image-caption` requires a `data:image/...` URI, not an http URL.

## Fonts

Templates reference `Inter`, `Playfair Display`, `JetBrains Mono` and similar,
falling back to system fonts. To pin exact typography, add
`templates/fonts.css` with `@font-face` rules using base64 or local files; it is
inlined automatically when present.

## Adding to the library

**A theme** — copy a block in `templates/themes.css`, change the variables, add
its name to `THEMES` in `src/render.js`. Cannot break layout.

**A frame type** — add `templates/frames/<name>.njk`, add the name to
`FRAME_TYPES`, add validation in `validateSlide`, and add sample content to
`SAMPLES` in `src/smoke.js`. The matrix test refuses to run if a frame type has
no sample, so coverage cannot silently regress.
