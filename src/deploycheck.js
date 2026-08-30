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

process.env.PORT = process.env.PORT || '8123';
process.env.API_KEY = 'deploycheck-key-abc123';
process.env.PUBLIC_BASE_URL = 'https://carousel.example.com';

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
  check('12 frame types exposed', (health.frame_types || []).length === 12, `got=${(health.frame_types || []).length}`);
  check('11 themes exposed', (health.themes || []).length === 11, `got=${(health.themes || []).length}`);

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

  const failed = checks.filter((c) => !c.pass);
  console.log('');
  console.log(`${checks.length - failed.length}/${checks.length} passed`);
  console.log(failed.length === 0 ? 'DEPLOY CONFIG OK' : 'DEPLOY CONFIG FAILED');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('checker error:', e.message);
  process.exit(1);
});
