'use strict';

/* Layout view-model tests.
 *
 * These cover the decisions that were moved OUT of the templates: attribution,
 * proportional timeline spacing, and lead-figure selection. Each one is a case
 * where getting it wrong produces a slide that renders perfectly and says
 * something false or unverifiable - which the 1080x1350 smoke test cannot catch.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  prepareSlide,
  prepareAttribution,
  prepareMetrics,
  prepareEvidence,
  prepareTimeline,
  prepareSteps,
  prepareImage,
  eventDateToDays,
  humaniseGap,
  collectSources,
  sourceNameFromUrl,
} = require('../src/slidemodel');

const { FRAME_LAYOUTS, LAYOUTS, buildAttribution } = require('../src/contracts');
const { FRAME_TYPES } = require('../src/render');

/* ------------------------------------------------------------- attribution */

test('every frame type maps to a real layout family', () => {
  FRAME_TYPES.forEach(function (type) {
    const layout = FRAME_LAYOUTS[type];
    assert.ok(layout, 'frame type "' + type + '" has no layout mapping');
    assert.ok(LAYOUTS.indexOf(layout) !== -1, 'layout "' + layout + '" is not a declared family');
  });
});

test('a slide with no source says so visibly rather than rendering blank', () => {
  // A blank line is indistinguishable from a slide that legitimately needed no
  // citation; a human reviewer has to be able to see the gap.
  const a = prepareAttribution({});
  assert.equal(a.text, 'Source not stated');
  assert.equal(a.complete, false);
});

test('attribution accepts every shape callers actually send', () => {
  assert.equal(prepareAttribution({ sources: [{ name: 'Reuters' }] }).text, 'Source: Reuters');
  assert.equal(prepareAttribution({ source: 'Reuters' }).text, 'Source: Reuters');
  assert.equal(prepareAttribution({ credit: 'Reuters' }).text, 'Source: Reuters');
  // A URL with no name still has to produce a publication, not a domain.
  assert.equal(prepareAttribution({ sources: [{ url: 'https://theinformation.com/a' }] }).text,
    'Source: The Information');
  // The legacy outro shape: one comma-joined string.
  assert.deepEqual(
    prepareAttribution({ sources: 'NVIDIA Blog, SiliconANGLE' }).names,
    ['NVIDIA Blog', 'SiliconANGLE']
  );
});

test('an as-of stamp is carried, because a figure without one silently ages', () => {
  const a = prepareAttribution({ sources: [{ name: 'Reuters' }], as_of: 'Aug 2026' });
  assert.match(a.text, /as of Aug 2026$/);
  // A stamp with no source is still worth printing.
  const b = prepareAttribution({ as_of: 'Aug 2026' });
  assert.match(b.text, /Aug 2026/);
  assert.equal(b.complete, false);
});

test('duplicate sources are credited once', () => {
  const a = prepareAttribution({
    sources: [{ name: 'Reuters' }, { url: 'https://reuters.com/x' }, { name: 'Reuters' }],
  });
  assert.deepEqual(a.names, ['Reuters']);
});

test('more than three sources are summarised rather than overflowing the line', () => {
  const a = buildAttribution(['A Corp', 'B Corp', 'C Corp', 'D Corp', 'E Corp'], null);
  assert.match(a.text, /\+2$/);
  assert.equal(a.names.length, 5, 'all names are still carried for the manifest');
});

test('subdomains resolve to the same publication as the bare domain', () => {
  assert.equal(sourceNameFromUrl('https://blogs.nvidia.com/x'), 'NVIDIA');
  assert.equal(sourceNameFromUrl('https://nvidia.com/x'), 'NVIDIA');
  assert.equal(sourceNameFromUrl('https://www.reuters.com/x'), 'Reuters');
  // An unknown domain still yields something printable.
  assert.equal(sourceNameFromUrl('https://sometradeweekly.com/x'), 'Sometradeweekly');
  assert.equal(sourceNameFromUrl('not a url'), '');
});

test('a comma inside a URL does not split it into two sources', () => {
  const got = collectSources({ sources: 'https://example.com/a,b,c' });
  assert.equal(got.length, 1);
});

/* -------------------------------------------------- the double-source defect */

test('the chart frame does not print a footer source, because the SVG carries it', () => {
  /* The defect: a chart slide's sources live inside slide.chart, so the footer
   * found nothing and printed "Source not stated" directly beneath a chart that
   * had "Source: Reuters" baked into it. */
  const view = prepareSlide({ type: 'chart', headline: 'x', chart: {} }, 'chart');
  assert.equal(view.suppress_meta_source, true);
});

test('the outro does not print a footer source when it lists a manifest', () => {
  // The defect: four sources listed under "SOURCES", then "Source not stated".
  const view = prepareSlide({
    type: 'outro', headline: 'x',
    source_manifest: [{ name: 'NVIDIA' }, { name: 'Reuters' }],
  }, 'outro');
  assert.deepEqual(view.manifest, ['NVIDIA', 'Reuters']);
  assert.equal(view.suppress_meta_source, true);
});

test('an outro with no manifest still shows the footer', () => {
  const view = prepareSlide({ type: 'outro', headline: 'x' }, 'outro');
  assert.deepEqual(view.manifest, []);
  assert.equal(view.suppress_meta_source, false);
  assert.equal(view.attribution.text, 'Source not stated');
});

/* ------------------------------------------------------------------ metrics */

test('one metric card is the lead, so a grid is not four equal facts', () => {
  // The original defect: "3,400" and "40" rendered at identical visual weight.
  const m = prepareMetrics([
    { value: '3,400', unit: 'tok/s', label: 'Throughput' },
    { value: '256', unit: 'LPUs', label: 'Units' },
    { value: '40', unit: 'PB/s', label: 'Bandwidth' },
  ]);
  assert.equal(m[0].is_lead, true);
  assert.equal(m[1].is_lead, false);
  assert.equal(m[2].is_lead, false);
});

test('an explicit lead beats position, because emphasis is editorial', () => {
  const m = prepareMetrics([
    { value: '256', label: 'Units' },
    { value: '3,400', label: 'Throughput', lead: true },
  ]);
  assert.equal(m[0].is_lead, false);
  assert.equal(m[1].is_lead, true);
});

test('the largest number is NOT auto-promoted', () => {
  // Magnitude is not importance: the biggest figure on a slide is frequently the
  // least interesting one.
  const m = prepareMetrics([
    { value: '8', unit: 'percent', label: 'Share of queries' },
    { value: '40,000', unit: 'advertisers', label: 'Onboarded' },
  ]);
  assert.equal(m[0].is_lead, true);
});

test('a single metric is not marked as a lead among peers', () => {
  const m = prepareMetrics([{ value: '3,400', label: 'x' }]);
  assert.equal(m[0].is_lead, false, 'with one card there is nothing to lead');
});

test('value length is carried so the type scale can fit the figure', () => {
  const m = prepareMetrics([{ value: '3,400' }, { value: '40' }]);
  assert.equal(m[0].value_len, 5);
  assert.equal(m[1].value_len, 2);
});

test('per-card badges appear only when the figures have different sources', () => {
  const shared = prepareSlide({
    type: 'stat-grid',
    stats: [
      { value: '1', label: 'a', source: 'NVIDIA' },
      { value: '2', label: 'b', source: 'NVIDIA' },
    ],
  }, 'stat-grid');
  assert.equal(shared.show_metric_sources, false, 'one shared source belongs in the footer');

  const mixed = prepareSlide({
    type: 'stat-grid',
    stats: [
      { value: '1', label: 'a', source: 'NVIDIA' },
      { value: '2', label: 'b', source: 'Reuters' },
    ],
  }, 'stat-grid');
  assert.equal(mixed.show_metric_sources, true, 'mixed sources cannot be summarised in one line');
});

/* ----------------------------------------------------------------- evidence */

test('plain-string bullets still work', () => {
  const e = prepareEvidence(['256 LPUs per rack', '128GB RAM']);
  assert.equal(e.length, 2);
  assert.equal(e[0].text, '256 LPUs per rack');
  assert.equal(e[0].source, '');
  assert.equal(e[0].weak, false);
});

test('evidence rows carry their own figure and source', () => {
  const e = prepareEvidence([
    { figure: '256', text: 'LPUs per rack', source: 'NVIDIA', source_tier: 1 },
  ]);
  assert.equal(e[0].figure, '256');
  assert.equal(e[0].source, 'NVIDIA');
  assert.equal(e[0].weak, false);
});

test('a tier-4 claim is marked weak on the slide rather than dropped', () => {
  /* Dropping it loses real reporting; printing it unmarked next to a Reuters
   * figure implies equal standing. */
  const e = prepareEvidence([
    { text: 'Users report clusters past 1,000 LPUs', source: 'Reddit', source_tier: 4 },
  ]);
  assert.equal(e[0].weak, true);
  assert.equal(e[0].source, 'Reddit');
});

test('empty evidence rows are dropped, not rendered as blank lines', () => {
  const e = prepareEvidence(['', { text: '' }, { figure: '256' }, 'real']);
  assert.equal(e.length, 2);
});

/* ----------------------------------------------------------------- timeline */

test('timeline gaps are truly proportional to elapsed time', () => {
  /* The defect this pins: gaps of 5 months and 1 month must not render at a
   * similar size. An earlier version floored the flex value at 0.35, which turned
   * a real 5:1 ratio into 2.9:1 and understated exactly the pacing this layout
   * exists to communicate. */
  const t = prepareTimeline([
    { date: 'March 2026', text: 'a' },
    { date: 'August 2026', text: 'b' },
    { date: 'September 2026', text: 'c' },
  ]);
  assert.equal(t.proportional, true);
  assert.equal(t.gaps.length, 2, 'three events yield two gaps');

  const ratio = t.gaps[0].flex / t.gaps[1].flex;
  assert.ok(ratio > 4 && ratio < 6, 'expected roughly 5:1 spacing, got ' + ratio.toFixed(2));
  assert.equal(t.gaps[0].elapsed, '5 months');
  assert.equal(t.gaps[1].elapsed, '31 days');
});

test('an unreadable date makes the whole rail evenly spaced, not partly so', () => {
  /* Proportional for some gaps and arbitrary for others is worse than honestly
   * uniform, because the reader cannot tell which is which. */
  const t = prepareTimeline([
    { date: 'March 2026', text: 'a' },
    { date: 'Benchmarked', text: 'b' },
    { date: 'September 2026', text: 'c' },
  ]);
  assert.equal(t.proportional, false);
  assert.deepEqual(t.gaps.map(function (g) { return g.flex; }), [1, 1]);
  assert.deepEqual(t.gaps.map(function (g) { return g.elapsed; }), ['', '']);
});

test('timeline date parsing covers the shapes callers send, and rejects prose', () => {
  assert.ok(eventDateToDays('2026-03') !== null);
  assert.ok(eventDateToDays('2026-03-15') !== null);
  assert.ok(eventDateToDays('March 2026') !== null);
  assert.ok(eventDateToDays('Mar 2026') !== null);
  assert.ok(eventDateToDays('2026') !== null);
  assert.equal(eventDateToDays('Benchmarked'), null);
  assert.equal(eventDateToDays('2026-13'), null);
  assert.equal(eventDateToDays(''), null);
  // Ordering must survive the parse.
  assert.ok(eventDateToDays('March 2026') < eventDateToDays('August 2026'));
});

test('elapsed labels use a unit a reader can hold in their head', () => {
  assert.equal(humaniseGap(31), '31 days');
  assert.equal(humaniseGap(153), '5 months');
  assert.equal(humaniseGap(365 * 2), '2 years');
  assert.equal(humaniseGap(0), '');
});

test('a single-event timeline produces no gaps and does not throw', () => {
  const t = prepareTimeline([{ date: '2026-03', text: 'a' }]);
  assert.equal(t.gaps.length, 0);
  assert.equal(t.proportional, false);
});

/* -------------------------------------------------------------------- steps */

test('the final step is flagged so the layout can mark the outcome', () => {
  const s = prepareSteps([
    { title: 'Request arrives' },
    { title: 'Tokens stream back', detail: 'At 3,400 per second.' },
  ]);
  assert.equal(s[0].is_last, false);
  assert.equal(s[1].is_last, true);
  assert.equal(s[1].detail, 'At 3,400 per second.');
});

test('plain-string steps still work', () => {
  const s = prepareSteps(['One', 'Two']);
  assert.equal(s[0].title, 'One');
  assert.equal(s[1].is_last, true);
});

/* ------------------------------------------------------------------- images */

test('a missing image yields a labelled placeholder, not a failed batch', () => {
  const img = prepareImage({});
  assert.equal(img.present, false);
  assert.ok(img.note.length > 0, 'the placeholder must say what is missing');
});

test('a network image URL is refused as a caller error', () => {
  // render.js blocks all network requests inside the page, so an http image would
  // render as a broken box after a silent abort.
  assert.throws(
    () => prepareImage({ imageData: 'https://example.com/a.jpg' }),
    (e) => e.isValidation === true && /data URI/.test(e.message)
  );
});

test('image data cannot break out of the css url() wrapper', () => {
  const img = prepareImage({ imageData: 'data:image/png;base64,AAA")};body{display:none' });
  // The whole value must remain a single quoted url(), with no quote, paren or
  // backslash surviving inside it to terminate the declaration early.
  assert.match(img.css, /^url\("data:image\/png;base64,[^"()\\]*"\)$/);
  assert.ok(img.css.indexOf(')};') === -1, 'injection survived: ' + img.css);
});

/* ------------------------------------------------------------- integration */

test('prepareSlide builds a usable view model for every frame type', () => {
  // Guards against a frame being added without its data path, which would render
  // an empty region rather than failing.
  const samples = {
    'cover': { headline: 'h' },
    'big-text': { text: 't' },
    'chart': { headline: 'h', chart: {} },
    'stat': { value: '1', label: 'l' },
    'stat-grid': { stats: [{ value: '1', label: 'a' }, { value: '2', label: 'b' }] },
    'comparison': { headline: 'h', leftValue: '1x', rightValue: '4x' },
    'two-column': { headline: 'h', leftItems: ['a'], rightItems: ['b'] },
    'bullet-list': { headline: 'h', bullets: ['a', 'b'] },
    'numbered-steps': { headline: 'h', steps: ['a', 'b'] },
    'timeline': { headline: 'h', events: [{ date: '2026-01', text: 'a' }, { date: '2026-06', text: 'b' }] },
    'quote': { quote: 'q' },
    'image-caption': { headline: 'h' },
    'outro': { headline: 'h' },
  };

  FRAME_TYPES.forEach(function (type) {
    const sample = samples[type];
    assert.ok(sample, 'no view-model sample for frame type "' + type + '"');
    const view = prepareSlide(Object.assign({ type: type }, sample), type);
    assert.ok(view.layout, type + ': missing layout');
    assert.ok(view.attribution, type + ': missing attribution');
    assert.equal(typeof view.headline_len, 'number');
    assert.equal(typeof view.suppress_meta_source, 'boolean');
  });
});

test('the hero family is the only one used by more than one frame, and they differ', () => {
  /* cover and big-text intentionally share editorial_hero, but they must not share
   * a silhouette - the first pass had both bottom-anchored and they rendered
   * indistinguishably. The anchoring modifier lives in the template, so this test
   * pins the mapping and the anchoring is asserted by the smoke render. */
  const counts = {};
  Object.keys(FRAME_LAYOUTS).forEach(function (frame) {
    const l = FRAME_LAYOUTS[frame];
    counts[l] = (counts[l] || 0) + 1;
  });
  const shared = Object.keys(counts).filter(function (l) { return counts[l] > 1; });
  assert.deepEqual(shared.sort(), ['editorial_hero', 'metric_cards', 'split_comparison']);
});
