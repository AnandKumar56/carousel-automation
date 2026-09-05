'use strict';

/* Offline matrix test. Renders EVERY frame type across EVERY theme and asserts
 * each PNG is exactly 1080x1350. This is the guard that makes adding templates
 * and themes safe: 13 frames x 11 themes = 143 combinations, and any overflow
 * or geometry drift fails the run loudly.
 *
 * The chart frame is additionally rendered once per CHART KIND, because a chart
 * that fits at 2 bars can overflow at 7, and the inline SVG inherits theme
 * colours - so both dimensions need coverage.
 *
 * Run: npm run smoke          (matrix, writes one sample PNG per frame)
 *      npm run smoke -- full  (also writes every one of the 143 PNGs)
 */

const fs = require('fs');
const path = require('path');
const { renderSlides, FRAME_TYPES, THEMES, WIDTH, HEIGHT } = require('./render');
const { CHART_KINDS } = require('./charts');

const OUT = path.join(__dirname, '..', 'out');
const writeAll = process.argv.includes('full');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* One sample per chart kind, each at its MAXIMUM legible point count, since that
 * is where a chart overflows if the height maths is wrong. Values are the real
 * ChatGPT Ads and Groq figures so label lengths are representative. */
const CHART_SAMPLES = {
  'bar': {
    kind: 'bar', unit: 'USD',
    // Ascending, so the chart is scannable. Sorting is opt-in by design (see
    // sortPoints) because a comparison often leads with its subject on purpose.
    sort: 'asc',
    sources: [{ name: 'Reuters' }],
    as_of: 'Aug 2026',
    series: [
      { label: 'ChatGPT Ads', value: 1.4, emphasis: true },
      { label: 'Bing Ads', value: 1.85 },
      { label: 'Perplexity', value: 2.1 },
      { label: 'Google Search', value: 2.7 },
      { label: 'Amazon Ads', value: 3.15 },
      { label: 'LinkedIn Ads', value: 5.6 },
      { label: 'Instagram Ads', value: 1.2 },
    ],
  },
  'grouped-bar': {
    kind: 'grouped-bar', unit: 'USD',
    series_names: ['ChatGPT Ads', 'Google Search'],
    sources: [{ name: 'Reuters' }, { name: 'The Information' }],
    series: [
      { label: 'Cost per click', values: [1.4, 2.7] },
      { label: 'Cost per mille', values: [8.2, 11.5] },
      { label: 'Cost per action', values: [24.5, 31.2] },
      { label: 'Cost per lead', values: [42.0, 58.4] },
    ],
  },
  'line': {
    kind: 'line', unit: 'USD_M',
    sources: [{ name: 'The Information' }],
    series: [
      { label: 'Apr', value: 12 },
      { label: 'May', value: 21 },
      { label: 'Jun', value: 38 },
      { label: 'Jul', value: 57 },
      { label: 'Aug', value: 83 },
      { label: 'Sep', value: 96 },
    ],
  },
  'progression': {
    kind: 'progression', unit: 'USD_M',
    sources: [{ name: 'The Information' }],
    series: [
      { label: 'Apr 2026', value: 12 },
      { label: 'Jun 2026', value: 38 },
      { label: 'Aug 2026', value: 83, emphasis: true },
    ],
  },
  'share': {
    kind: 'share', unit: 'percent',
    sources: [{ name: 'Reuters' }],
    series: [
      { label: 'Organic answers', value: 92 },
      { label: 'Sponsored results', value: 8 },
    ],
  },
  'timeline-scaled': {
    kind: 'timeline-scaled', unit: 'count',
    sources: [{ name: 'OpenAI Blog' }],
    series: [
      { label: 'Ads business launches', value: 1, date: '2026-03' },
      { label: 'First $12M month', value: 1, date: '2026-04' },
      { label: 'Self-serve platform opens', value: 1, date: '2026-06' },
      { label: '$1B run rate reached', value: 1, date: '2026-09', emphasis: true },
    ],
  },
};

function chartSlide(kind) {
  return {
    type: 'chart',
    eyebrow: 'By the numbers',
    headline: 'ChatGPT ad revenue grew nearly 7x in five months',
    subheadline: 'Monthly figures reported by The Information',
    chart: CHART_SAMPLES[kind],
    takeaway: 'The pace, not the absolute figure, is what makes this a $1B annualized run rate.',
  };
}

/* Realistic content per frame type, drawn from an actual research package so
 * string lengths are representative rather than toy-sized.
 *
 * Sources are populated on EVERY sample, and per-item sources on the frames that
 * support them. The old samples carried none, which is why the matrix passed
 * while every rendered slide was unattributed - the test asserted dimensions and
 * nothing about content. */
const SAMPLES = {
  cover: {
    type: 'cover',
    eyebrow: 'AI & Tech',
    headline: 'Nvidia Groq 3 LPX hits 3,400 tokens per second',
    subheadline: 'A dedicated inference accelerator built for agentic AI workloads',
    sources: [{ name: 'NVIDIA', url: 'https://blogs.nvidia.com/x' }],
    as_of: 'Aug 2026',
  },
  'bullet-list': {
    type: 'bullet-list',
    eyebrow: 'Specifications',
    headline: 'What is inside a single rack',
    subheadline: 'Hardware configuration per Groq 3 LPX rack',
    // Object bullets with figures and per-item sources - including one tier-4
    // claim, so the "unverified" path is exercised.
    bullets: [
      { figure: '256', text: 'LPUs per rack', source: 'NVIDIA', source_tier: 1 },
      { figure: '128GB', text: 'Solid-state RAM per unit', source: 'NVIDIA', source_tier: 1 },
      { figure: '40 PB/s', text: 'Memory bandwidth across the rack', source: 'SiliconANGLE', source_tier: 3 },
      { text: 'Extends the Vera Rubin platform without a new interconnect', source: 'NVIDIA', source_tier: 1 },
      { text: 'Early users report clusters scaling past 1,000 LPUs', source: 'Reddit', source_tier: 4 },
    ],
    sources: [{ name: 'NVIDIA' }, { name: 'SiliconANGLE' }],
  },
  stat: {
    type: 'stat',
    eyebrow: 'Benchmark',
    value: '3,400',
    unit: 'tokens / second',
    label: 'Record output speed in Artificial Analysis benchmarking',
    body: 'Fastest recorded result for the model at a 100,000-token context.',
    sources: [{ url: 'https://artificialanalysis.ai/x' }],
    as_of: 'Aug 2026',
  },
  'stat-grid': {
    type: 'stat-grid',
    eyebrow: 'By the numbers',
    headline: 'Groq 3 LPX at a glance',
    // Mixed sources, so per-card badges render; the first card is the lead.
    stats: [
      { value: '3,400', unit: 'tok/s', label: 'Record output throughput', source: 'Artificial Analysis' },
      { value: '256', unit: 'LPUs', label: 'Processing units per rack', source: 'NVIDIA' },
      { value: '128', unit: 'GB', label: 'Solid-state RAM', source: 'NVIDIA' },
      { value: '40', unit: 'PB/s', label: 'Memory bandwidth', source: 'SiliconANGLE' },
    ],
    sources: [{ name: 'NVIDIA' }, { name: 'Artificial Analysis' }, { name: 'SiliconANGLE' }],
  },
  // The matrix entry uses the densest kind; every other kind is covered by the
  // dedicated chart sweep below.
  chart: chartSlide('bar'),
  comparison: {
    type: 'comparison',
    eyebrow: 'Performance',
    headline: 'Responsiveness for agentic tasks',
    leftLabel: 'Previous generation',
    leftValue: '1x',
    leftText: 'Baseline responsiveness for multi-step agent workloads.',
    rightLabel: 'Groq 3 LPX',
    rightValue: '4x',
    rightText: 'Approximately four times faster for the same agentic tasks.',
    sources: [{ name: 'Artificial Analysis' }],
    as_of: 'Aug 2026',
  },
  'two-column': {
    type: 'two-column',
    eyebrow: 'Breakdown',
    headline: 'Hardware versus outcome',
    leftLabel: 'The hardware',
    leftItems: ['256 LPUs per rack', '128GB solid-state RAM', '40 PB/s bandwidth'],
    rightLabel: 'What it enables',
    rightItems: ['3,400 tokens per second', '4x faster responsiveness', 'Real-time agent reasoning'],
    sources: [{ name: 'NVIDIA' }, { name: 'Artificial Analysis' }],
  },
  'numbered-steps': {
    type: 'numbered-steps',
    eyebrow: 'How it works',
    headline: 'From request to response',
    steps: [
      { title: 'Request arrives', detail: 'An agent issues a reasoning step.' },
      { title: 'LPU array processes it', detail: '256 units work in parallel across the rack.' },
      { title: 'Tokens stream back', detail: 'Output returns at 3,400 tokens per second.' },
    ],
    sources: [{ name: 'NVIDIA' }],
  },
  timeline: {
    /* Deliberately uneven gaps - 5 months, then 1 - so the proportional rail is
     * actually exercised rather than rendering three equal spans. Dates are prose
     * because that is what legacy callers send. */
    type: 'timeline',
    eyebrow: 'Rollout',
    headline: 'How the launch unfolded',
    events: [
      { date: 'March 2026', text: 'Groq 3 LPU debuts as a dedicated inference chip.', source: 'NVIDIA' },
      { date: 'August 2026', text: 'Groq 3 LPX enters full production.', source: 'NVIDIA' },
      { date: 'September 2026', text: 'Records 3,400 output tokens per second.', source: 'Artificial Analysis', emphasis: true },
    ],
    sources: [{ name: 'NVIDIA' }, { name: 'Artificial Analysis' }],
  },
  quote: {
    type: 'quote',
    quote: 'Throughput targets reach up to 1,500 tokens per second for agentic communications.',
    attribution: 'Ian Buck',
    attributionRole: 'VP of Hyperscale, NVIDIA',
    sources: [{ name: 'NVIDIA', url: 'https://blogs.nvidia.com/x' }],
  },
  'big-text': {
    type: 'big-text',
    eyebrow: 'The takeaway',
    text: 'Inference stopped being the bottleneck.',
    footnote: 'Based on Artificial Analysis benchmarking of Groq 3 LPX at a 100,000-token context.',
    sources: [{ name: 'Artificial Analysis' }],
  },
  'image-caption': {
    type: 'image-caption',
    eyebrow: 'Reference',
    headline: 'The Groq 3 LPX rack',
    caption: 'Overview of the rack showing interconnect and liquid cooling compatibility.',
    sources: [{ name: 'NVIDIA' }],
    // No imageData - exercises the placeholder path deliberately.
  },
  outro: {
    type: 'outro',
    headline: 'Faster inference changes what agents can do',
    subheadline: 'Real-time reasoning stops being a bottleneck',
    cta: 'Save this for later',
    // The closing slide carries the whole carousel's manifest.
    source_manifest: [
      { name: 'NVIDIA' },
      { name: 'Artificial Analysis' },
      { name: 'SiliconANGLE' },
      { url: 'https://reuters.com/x' },
    ],
  },
};

(async () => {
  // Fail loudly if a frame type has no sample - otherwise the matrix would
  // silently skip coverage for a template.
  const missing = FRAME_TYPES.filter((t) => !SAMPLES[t]);
  if (missing.length > 0) {
    console.error('No sample content defined for frame types:', missing.join(', '));
    process.exit(1);
  }

  console.log(`matrix: ${FRAME_TYPES.length} frames x ${THEMES.length} themes = ${FRAME_TYPES.length * THEMES.length} renders`);
  console.log('');

  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const theme of THEMES) {
    // The 10-slide cap in renderSlides is a correct production guard (Instagram
    // carousels max at 10), so the matrix is rendered in chunks rather than
    // weakening that check for the sake of the test.
    const chunks = [];
    for (let i = 0; i < FRAME_TYPES.length; i += 6) {
      chunks.push(FRAME_TYPES.slice(i, i + 6));
    }

    let themeOk = true;
    let rendered = 0;

    for (const chunk of chunks) {
      const slides = chunk.map((t) => SAMPLES[t]);
      let results;
      try {
        results = await renderSlides(slides, { theme });
      } catch (err) {
        fail += chunk.length;
        themeOk = false;
        failures.push(`${theme} [${chunk.join(',')}]: BATCH FAILED - ${err.message}`);
        continue;
      }

      for (const r of results) {
        const ok = r.width === WIDTH && r.height === HEIGHT;
        if (ok) {
          pass += 1;
        } else {
          fail += 1;
          themeOk = false;
          failures.push(`${theme}/${r.type}: ${r.width}x${r.height}`);
        }
        rendered += 1;

        if (writeAll) {
          fs.writeFileSync(path.join(OUT, `${theme}__${r.type}.png`), r.buffer);
        } else if (theme === THEMES[0]) {
          fs.writeFileSync(path.join(OUT, `sample_${r.type}.png`), r.buffer);
        }
      }
    }

    console.log(`  ${theme.padEnd(14)} ${themeOk ? 'PASS' : 'FAIL'}  ${rendered} frames`);
  }

  console.log('');
  console.log(`pass ${pass}  fail ${fail}`);

  /* ---- chart kind sweep ----
   * Every chart kind at its maximum point count, on the two themes most likely
   * to expose a problem: the default dark theme, and `minimal`, which has no
   * grid and the lowest contrast, so a chart that relies on the grid for
   * legibility shows up here. */
  const missingChart = CHART_KINDS.filter((k) => !CHART_SAMPLES[k]);
  if (missingChart.length > 0) {
    console.error('No sample defined for chart kinds:', missingChart.join(', '));
    process.exit(1);
  }

  console.log('');
  console.log(`chart kinds: ${CHART_KINDS.length} kinds x 2 themes = ${CHART_KINDS.length * 2} renders`);

  for (const theme of ['dark-tech', 'minimal']) {
    for (const kind of CHART_KINDS) {
      let results;
      try {
        results = await renderSlides([chartSlide(kind)], { theme });
      } catch (err) {
        fail += 1;
        failures.push(`${theme}/chart:${kind}: FAILED - ${err.message}`);
        console.log(`  ${theme.padEnd(11)} ${kind.padEnd(16)} FAIL  ${err.message}`);
        continue;
      }

      const r = results[0];
      const ok = r.width === WIDTH && r.height === HEIGHT;
      if (ok) { pass += 1; } else {
        fail += 1;
        failures.push(`${theme}/chart:${kind}: ${r.width}x${r.height}`);
      }
      console.log(`  ${theme.padEnd(11)} ${kind.padEnd(16)} ${ok ? 'PASS' : 'FAIL'}`);

      if (writeAll || theme === 'dark-tech') {
        fs.writeFileSync(path.join(OUT, `chart_${theme}__${kind}.png`), r.buffer);
      }
    }
  }

  console.log('');
  console.log(`total pass ${pass}  fail ${fail}`);
  if (failures.length > 0) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log('  ' + f));
  }
  console.log(fail === 0 ? '\nMATRIX PASSED - every combination is exactly 1080x1350' : '\nMATRIX FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
