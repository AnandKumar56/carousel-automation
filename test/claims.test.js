'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildClaimSet,
  normaliseClaim,
  classifySourceTier,
  detectMeasureKind,
  extractCurrency,
  extractNumberWithUnit,
  extractDate,
  extractProgression,
  extractComparison,
} = require('../src/claims');

/* The ChatGPT Ads findings, in the exact legacy shape Workflow 2 emits today.
 * This is the regression case: the carousel generated from it was the one judged
 * editorially weak, so every extraction below is a claim about real data the old
 * pipeline had available and failed to use. */
const CHATGPT_ADS_FINDINGS = [
  {
    claim: 'ChatGPT Ads reached a $1 billion annualized run rate within six months of launch',
    source_url: 'https://theinformation.com/a', source_name: 'The Information', credibility: 'verified',
  },
  {
    claim: 'The ads business launched in March 2026',
    source_url: 'https://openai.com/blog/ads', source_name: 'OpenAI Blog', credibility: 'verified',
  },
  {
    claim: 'Monthly ad revenue grew from $12 million in April to $83 million in August 2026',
    source_url: 'https://theinformation.com/c', source_name: 'The Information', credibility: 'verified',
  },
  {
    claim: 'Sponsored results appear in roughly 8 percent of ChatGPT queries',
    source_url: 'https://reuters.com/d', source_name: 'Reuters', credibility: 'verified',
  },
  {
    claim: 'Average cost per click is $1.40, compared to $2.70 on Google Search',
    source_url: 'https://reuters.com/e', source_name: 'Reuters', credibility: 'verified',
  },
  {
    claim: 'Over 40,000 advertisers have onboarded to the self-serve platform',
    source_url: 'https://openai.com/blog/ads', source_name: 'OpenAI Blog', credibility: 'verified',
  },
  {
    claim: 'Some users report sponsored results are hard to distinguish from organic answers',
    source_url: 'https://reddit.com/h', source_name: 'Reddit', credibility: 'community',
  },
];

test('source tiering distinguishes primary, major, specialist and social', () => {
  assert.equal(classifySourceTier('OpenAI Blog', 'https://openai.com/blog/ads'), 1);
  assert.equal(classifySourceTier('Reuters', 'https://reuters.com/d'), 2);
  assert.equal(classifySourceTier('SiliconANGLE', 'https://siliconangle.com/x'), 3);
  assert.equal(classifySourceTier('Reddit', 'https://reddit.com/h'), 4);
  // Unknown sources default to 3, not 4 - an unrecognised trade publication is
  // more likely than an unrecognised social platform.
  assert.equal(classifySourceTier('Some Trade Weekly', 'https://example.com/x'), 3);
});

test('measure kind preserves the run-rate vs revenue distinction', () => {
  assert.equal(
    detectMeasureKind('reached a $1 billion annualized run rate'),
    'annualized_run_rate'
  );
  assert.equal(detectMeasureKind('monthly revenue reached $83 million'), 'monthly_figure');
  assert.equal(detectMeasureKind('projected to reach $2 billion'), 'projection');
  assert.equal(detectMeasureKind('roughly 8 percent of queries'), 'estimate');
});

test('currency extraction resolves magnitude words and suffixes', () => {
  assert.deepEqual(extractCurrency('$1 billion run rate'), { value: 1, unit: 'USD_B', absolute: 1e9 });
  assert.deepEqual(extractCurrency('$83 million'), { value: 83, unit: 'USD_M', absolute: 83e6 });
  assert.deepEqual(extractCurrency('$1.40 per click'), { value: 1.4, unit: 'USD', absolute: 1.4 });
  assert.equal(extractCurrency('no money here'), null);
});

test('number+unit extraction handles percent, multiple and counts', () => {
  assert.deepEqual(extractNumberWithUnit('roughly 8 percent of queries'), { value: 8, unit: 'percent' });
  assert.deepEqual(extractNumberWithUnit('4x faster responsiveness'), { value: 4, unit: 'multiple' });
  assert.deepEqual(extractNumberWithUnit('3,400 tokens per second'), { value: 3400, unit: 'tokens_per_sec' });
  assert.deepEqual(extractNumberWithUnit('Over 40,000 advertisers'), { value: 40000, unit: 'advertisers' });
});

test('date extraction prefers month-year precision', () => {
  assert.equal(extractDate('launched in March 2026'), '2026-03');
  assert.equal(extractDate('in August 2026'), '2026-08');
  assert.equal(extractDate('during 2026'), '2026');
  assert.equal(extractDate('no date at all'), null);
});

test('progression extraction turns prose into a chartable series', () => {
  const p = extractProgression('Monthly ad revenue grew from $12 million in April to $83 million in August 2026');
  assert.ok(p, 'expected a progression');
  assert.equal(p.unit, 'USD_M');
  assert.equal(p.series.length, 2);
  assert.equal(p.series[0].value, 12);
  assert.equal(p.series[1].value, 83);
  assert.equal(p.series[1].date, '2026-08');
});

test('progression is rejected when units differ', () => {
  // Charting dollars against a percentage would produce a misleading axis.
  assert.equal(extractProgression('grew from $12 million to 83 percent'), null);
});

test('comparison extraction produces a two-sided series with real labels', () => {
  const c = extractComparison('Average cost per click is $1.40, compared to $2.70 on Google Search');
  assert.ok(c, 'expected a comparison');
  assert.equal(c.unit, 'USD');
  assert.equal(c.series.length, 2);
  assert.equal(c.series[0].value, 1.4);
  assert.equal(c.series[1].value, 2.7);
  // Right-hand label should name the thing being compared against.
  assert.match(c.series[1].label, /Google/);
});

test('legacy prose findings yield structured, chartable claims', () => {
  const { claims, stats } = buildClaimSet({ findings: CHATGPT_ADS_FINDINGS });

  assert.equal(stats.findings_in, 7);
  assert.ok(stats.claims_out >= 6, 'claims should survive normalisation');

  // The whole point of the rebuild: numbers must come out of the prose.
  assert.ok(stats.with_value >= 5, 'expected at least 5 claims with numeric values, got ' + stats.with_value);
  assert.ok(stats.chartable >= 2, 'expected at least 2 chartable claims, got ' + stats.chartable);

  const runRate = claims.find(c => /run rate/i.test(c.text));
  assert.equal(runRate.value, 1);
  assert.equal(runRate.unit, 'USD_B');
  // The critical precision guard.
  assert.equal(runRate.measure_kind, 'annualized_run_rate');

  const progression = claims.find(c => c.series && c.series.length === 2 && c.series[0].date);
  assert.ok(progression, 'expected the revenue progression to be chartable');
  assert.equal(progression.chartable, true);

  const cpc = claims.find(c => /cost per click/i.test(c.text));
  assert.ok(cpc.series, 'CPC comparison should produce a series');
  assert.equal(cpc.claim_type, 'comparison');
});

test('tier 4 numeric claims are flagged as weakly sourced', () => {
  const { claims } = buildClaimSet({
    findings: [{
      claim: 'An unverified post claims 500,000 users switched',
      source_url: 'https://reddit.com/x', source_name: 'Reddit', credibility: 'community',
    }],
  });
  assert.equal(claims[0].best_tier, 4);
  assert.equal(claims[0].weakly_sourced, true);
});

test('duplicate claims from different sources merge into one with two sources', () => {
  const { claims, stats } = buildClaimSet({
    findings: [
      { claim: 'Revenue hit a $1 billion annualized run rate', source_name: 'Reuters', source_url: 'https://reuters.com/a', credibility: 'verified' },
      { claim: 'The company reported a $1 billion annualized run rate', source_name: 'Bloomberg', source_url: 'https://bloomberg.com/b', credibility: 'verified' },
    ],
  });
  assert.equal(stats.claims_out, 1, 'identical numeric claims should merge');
  assert.equal(claims[0].sources.length, 2, 'merged claim should carry both sources');
  assert.equal(stats.merged, 1);
});

test('structured claims from the new WF2 shape pass through untouched', () => {
  const c = normaliseClaim({
    id: 'x1',
    text: 'Monthly revenue reached $83M',
    claim_type: 'fact',
    value: 83, unit: 'USD_M', date: '2026-08',
    series: [{ label: 'Apr', value: 12 }, { label: 'Aug', value: 83 }],
    source_name: 'The Information', source_url: 'https://x', source_tier: 2,
    evidence_excerpt: 'revenue reached $83 million in August',
  }, 0);

  assert.equal(c.id, 'x1');
  assert.equal(c.value, 83);
  assert.equal(c.unit, 'USD_M');
  assert.equal(c.sources[0].tier, 2);
  assert.equal(c.chartable, true);
  assert.equal(c.evidence_excerpt, 'revenue reached $83 million in August');
});

test('unparseable claims survive as text-only rather than being dropped', () => {
  const { claims } = buildClaimSet({
    findings: [{ claim: 'The policy shift changes how agencies plan campaigns', source_name: 'Wired', source_url: 'https://wired.com/x', credibility: 'verified' }],
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].value, null);
  assert.equal(claims[0].supports_visual, false);
  assert.equal(claims[0].chartable, false);
});

test('empty research package produces an empty claim set without throwing', () => {
  const r = buildClaimSet({});
  assert.equal(r.claims.length, 0);
  assert.equal(r.stats.findings_in, 0);
  assert.deepEqual(r.source_manifest, []);
});

/* ------------------------------------------------------------------------- *
 * Regression guards. Each of these covers a bug that silently produced wrong
 * data on a slide rather than an error, which is the dangerous failure mode:
 * the carousel renders, looks fine, and states something false.
 * ------------------------------------------------------------------------- */

test('a bare year is not read as a count', () => {
  // "launched in March 2026" previously yielded { value: 2026, unit: 'count' },
  // which put a metric card on the slide reading "2026".
  assert.equal(extractNumberWithUnit('The ads business launched in March 2026'), null);
  // Comma-grouped and 5-digit+ numbers stay unambiguous.
  assert.deepEqual(extractNumberWithUnit('40,000 advertisers'), { value: 40000, unit: 'advertisers' });
  assert.deepEqual(extractNumberWithUnit('12500 units shipped'), { value: 12500, unit: 'count' });
});

test('clause splitting does not truncate a decimal', () => {
  // The old lazy match stopped at the point inside "$2.70" and read 2.
  const c = extractComparison('Average cost per click is $1.40, compared to $2.70 on Google Search');
  assert.equal(c.series[1].value, 2.7);
  const p = extractProgression('margin moved from 12.5 percent to 18.3 percent');
  assert.equal(p.series[0].value, 12.5);
  assert.equal(p.series[1].value, 18.3);
});

test('a progression borrows the year stated once at the end', () => {
  const p = extractProgression('grew from $12 million in April to $83 million in August 2026');
  assert.equal(p.series[0].date, '2026-04');
  assert.equal(p.series[0].label, 'Apr 2026');
  assert.equal(p.series[1].label, 'Aug 2026');
});

test('a borrowed year never makes the series run backwards', () => {
  // December precedes February, so the earlier point must fall in the prior year.
  const p = extractProgression('rose from $4 billion in December to $9 billion in February 2027');
  assert.equal(p.series[0].date, '2026-12');
  assert.equal(p.series[1].date, '2027-02');
});

test('comparison labels skip words capitalised only by sentence position', () => {
  const c = extractComparison(
    'Average cost per click is $1.40, compared to $2.70 on Google Search',
    'ChatGPT Ads'
  );
  // "Average" opens the clause; it is not the name of the thing being measured.
  assert.equal(c.series[0].label, 'ChatGPT Ads');
  assert.match(c.series[1].label, /Google/);
});

test('lowercase "may" is treated as a verb, not a month', () => {
  // "may reach" must not date the point to May.
  const p = extractProgression('could climb from $12 million to $30 million, and may reach more');
  assert.equal(p.series[0].date, null);
  assert.equal(p.series[0].label, 'before');
});

test('month detection does not match a word that merely starts with a month prefix', () => {
  assert.equal(extractDate('Marketing spend rose'), null);
  assert.equal(extractDate('Marketing spend rose in 2026'), '2026');
});

test('the subject names the near side of a comparison end to end', () => {
  const { claims } = buildClaimSet({
    subject: 'ChatGPT Ads',
    findings: [{
      claim: 'Average cost per click is $1.40, compared to $2.70 on Google Search',
      source_name: 'Reuters', source_url: 'https://reuters.com/e', credibility: 'verified',
    }],
  });
  assert.equal(claims[0].series[0].label, 'ChatGPT Ads');
  assert.equal(claims[0].claim_type, 'comparison');
});
