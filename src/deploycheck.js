'use strict';

/* Deploy-config test. Boots the real server in-process with hosted-style env
 * vars and asserts the things that only break in a hosted environment:
 *   - API_KEY is actually enforced (401 without it, 401 with a wrong one)
 *   - PUBLIC_BASE_URL is used for returned image URLs, not the request host
 *   - a rendered PNG is retrievable and still exactly 1080x1350
 *
 * Run: node src/deploycheck.js
 */

const http = require('http');
const { FRAME_TYPES, THEMES } = require('./render');

process.env.PORT = process.env.PORT || '8123';
process.env.API_KEY = 'deploycheck-key-abc123';
process.env.PUBLIC_BASE_URL = 'https://carousel.example.com';

/* Raised well clear of the burst below. The rate limiter and the render queue are
 * different protections - the limiter is about abuse, the queue is about capacity -
 * and they both answer 429, so leaving the limiter at its default would let it
 * absorb the burst and the queue would never be exercised. */
process.env.RATE_MAX = '200';

/* Deliberately smaller than the burst so BOTH queue paths are covered: some
 * requests are absorbed and served, and some are cleanly rejected. At the default
 * cap of 12 an 8-request burst would all queue successfully and the rejection path
 * would go untested. */
process.env.RENDER_MAX_QUEUE = '4';

const PORT = Number(process.env.PORT);
const KEY = process.env.API_KEY;

// Booting the server module starts it listening.
require('./server');

function req(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: Object.assign(
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
          headers || {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  console.log('deploy config checks\n');

  // 1. health reports auth enabled
  const h = await req('GET', '/health');
  let health = {};
  try { health = JSON.parse(h.buf.toString()); } catch (e) { /* noop */ }
  check('health returns 200', h.status === 200, `status=${h.status}`);
  check('auth_required is true', health.auth_required === true, `got=${health.auth_required}`);
  /* Counted against the source of truth rather than a literal, so adding a frame
   * or theme does not fail a deploy check that has nothing to do with it. What
   * matters here is that /health reports the full set - a truncated list would
   * mean a workflow discovering capabilities gets an incomplete answer. */
  check(`all ${FRAME_TYPES.length} frame types exposed`,
    (health.frame_types || []).length === FRAME_TYPES.length,
    `got=${(health.frame_types || []).length}`);
  check(`all ${THEMES.length} themes exposed`,
    (health.themes || []).length === THEMES.length,
    `got=${(health.themes || []).length}`);

  // 2. auth is enforced
  const noKey = await req('POST', '/render', { body: { slides: [] } });
  check('no key rejected with 401', noKey.status === 401, `status=${noKey.status}`);

  const badKey = await req('POST', '/render', { body: { slides: [] }, headers: { 'x-api-key': 'wrong-key-same-len-ish' } });
  check('wrong key rejected with 401', badKey.status === 401, `status=${badKey.status}`);

  // 3. real render with correct key
  const good = await req('POST', '/render', {
    headers: { 'x-api-key': KEY },
    body: {
      theme: 'brand-apple',
      response_mode: 'urls',
      slides: [
        { type: 'cover', headline: 'Deploy check', subheadline: 'Verifying hosted configuration' },
        { type: 'stat', value: '1080', unit: 'x 1350', label: 'Exact Instagram 4:5 output' },
      ],
    },
  });
  check('authorised render returns 200', good.status === 200, `status=${good.status}`);

  let out = {};
  try { out = JSON.parse(good.buf.toString()); } catch (e) { /* noop */ }
  check('rendered 2 slides', out.count === 2, `count=${out.count}`);

  const first = (out.slides || [])[0] || {};
  check(
    'image URL uses PUBLIC_BASE_URL',
    typeof first.url === 'string' && first.url.startsWith('https://carousel.example.com/'),
    first.url || '(none)'
  );
  check(
    'reported dimensions are 1080x1350',
    first.width === 1080 && first.height === 1350,
    `${first.width}x${first.height}`
  );

  // 4. the PNG is actually fetchable and correct
  if (out.batch_id && first.filename) {
    const img = await req('GET', `/render/${out.batch_id}/${first.filename}`);
    const size = pngSize(img.buf);
    check('PNG retrievable', img.status === 200, `status=${img.status}`);
    check(
      'PNG bytes are 1080x1350',
      Boolean(size) && size.w === 1080 && size.h === 1350,
      size ? `${size.w}x${size.h} (${(img.buf.length / 1024).toFixed(0)} KB)` : 'not a PNG'
    );
  } else {
    check('PNG retrievable', false, 'no batch_id/filename returned');
  }

  // 5. bad content fails as 400, not 500
  const badContent = await req('POST', '/render', {
    headers: { 'x-api-key': KEY },
    body: { slides: [{ type: 'big-text', text: 'x'.repeat(200) }] },
  });
  check('over-long content returns 400', badContent.status === 400, `status=${badContent.status}`);

  /* 6. pagination survives the HTTP boundary.
   * This is the batching bug the workflow actually hit: 3 slides at a time out of
   * 7, which used to come back numbered 1/3 2/3 3/3. Checked over HTTP rather
   * than in unit tests alone, because the batch-level fields have to be read off
   * the request body and it is the wiring that broke. */
  const paged = await req('POST', '/render', {
    headers: { 'x-api-key': KEY },
    body: {
      total_slides: 7,
      start_index: 4,
      response_mode: 'urls',
      slides: [
        { type: 'big-text', text: 'Four' },
        { type: 'big-text', text: 'Five' },
        { type: 'big-text', text: 'Six' },
      ],
    },
  });
  let pagedOut = {};
  try { pagedOut = JSON.parse(paged.buf.toString()); } catch (e) { /* noop */ }
  const pagers = (pagedOut.slides || []).map((s) => `${s.slide_index}/${s.total_slides}`);
  check(
    'batch of 3 from a 7-slide carousel paginates 4/7 5/7 6/7',
    pagers.join(' ') === '4/7 5/7 6/7',
    pagers.length ? pagers.join(' ') : `status=${paged.status}`
  );
  check(
    'filenames follow the carousel index, not the batch position',
    (pagedOut.slides || []).map((s) => s.filename).join(',')
      === 'slide_04.png,slide_05.png,slide_06.png',
    (pagedOut.slides || []).map((s) => s.filename).join(',') || '(none)'
  );

  /* 7. a chart renders end to end. The SVG is built in-process, but this is the
   * only check that the inline SVG survives Playwright and produces a real PNG in
   * a hosted container. */
  const chart = await req('POST', '/render', {
    headers: { 'x-api-key': KEY },
    body: {
      response_mode: 'urls',
      slides: [{
        type: 'chart',
        eyebrow: 'By the numbers',
        headline: 'Ad revenue grew nearly 7x in five months',
        chart: {
          kind: 'progression',
          unit: 'USD_M',
          sources: [{ name: 'The Information' }],
          series: [
            { label: 'Apr 2026', value: 12 },
            { label: 'Aug 2026', value: 83, emphasis: true },
          ],
        },
        takeaway: 'The pace is what makes this a $1B annualized run rate.',
      }],
    },
  });
  let chartOut = {};
  try { chartOut = JSON.parse(chart.buf.toString()); } catch (e) { /* noop */ }
  check('chart slide renders', chart.status === 200,
    chart.status === 200 ? 'status=200' : `status=${chart.status} ${chartOut.error || ''}`);

  const chartSlide = (chartOut.slides || [])[0] || {};
  if (chartOut.batch_id && chartSlide.filename) {
    const img = await req('GET', `/render/${chartOut.batch_id}/${chartSlide.filename}`);
    const size = pngSize(img.buf);
    check('chart PNG bytes are 1080x1350',
      Boolean(size) && size.w === 1080 && size.h === 1350,
      size ? `${size.w}x${size.h} (${(img.buf.length / 1024).toFixed(0)} KB)` : 'not a PNG');
  } else {
    check('chart PNG bytes are 1080x1350', false, 'no chart batch returned');
  }

  /* 8. an unchartable spec is the caller's fault, not a 500. A workflow needs to
   * be told to fall back to a metric card, not sent down an error path. */
  const badChart = await req('POST', '/render', {
    headers: { 'x-api-key': KEY },
    body: {
      slides: [{
        type: 'chart',
        headline: 'One point is not a trend',
        chart: { kind: 'line', unit: 'USD_M', series: [{ label: 'Apr', value: 12 }] },
      }],
    },
  });
  let badChartOut = {};
  try { badChartOut = JSON.parse(badChart.buf.toString()); } catch (e) { /* noop */ }
  check('unchartable data returns 400 with a usable message',
    badChart.status === 400 && /at least 3 data points/.test(badChartOut.error || ''),
    `status=${badChart.status} ${badChartOut.error || ''}`);

  /* 9. CONCURRENT LOAD.
   * This is the crash the queue exists to prevent: clicking several research
   * buttons fans out into several carousel renders arriving at once, each of which
   * used to launch its own Chromium. On a 512MB container that is an OOM kill, and
   * the caller sees a dropped connection rather than an error it can act on.
   *
   * The requirement is not "all succeed" - rejecting under load is correct. It is
   * that every request gets a DEFINITE answer: 200, or 429 with a retry hint.
   * Never a 500, and never a dead socket. */
  const CONCURRENT = 8;
  const burst = [];
  for (let i = 0; i < CONCURRENT; i++) {
    burst.push(req('POST', '/render', {
      headers: { 'x-api-key': KEY },
      body: {
        total_slides: CONCURRENT,
        start_index: i + 1,
        slides: [{ type: 'big-text', text: `Concurrent render ${i + 1}` }],
      },
    }).then((r) => {
      let body = {};
      try { body = JSON.parse(r.buf.toString()); } catch (e) { /* noop */ }
      return { status: r.status, body };
    }, (err) => ({ status: 0, body: { error: err.message } })));
  }

  const results = await Promise.all(burst);
  const ok = results.filter((r) => r.status === 200).length;
  const throttled = results.filter((r) => r.status === 429).length;
  const broken = results.filter((r) => r.status !== 200 && r.status !== 429);

  check(
    `${CONCURRENT} concurrent renders all answered definitively`,
    broken.length === 0,
    `${ok} ok, ${throttled} throttled` + (broken.length
      ? `, BROKEN: ${broken.map((b) => `${b.status} ${b.body.error || ''}`).join(' | ')}`
      : '')
  );

  // A throttled caller must be told how long to wait, or it can only guess.
  const sample = results.find((r) => r.status === 429);
  check(
    'throttled responses carry a retry hint',
    !sample || (typeof sample.body.retry_after_seconds === 'number' && sample.body.retry_after_seconds >= 1),
    sample ? `retry_after_seconds=${sample.body.retry_after_seconds}` : '(none throttled - queue absorbed the burst)'
  );

  // 10. the service is still alive and reporting load after the burst
  const after = await req('GET', '/health');
  let afterHealth = {};
  try { afterHealth = JSON.parse(after.buf.toString()); } catch (e) { /* noop */ }
  check('service is healthy after the burst', after.status === 200, `status=${after.status}`);
  check(
    'health reports queue load and memory',
    Boolean(afterHealth.load) && typeof afterHealth.load.completed === 'number'
      && Boolean(afterHealth.memory_mb) && typeof afterHealth.memory_mb.rss === 'number',
    afterHealth.load
      ? `completed=${afterHealth.load.completed} peak_in_flight=${afterHealth.load.max_in_flight_seen} rss=${afterHealth.memory_mb.rss}MB`
      : '(missing)'
  );

  /* One browser, not eight. This is the assertion that actually proves the fix -
   * the burst above would pass even with a browser per request, right up until the
   * container ran out of memory. */
  check(
    'the burst used one shared browser',
    Boolean(afterHealth.browser) && afterHealth.browser.launches <= 2,
    afterHealth.browser
      ? `launches=${afterHealth.browser.launches} recycles=${afterHealth.browser.recycles} crashes=${afterHealth.browser.crashes}`
      : '(missing)'
  );

  check(
    'no browser crashed during the burst',
    Boolean(afterHealth.browser) && afterHealth.browser.crashes === 0,
    afterHealth.browser ? `crashes=${afterHealth.browser.crashes}` : '(missing)'
  );

  const failed = checks.filter((c) => !c.pass);
  console.log('');
  console.log(`${checks.length - failed.length}/${checks.length} passed`);
  console.log(failed.length === 0 ? 'DEPLOY CONFIG OK' : 'DEPLOY CONFIG FAILED');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('checker error:', e.message);
  process.exit(1);
});
