'use strict';

/* Chart regression tests.
 *
 * These cover two classes of failure that a passing render will not reveal:
 *
 *   1. EDITORIAL RULES. A chart with a truncated baseline, an unlabelled axis,
 *      or a missing source renders perfectly and is still not publishable. The
 *      rules must be enforced in code, so they are tested in code.
 *
 *   2. GEOMETRY that a visual QA caught once and would catch again only by
 *      someone looking. Every defect the image audit found is pinned here as an
 *      assertion against the emitted SVG, because the smoke test only proves the
 *      PNG is 1080x1350 - it cannot see two strings drawn on top of each other.
 *
 * Assertions are made against the SVG string rather than a rendered image so the
 * suite stays fast and needs no browser.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  renderChart,
  renderBar,
  renderLine,
  renderShare,
  renderTimelineScaled,
  buildAxis,
  formatValue,
  formatNumber,
  niceStep,
  dateToDays,
  wrapToWidth,
  resolveLabelBoxes,
  suggestChartKind,
  textWidth,
  CHART_KINDS,
} = require('../src/charts');

/* ---------------------------------------------------------------- fixtures */

const CPC = {
  kind: 'bar', unit: 'USD',
  sources: [{ name: 'Reuters' }], as_of: 'Aug 2026',
  series: [
    { label: 'ChatGPT Ads', value: 1.4, emphasis: true },
    { label: 'Bing Ads', value: 1.85 },
    { label: 'Google Search', value: 2.7 },
    { label: 'LinkedIn Ads', value: 5.6 },
  ],
};

const REVENUE = {
  kind: 'line', unit: 'USD_M',
  sources: [{ name: 'The Information' }],
  series: [
    { label: 'Apr', value: 12 }, { label: 'May', value: 21 },
    { label: 'Jun', value: 38 }, { label: 'Jul', value: 57 },
    { label: 'Aug', value: 83 },
  ],
};

const SHARE = {
  kind: 'share', unit: 'percent',
  sources: [{ name: 'Reuters' }],
  series: [
    { label: 'Organic answers', value: 92 },
    { label: 'Sponsored results', value: 8 },
  ],
};

const TIMELINE = {
  kind: 'timeline-scaled', unit: 'count',
  sources: [{ name: 'OpenAI Blog' }],
  series: [
    { label: 'Ads business launches', value: 1, date: '2026-03' },
    { label: 'First $12M month', value: 1, date: '2026-04' },
    { label: 'Self-serve platform opens', value: 1, date: '2026-06' },
    { label: '$1B run rate reached', value: 1, date: '2026-09', emphasis: true },
  ],
};

/* Pull every <text> element out as { x, y, anchor, size, content }. */
function texts(svg) {
  const out = [];
  const re = /<text ([^>]*)>([^<]*)<\/text>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const attrs = m[1];
    const grab = function (name) {
      const a = new RegExp(name + '="([^"]*)"').exec(attrs);
      return a ? a[1] : null;
    };
    out.push({
      x: Number(grab('x')),
      y: Number(grab('y')),
      anchor: grab('text-anchor') || 'start',
      size: Number(grab('font-size')),
      cls: grab('class') || '',
      content: m[2],
    });
  }
  return out;
}

/* Left and right edges of a text element, from its anchor and estimated width. */
function bounds(t) {
  const w = textWidth(t.content, t.size);
  if (t.anchor === 'middle') { return { left: t.x - w / 2, right: t.x + w / 2 }; }
  if (t.anchor === 'end') { return { left: t.x - w, right: t.x }; }
  return { left: t.x, right: t.x + w };
}

/* Any two text elements sharing a baseline whose boxes intersect. Same-baseline
 * is the only case that produces the garbled-string defect; text on different
 * rows can share an x range safely. */
function overlappingPairs(svg, tolerance) {
  const tol = tolerance === undefined ? 6 : tolerance;
  const all = texts(svg);
  const bad = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (Math.abs(all[i].y - all[j].y) > tol) { continue; }
      const a = bounds(all[i]);
      const b = bounds(all[j]);
      if (a.left < b.right - 1 && b.left < a.right - 1) {
        bad.push(all[i].content + ' <> ' + all[j].content);
      }
    }
  }
  return bad;
}

/* ------------------------------------------------------- rule 1: zero baseline */

test('every value axis includes zero, whatever the data range', () => {
  // The classic misleading chart: 88, 91, 94 on an axis starting at 87 makes a
  // 7% difference look like a 10x one.
  const a = buildAxis([88, 91, 94], 'percent');
  assert.equal(a.min, 0, 'axis must start at zero even when data is tightly clustered high');

  const b = buildAxis([-4, -12, 3], 'percent');
  assert.ok(b.min <= -12 && b.max >= 3, 'negative data must be fully spanned');
  assert.ok(b.min < 0 && b.max > 0, 'a domain crossing zero must contain zero');

  // Degenerate input must still produce a drawable domain.
  const c = buildAxis([0, 0], 'count');
  assert.ok(c.max > c.min, 'all-zero data still needs a non-zero span');
});

test('the zero line is drawn as structure, not as a gridline', () => {
  const svg = renderBar(CPC).svg;
  assert.ok(/class="c-axis-zero"/.test(svg), 'expected an explicit zero axis element');
});

test('axis ticks land on 1-2-5 steps and never print negative zero', () => {
  assert.equal(niceStep(0.9), 1);
  assert.equal(niceStep(1.4), 2);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(23), 50);

  const a = buildAxis([-30, 45], 'percent');
  a.ticks.forEach(function (t) {
    assert.ok(!Object.is(t, -0), 'tick must not be negative zero');
  });
  assert.ok(a.ticks.indexOf(0) !== -1, 'a domain spanning zero must have a zero tick');
});

/* -------------------------------------------- rule 3: labels, units, sources */

test('a chart without a unit is refused', () => {
  assert.throws(
    () => renderChart({ kind: 'bar', series: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }),
    (e) => e.isValidation === true && /unit is required/.test(e.message)
  );
});

test('a chart with an unlabelled data point is refused', () => {
  assert.throws(
    () => renderChart({ kind: 'bar', unit: 'percent', series: [{ label: 'A', value: 1 }, { value: 2 }] }),
    (e) => e.isValidation === true && /label is required/.test(e.message)
  );
});

test('a non-finite value is refused rather than drawn as a zero-length bar', () => {
  assert.throws(
    () => renderChart({ kind: 'bar', unit: 'percent', series: [{ label: 'A', value: 1 }, { label: 'B', value: null }] }),
    (e) => e.isValidation === true && /finite number/.test(e.message)
  );
});

test('the unit is stated on the chart itself', () => {
  const svg = renderBar(CPC).svg;
  const found = texts(svg).some(function (t) { return /c-axis-unit/.test(t.cls) && t.content.length > 0; });
  assert.ok(found, 'expected a unit caption element');
});

test('every data point carries its value as text', () => {
  const svg = renderBar(CPC).svg;
  const content = texts(svg).map(function (t) { return t.content; });
  CPC.series.forEach(function (p) {
    assert.ok(content.indexOf(formatValue(p.value, CPC.unit)) !== -1,
      'expected the value ' + formatValue(p.value, CPC.unit) + ' to be printed');
  });
});

/* ------------------------------------------------ rule 4: baked-in attribution */

test('source attribution is baked into the SVG, not left to the template', () => {
  const r = renderBar(CPC);
  assert.match(r.source, /^Source: Reuters/);
  assert.ok(r.svg.indexOf('Source: Reuters') !== -1, 'the source must be inside the SVG');
  assert.match(r.source, /as of Aug 2026/, 'as_of must be carried when supplied');
});

test('multiple sources are all credited, never silently dropped', () => {
  const r = renderBar(Object.assign({}, CPC, {
    sources: [{ name: 'Reuters' }, { name: 'The Information' }],
  }));
  assert.ok(r.source.indexOf('Reuters') !== -1);
  assert.ok(r.source.indexOf('The Information') !== -1);
});

test('more than two sources are summarised with a count rather than truncated silently', () => {
  const r = renderBar(Object.assign({}, CPC, {
    sources: [{ name: 'Reuters' }, { name: 'Bloomberg' }, { name: 'FT' }, { name: 'WSJ' }],
  }));
  assert.match(r.source, /\+2 more/);
});

/* ---------------------------------------- rule 5: minimum and maximum points */

test('a line chart needs three points, because two is a segment not a trend', () => {
  assert.throws(
    () => renderChart({
      kind: 'line', unit: 'USD_M',
      series: [{ label: 'Apr', value: 12 }, { label: 'Aug', value: 83 }],
    }),
    (e) => e.isValidation === true && /at least 3 data points/.test(e.message)
  );
});

test('the refusal message points to a workable alternative', () => {
  try {
    renderChart({ kind: 'bar', unit: 'percent', series: [{ label: 'Only', value: 8 }] });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /metric card or sentence/,
      'a refusal must tell the caller what to do instead');
  }
});

test('too many points is refused rather than rendered illegibly', () => {
  const many = [];
  for (let i = 0; i < 9; i++) { many.push({ label: 'Item ' + i, value: i + 1 }); }
  assert.throws(
    () => renderChart({ kind: 'bar', unit: 'count', series: many }),
    (e) => e.isValidation === true && /at most 7/.test(e.message)
  );
});

/* --------------------------------------------------- per-kind honesty guards */

test('a share chart rejects negative values and a zero total', () => {
  assert.throws(
    () => renderChart({ kind: 'share', unit: 'percent', series: [{ label: 'A', value: -5 }, { label: 'B', value: 20 }] }),
    (e) => e.isValidation === true && /never negative/.test(e.message)
  );
  assert.throws(
    () => renderChart({ kind: 'share', unit: 'percent', series: [{ label: 'A', value: 0 }, { label: 'B', value: 0 }] }),
    (e) => e.isValidation === true && /positive total/.test(e.message)
  );
});

test('share percentages are computed from the values, so they always total 100', () => {
  // A caller passing 60 and 60 gets 50/50, not 60/60.
  const svg = renderShare({
    kind: 'share', unit: 'count', sources: [{ name: 'X' }],
    series: [{ label: 'A', value: 60 }, { label: 'B', value: 60 }],
  }).svg;
  const pcts = texts(svg).filter(function (t) { return /50%/.test(t.content); });
  assert.ok(pcts.length >= 2, 'equal values must render as 50% each');
});

test('a scaled timeline refuses undated points instead of inventing spacing', () => {
  assert.throws(
    () => renderChart({
      kind: 'timeline-scaled', unit: 'count',
      series: [{ label: 'A', value: 1, date: '2026-03' }, { label: 'B', value: 1 }],
    }),
    (e) => e.isValidation === true && /requires a date on every point/.test(e.message)
  );
});

test('a scaled timeline refuses points that all share one date', () => {
  assert.throws(
    () => renderChart({
      kind: 'timeline-scaled', unit: 'count',
      series: [
        { label: 'A', value: 1, date: '2026-03' },
        { label: 'B', value: 1, date: '2026-03' },
      ],
    }),
    (e) => e.isValidation === true && /two different dates/.test(e.message)
  );
});

test('grouped bars require a name for every series', () => {
  assert.throws(
    () => renderChart({
      kind: 'grouped-bar', unit: 'USD', series_names: ['Only one'],
      series: [{ label: 'A', values: [1, 2] }, { label: 'B', values: [3, 4] }],
    }),
    (e) => e.isValidation === true && /series_names naming all 2/.test(e.message)
  );
});

test('grouped bars require the same shape in every group', () => {
  assert.throws(
    () => renderChart({
      kind: 'grouped-bar', unit: 'USD', series_names: ['A', 'B'],
      series: [{ label: 'X', values: [1, 2] }, { label: 'Y', values: [3] }],
    }),
    (e) => e.isValidation === true && /same number of values/.test(e.message)
  );
});

/* ------------------------------------------------- geometry regression guards */

test('no chart draws two strings on the same baseline', () => {
  // The garbled "USD" over "$6.00" defect. Checked across every kind.
  const specs = {
    'bar': CPC,
    'grouped-bar': {
      kind: 'grouped-bar', unit: 'USD', series_names: ['ChatGPT Ads', 'Google Search'],
      sources: [{ name: 'Reuters' }],
      series: [
        { label: 'Cost per click', values: [1.4, 2.7] },
        { label: 'Cost per lead', values: [42, 58.4] },
      ],
    },
    'line': REVENUE,
    'progression': {
      kind: 'progression', unit: 'USD_M', sources: [{ name: 'The Information' }],
      series: [{ label: 'Apr 2026', value: 12 }, { label: 'Aug 2026', value: 83 }],
    },
    'share': SHARE,
    'timeline-scaled': TIMELINE,
  };

  CHART_KINDS.forEach(function (kind) {
    const svg = renderChart(specs[kind]).svg;
    const bad = overlappingPairs(svg);
    assert.deepEqual(bad, [], kind + ' has overlapping text: ' + bad.join(' | '));
  });
});

test('no text is positioned outside the chart box', () => {
  const specs = [CPC, REVENUE, SHARE, TIMELINE];
  specs.forEach(function (spec) {
    const r = renderChart(spec);
    texts(r.svg).forEach(function (t) {
      const b = bounds(t);
      // 2px of slack absorbs the width estimate; a real clip is far larger.
      assert.ok(b.left >= -2, spec.kind + ': "' + t.content + '" starts at ' + b.left);
      assert.ok(b.right <= r.width + 2, spec.kind + ': "' + t.content + '" ends at ' + b.right + ' (width ' + r.width + ')');
      assert.ok(t.y >= 0 && t.y <= r.height, spec.kind + ': "' + t.content + '" y=' + t.y);
    });
  });
});

test('no text is below the legible floor of 22px', () => {
  [CPC, REVENUE, SHARE, TIMELINE].forEach(function (spec) {
    const r = renderChart(spec);
    texts(r.svg).forEach(function (t) {
      assert.ok(t.size >= 22, spec.kind + ': "' + t.content + '" is ' + t.size + 'px');
    });
  });
});

test('bar value labels are all placed the same way', () => {
  // The longest bar previously fell back to an inside-the-bar label, which read
  // as a different style from every other label on the same chart.
  const svg = renderBar(CPC).svg;
  const inset = texts(svg).filter(function (t) { return /c-value-inset/.test(t.cls); });
  assert.equal(inset.length, 0, 'no positive bar should need an inset value label');
});

test('a share too narrow to label in place says so instead of cramming the number in', () => {
  const r = renderShare(SHARE);
  assert.ok(
    r.warnings.some(function (w) { return /too narrow to label in place/.test(w); }),
    'expected a warning for the 8% segment'
  );
  // And the value must still be reachable in the legend.
  assert.ok(r.svg.indexOf('8%') !== -1, 'the share must still appear in the legend');
});

test('a percentage share does not print the same number twice in one row', () => {
  /* The "92% 92%" defect: with unit=percent the value and the share are the same
   * figure, and the legend was drawing both columns. One in-bar label plus one
   * legend entry is correct - the in-bar number reads the geometry, the legend
   * reads the category - but neither may appear twice. */
  const svg = renderShare(SHARE).svg;
  const all = texts(svg);

  const inBar = all.filter(function (t) { return /c-share-pct/.test(t.cls) && t.content === '92%'; });
  assert.equal(inBar.length, 1, 'expected one in-bar label, got ' + inBar.length);

  const inLegend = all.filter(function (t) { return /c-value-sm/.test(t.cls) && t.content === '92%'; });
  assert.equal(inLegend.length, 1, 'expected one legend value, got ' + inLegend.length);

  // The two must not be on the same row - that was the visible garble.
  assert.ok(Math.abs(inBar[0].y - inLegend[0].y) > 20, 'in-bar and legend values share a baseline');
});

test('a non-percentage share still shows both the share and the absolute figure', () => {
  const svg = renderShare({
    kind: 'share', unit: 'USD_M', sources: [{ name: 'X' }],
    series: [{ label: 'Ads', value: 83 }, { label: 'Subscriptions', value: 17 }],
  }).svg;
  const content = texts(svg).map(function (t) { return t.content; });
  assert.ok(content.indexOf('83%') !== -1, 'expected the share');
  assert.ok(content.indexOf('$83M') !== -1, 'expected the absolute value');
});

test('timeline labels shift sideways rather than overlapping, and keep a leader', () => {
  const r = renderTimelineScaled(TIMELINE);
  assert.deepEqual(overlappingPairs(r.svg), []);
  // Every event label must survive intact - truncation here would lose the point
  // of the slide.
  const content = texts(r.svg).map(function (t) { return t.content; }).join(' | ');
  ['Ads', 'business', 'launches', 'Self-serve', 'platform', 'opens', 'run', 'rate', 'reached']
    .forEach(function (word) {
      assert.ok(content.indexOf(word) !== -1, 'expected the word "' + word + '" in the timeline');
    });
  assert.deepEqual(r.warnings, [], 'no label should need truncating at this density');
});

test('timeline dots stay on their true dates even when labels move', () => {
  const r = renderTimelineScaled(TIMELINE);
  const circles = [];
  const re = /<circle cx="([\d.]+)"/g;
  let m;
  while ((m = re.exec(r.svg)) !== null) { circles.push(Number(m[1])); }
  assert.equal(circles.length, 4);

  // Mar->Apr is 1 month, Jun->Sep is 3. The later gap must be visibly wider.
  const gap1 = circles[1] - circles[0];
  const gap3 = circles[3] - circles[2];
  assert.ok(gap3 > gap1 * 2, 'proportional spacing lost: gaps were ' + gap1 + ' and ' + gap3);
});

/* -------------------------------------------------------- support primitives */

test('label wrapping prefers two lines over shrinking the type', () => {
  const w = wrapToWidth('Self-serve advertising platform opens to all accounts', 28, 220, 2);
  assert.equal(w.lines.length, 2);
  w.lines.forEach(function (l) {
    assert.ok(textWidth(l, 28) <= 220 + 1, 'line too wide: ' + l);
  });
});

test('overflowing text is truncated on the last line only', () => {
  const w = wrapToWidth('one two three four five six seven eight nine ten eleven twelve', 28, 160, 2);
  assert.equal(w.lines.length, 2);
  assert.equal(w.truncated, true);
  assert.match(w.lines[1], /\u2026$/, 'the ellipsis belongs at the end');
  assert.ok(!/\u2026/.test(w.lines[0]), 'the first line must not be truncated');
});

test('label box resolution separates collisions and keeps everything in frame', () => {
  const r = resolveLabelBoxes([100, 120, 140], [180, 180, 180], 0, 888, 18);
  for (let i = 1; i < r.centres.length; i++) {
    assert.ok(r.centres[i] - r.centres[i - 1] >= 180 + 18 - 1,
      'boxes still overlap: ' + JSON.stringify(r.centres));
  }
  r.centres.forEach(function (cx) {
    assert.ok(cx - 90 >= -1 && cx + 90 <= 889, 'box left the frame at ' + cx);
  });
  assert.equal(r.adjusted, true);
});

test('label box resolution leaves non-colliding boxes untouched', () => {
  const r = resolveLabelBoxes([100, 500], [120, 120], 0, 888, 18);
  assert.deepEqual(r.centres, [100, 500]);
  assert.equal(r.adjusted, false);
});

test('date parsing accepts year, year-month and full dates and rejects junk', () => {
  assert.ok(dateToDays('2026') !== null);
  assert.ok(dateToDays('2026-03') !== null);
  assert.ok(dateToDays('2026-03-15') !== null);
  assert.ok(dateToDays('2026-03') < dateToDays('2026-04'));
  assert.equal(dateToDays('March 2026'), null);
  assert.equal(dateToDays('2026-13'), null);
  assert.equal(dateToDays(''), null);
});

test('value formatting keeps cents where they carry meaning', () => {
  // A $1.40 CPC rounded to "$1" would misstate the figure.
  assert.equal(formatValue(1.4, 'USD'), '$1.40');
  assert.equal(formatValue(2.7, 'USD'), '$2.70');
  assert.equal(formatValue(83, 'USD_M'), '$83M');
  assert.equal(formatValue(1, 'USD_B'), '$1B');
  assert.equal(formatValue(8, 'percent'), '8%');
  assert.equal(formatValue(3400, 'tokens_per_sec'), '3,400');
  assert.equal(formatValue(40000, 'count'), '40,000');
});

test('percentage-point change is reported as pp, never as a percentage of a percentage', () => {
  const svg = renderChart({
    kind: 'progression', unit: 'percent', sources: [{ name: 'X' }],
    series: [{ label: 'Before', value: 8 }, { label: 'After', value: 12 }],
  }).svg;
  const delta = texts(svg).find(function (t) { return /c-delta/.test(t.cls); });
  assert.match(delta.content, /pp$/, 'expected percentage points, got "' + delta.content + '"');
});

test('progression change falls back to an absolute delta when a ratio is meaningless', () => {
  // Growth from zero is not "infinite percent".
  const svg = renderChart({
    kind: 'progression', unit: 'USD_M', sources: [{ name: 'X' }],
    series: [{ label: 'Launch', value: 0 }, { label: 'Now', value: 83 }],
  }).svg;
  const delta = texts(svg).find(function (t) { return /c-delta/.test(t.cls); });
  assert.match(delta.content, /change$/);
  assert.ok(!/Infinity|NaN/.test(delta.content), 'got "' + delta.content + '"');
});

test('a large multiple is stated as "Nx" rather than a four-digit percentage', () => {
  const svg = renderChart({
    kind: 'progression', unit: 'USD_M', sources: [{ name: 'X' }],
    series: [{ label: 'Apr', value: 12 }, { label: 'Aug', value: 83 }],
  }).svg;
  const delta = texts(svg).find(function (t) { return /c-delta/.test(t.cls); });
  assert.equal(delta.content, '6.9x increase');
});

/* ------------------------------------------------------------- kind selection */

test('chart kind selection matches the shape of the claim', () => {
  assert.equal(suggestChartKind({
    claim_type: 'comparison', unit: 'USD',
    series: [{ label: 'ChatGPT Ads', value: 1.4 }, { label: 'Google Search', value: 2.7 }],
  }), 'bar');

  // Evenly spaced dates over three or more points read as a trend.
  assert.equal(suggestChartKind({
    unit: 'USD_M',
    series: [
      { label: 'Apr', value: 12, date: '2026-04' },
      { label: 'May', value: 21, date: '2026-05' },
      { label: 'Jun', value: 38, date: '2026-06' },
    ],
  }), 'line');

  // Uneven gaps are the case timeline-scaled exists for.
  assert.equal(suggestChartKind({
    unit: 'count',
    series: [
      { label: 'Launch', value: 1, date: '2026-03' },
      { label: 'Beta', value: 1, date: '2026-04' },
      { label: 'GA', value: 1, date: '2026-11' },
    ],
  }), 'timeline-scaled');

  assert.equal(suggestChartKind({
    unit: 'USD',
    series: [{ label: 'A', values: [1, 2] }, { label: 'B', values: [3, 4] }],
  }), 'grouped-bar');
});

test('claims with no chart in them are declined, not forced into one', () => {
  assert.equal(suggestChartKind(null), null);
  assert.equal(suggestChartKind({ text: 'The policy shift changes how agencies plan' }), null);
  // One data point is a metric card, not a chart.
  assert.equal(suggestChartKind({ unit: 'USD_B', series: [{ label: 'Run rate', value: 1 }] }), null);
  // A series without a unit cannot be given a readable axis.
  assert.equal(suggestChartKind({ series: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }), null);
});

test('every suggested kind actually renders', () => {
  // The planner must never be told to build a chart that would then be refused.
  const claim = {
    unit: 'USD_M', claim_type: 'fact',
    series: [
      { label: 'Apr', value: 12, date: '2026-04' },
      { label: 'Jun', value: 38, date: '2026-06' },
      { label: 'Aug', value: 83, date: '2026-08' },
    ],
  };
  const kind = suggestChartKind(claim);
  assert.ok(kind);
  const r = renderChart({
    kind: kind, unit: claim.unit, series: claim.series, sources: [{ name: 'X' }],
  });
  assert.ok(r.svg.length > 0);
});

/* ------------------------------------------------------------------ ordering */

test('bar order is the caller\'s by default, because leading with the subject is editorial', () => {
  /* Most charting libraries sort for you. Here sorting is opt-in: a comparison
   * frequently puts its subject first on purpose ("ChatGPT Ads", then the
   * competitors), and silently reordering would change what the slide is about. */
  const svg = renderBar(CPC).svg;
  const labels = texts(svg).filter(function (t) { return /c-label/.test(t.cls); })
    .map(function (t) { return t.content; });
  assert.deepEqual(labels, ['ChatGPT Ads', 'Bing Ads', 'Google Search', 'LinkedIn Ads']);
});

test('sort ascending and descending reorder a categorical chart', () => {
  const asc = renderBar(Object.assign({}, CPC, { sort: 'asc' })).svg;
  const ascLabels = texts(asc).filter(function (t) { return /c-label/.test(t.cls); })
    .map(function (t) { return t.content; });
  assert.deepEqual(ascLabels, ['ChatGPT Ads', 'Bing Ads', 'Google Search', 'LinkedIn Ads']);

  const desc = renderBar(Object.assign({}, CPC, { sort: 'desc' })).svg;
  const descLabels = texts(desc).filter(function (t) { return /c-label/.test(t.cls); })
    .map(function (t) { return t.content; });
  assert.deepEqual(descLabels, ['LinkedIn Ads', 'Google Search', 'Bing Ads', 'ChatGPT Ads']);
});

test('sorting does not mutate the caller\'s series', () => {
  // The same spec may be rendered again, or held in an n8n plan.
  const spec = Object.assign({}, CPC, { sort: 'desc' });
  const before = spec.series.map(function (p) { return p.label; });
  renderBar(spec);
  assert.deepEqual(spec.series.map(function (p) { return p.label; }), before);
});

test('sorting an ordered chart kind is refused rather than silently ignored', () => {
  // Reordering a line or a timeline would falsify the sequence.
  ['line', 'timeline-scaled', 'progression'].forEach(function (kind) {
    assert.throws(
      () => renderChart({
        kind: kind, unit: 'USD_M', sort: 'desc', sources: [{ name: 'X' }],
        series: [
          { label: 'Apr', value: 12, date: '2026-04' },
          { label: 'Jun', value: 38, date: '2026-06' },
          { label: 'Aug', value: 83, date: '2026-08' },
        ],
      }),
      (e) => e.isValidation === true && /order is the axis/.test(e.message),
      kind + ' allowed sorting'
    );
  });
});

test('an unknown sort mode is a caller error', () => {
  assert.throws(
    () => renderBar(Object.assign({}, CPC, { sort: 'biggest-first' })),
    (e) => e.isValidation === true && /chart.sort must be one of/.test(e.message)
  );
});

test('emphasis follows its point through a sort', () => {
  const svg = renderBar(Object.assign({}, CPC, { sort: 'desc' })).svg;
  // ChatGPT Ads is the emphasised point and is last after a descending sort, so
  // the key bar must be the final one rather than the first.
  const bars = [];
  const re = /<rect[^>]*class="([^"]*)"/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    if (/c-bar/.test(m[1])) { bars.push(m[1]); }
  }
  assert.equal(bars.length, 4);
  assert.ok(/c-bar-key/.test(bars[3]), 'emphasis did not travel with its point');
});

/* ------------------------------------------------------------------ escaping */

test('source-derived text is escaped, so a stray angle bracket cannot break the SVG', () => {
  const svg = renderBar({
    kind: 'bar', unit: 'count',
    sources: [{ name: 'A & B <Research>' }],
    series: [{ label: '<script>x</script>', value: 5 }, { label: 'Q1 & Q2', value: 9 }],
  }).svg;
  assert.ok(svg.indexOf('<script>') === -1, 'raw markup leaked into the SVG');
  assert.ok(svg.indexOf('&amp;') !== -1, 'ampersands must be escaped');
  // Element count must be unchanged by the hostile input.
  assert.ok(texts(svg).length > 0);
});

test('an unrecognised unit is passed through rather than leaving the axis blank', () => {
  const r = renderBar({
    kind: 'bar', unit: 'widgets_per_hour', sources: [{ name: 'X' }],
    series: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }],
  });
  assert.equal(r.unit_label, 'widgets per hour');
});
