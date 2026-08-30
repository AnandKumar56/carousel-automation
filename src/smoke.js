'use strict';

/* Offline matrix test. Renders EVERY frame type across EVERY theme and asserts
 * each PNG is exactly 1080x1350. This is the guard that makes adding templates
 * and themes safe: 12 frames x 11 themes = 132 combinations, and any overflow
 * or geometry drift fails the run loudly.
 *
 * Run: npm run smoke          (matrix, writes one sample PNG per frame)
 *      npm run smoke -- full  (also writes every one of the 132 PNGs)
 */

const fs = require('fs');
const path = require('path');
const { renderSlides, FRAME_TYPES, THEMES, WIDTH, HEIGHT } = require('./render');

const OUT = path.join(__dirname, '..', 'out');
const writeAll = process.argv.includes('full');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* Realistic content per frame type, drawn from an actual research package so
 * string lengths are representative rather than toy-sized. */
const SAMPLES = {
  cover: {
    type: 'cover',
    eyebrow: 'AI & Tech',
    headline: 'Nvidia Groq 3 LPX hits 3,400 tokens per second',
    subheadline: 'A dedicated inference accelerator built for agentic AI workloads',
    source: 'NVIDIA Blog',
  },
  'bullet-list': {
    type: 'bullet-list',
    eyebrow: 'Specifications',
    headline: 'What is inside a single rack',
    subheadline: 'Hardware configuration per Groq 3 LPX rack',
    bullets: [
      '256 LPUs per rack',
      '128GB solid-state RAM',
      '40 petabytes per second of bandwidth',
      'Extends the Vera Rubin platform',
      'Scales beyond 1,000 LPUs',
    ],
  },
  stat: {
    type: 'stat',
    eyebrow: 'Benchmark',
    value: '3,400',
    unit: 'tokens / second',
    label: 'Record output speed in Artificial Analysis benchmarking',
    body: 'Fastest recorded result for the model at a 100,000-token context.',
  },
  'stat-grid': {
    type: 'stat-grid',
    eyebrow: 'By the numbers',
    headline: 'Groq 3 LPX at a glance',
    stats: [
      { value: '3,400', unit: 'tok/s', label: 'Record output throughput' },
      { value: '256', unit: 'LPUs', label: 'Processing units per rack' },
      { value: '128', unit: 'GB', label: 'Solid-state RAM' },
      { value: '40', unit: 'PB/s', label: 'Memory bandwidth' },
    ],
  },
  comparison: {
    type: 'comparison',
    eyebrow: 'Performance',
    headline: 'Responsiveness for agentic tasks',
    leftLabel: 'Previous',
    leftValue: '1x',
    leftText: 'Baseline responsiveness for multi-step agent workloads.',
    rightLabel: 'Groq 3 LPX',
    rightValue: '4x',
    rightText: 'Approximately four times faster for the same agentic tasks.',
  },
  'two-column': {
    type: 'two-column',
    eyebrow: 'Breakdown',
    headline: 'Hardware versus outcome',
    leftLabel: 'The hardware',
    leftItems: ['256 LPUs per rack', '128GB solid-state RAM', '40 PB/s bandwidth'],
    rightLabel: 'What it enables',
    rightItems: ['3,400 tokens per second', '4x faster responsiveness', 'Real-time agent reasoning'],
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
  },
  timeline: {
    type: 'timeline',
    eyebrow: 'Rollout',
    headline: 'How the launch unfolded',
    events: [
      { date: 'March 2026', text: 'Groq 3 LPU debuts as a dedicated inference chip.' },
      { date: 'August 2026', text: 'Groq 3 LPX enters full production.' },
      { date: 'Benchmarked', text: 'Records 3,400 output tokens per second.' },
    ],
  },
  quote: {
    type: 'quote',
    eyebrow: 'On the record',
    quote: 'Throughput targets reach up to 1,500 tokens per second for agentic communications.',
    attribution: 'Ian Buck',
    attributionRole: 'VP of Hyperscale, NVIDIA',
  },
  'big-text': {
    type: 'big-text',
    eyebrow: 'The takeaway',
    text: 'Inference stopped being the bottleneck.',
    footnote: 'Based on Artificial Analysis benchmarking of Groq 3 LPX.',
  },
  'image-caption': {
    type: 'image-caption',
    eyebrow: 'Reference',
    headline: 'The Groq 3 LPX rack',
    caption: 'Overview of the rack showing interconnect and liquid cooling compatibility.',
    credit: 'Source: NVIDIA Blog',
    // No imageData - exercises the placeholder path deliberately.
  },
  outro: {
    type: 'outro',
    headline: 'Faster inference changes what agents can do',
    subheadline: 'Real-time reasoning stops being a bottleneck',
    cta: 'Save this for later',
    sources: 'NVIDIA Blog, SiliconANGLE, NVIDIA News',
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
  if (failures.length > 0) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log('  ' + f));
  }
  console.log(fail === 0 ? '\nMATRIX PASSED - every combination is exactly 1080x1350' : '\nMATRIX FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
