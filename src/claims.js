'use strict';

/* Claim normalisation - the foundation of the whole rebuild.
 *
 * THE PROBLEM THIS SOLVES: Workflow 2 currently emits findings shaped like
 *   { claim: "Monthly revenue grew from $12M in April to $83M in August",
 *     source_url, source_name, credibility }
 * The numbers exist only inside an English sentence. That is why no chart could
 * ever be generated - there was nothing structured to plot. A carousel about
 * benchmark figures rendered every figure as typography because typography was
 * the only thing the data supported.
 *
 * DUAL-READ: accepts both the new structured claim shape and the legacy prose
 * shape. For legacy findings it extracts numbers, units, dates and progressions
 * out of the text so old research packages in Drive still get charts. This is
 * why no hard cutover is needed.
 *
 * PRECISION IS PRESERVED DELIBERATELY. "annualized run rate" is not "revenue",
 * and "$1B annualized run rate" must never be flattened to "hit $1B". The
 * measure_kind field carries that distinction downstream so the renderer cannot
 * silently overstate the evidence.
 */

const { CLAIM_TYPES, SOURCE_TIERS, publishEligibilityFor } = require('./contracts');

/* ------------------------------------------------------- source tier mapping */

/* Tier 1 is primary: the subject speaking for itself, or raw data.
 * Matching is on hostname fragments rather than exact domains because research
 * sources arrive with inconsistent subdomains (blogs.nvidia.com,
 * nvidianews.nvidia.com, investor.nvidia.com). */
const TIER1_PATTERNS = [
  /\.gov$/i, /\.gov\//i, 'sec.gov', 'europa.eu',
  'blog.', 'blogs.', 'newsroom', 'news.', 'press.', 'investor.',
  'openai.com', 'anthropic.com', 'nvidia.com', 'google', 'microsoft.com',
  'meta.com', 'apple.com', 'arxiv.org', 'github.com',
];

const TIER2_NAMES = [
  'reuters', 'associated press', ' ap ', 'bloomberg', 'financial times', ' ft ',
  'wall street journal', 'wsj', 'the economist', 'new york times', 'nyt',
  'washington post', 'cnbc', 'bbc',
];

const TIER3_NAMES = [
  'techcrunch', 'the verge', 'ars technica', 'wired', 'siliconangle',
  'venturebeat', 'the information', 'zdnet', 'engadget', 'axios',
  'the register', 'tom\'s hardware', 'anandtech', 'semianalysis',
  'artificial analysis', 'the next web', 'searchengineland',
];

const TIER4_NAMES = [
  'reddit', 'twitter', ' x ', 'hacker news', 'medium', 'substack',
  'linkedin', 'youtube', 'quora', 'blogspot', 'wordpress.com',
];

/**
 * Classify a source into tier 1-4. Unknown sources land at tier 3 rather than
 * tier 4: an unrecognised trade publication is more likely than an unrecognised
 * social platform, and defaulting to 4 would wrongly disqualify legitimate
 * sources from supporting material claims.
 */
function classifySourceTier(name, url) {
  const n = ' ' + String(name || '').toLowerCase() + ' ';
  const u = String(url || '').toLowerCase();

  for (let i = 0; i < TIER4_NAMES.length; i++) {
    if (n.indexOf(TIER4_NAMES[i]) !== -1) { return 4; }
  }
  if (/reddit\.com|x\.com|twitter\.com|news\.ycombinator|medium\.com|substack\.com/.test(u)) {
    return 4;
  }

  for (let i = 0; i < TIER2_NAMES.length; i++) {
    if (n.indexOf(TIER2_NAMES[i]) !== -1) { return 2; }
  }
  if (/reuters\.com|apnews\.com|bloomberg\.com|ft\.com|wsj\.com|nytimes\.com|bbc\.co/.test(u)) {
    return 2;
  }

  for (let i = 0; i < TIER1_PATTERNS.length; i++) {
    const pat = TIER1_PATTERNS[i];
    if (pat instanceof RegExp) { if (pat.test(u)) { return 1; } }
    else if (u.indexOf(pat) !== -1) { return 1; }
  }

  for (let i = 0; i < TIER3_NAMES.length; i++) {
    if (n.indexOf(TIER3_NAMES[i]) !== -1) { return 3; }
  }

  return 3;
}

/* -------------------------------------------------- numeric prose extraction */

/* Unit normalisation. Keys are what appears in prose; values are canonical.
 * Canonical units matter because a chart axis label must be consistent across
 * claims that came from different sources with different phrasing. */
const UNIT_ALIASES = {
  '%': 'percent', 'percent': 'percent', 'per cent': 'percent', 'pct': 'percent',
  'x': 'multiple', 'times': 'multiple',
  'tokens/second': 'tokens_per_sec', 'tokens per second': 'tokens_per_sec',
  'tok/s': 'tokens_per_sec', 'tps': 'tokens_per_sec',
  'gb': 'GB', 'tb': 'TB', 'mb': 'MB',
  'pb/s': 'PB_per_sec', 'petabytes per second': 'PB_per_sec',
  'gb/s': 'GB_per_sec',
};

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/* Complete month forms, longest-first so "march" wins over "mar". Matching bare
 * prefixes was unsafe: /\bmar[a-z]*\b/ happily reads "Marketing" as March. */
const MONTH_ALT =
  'january|february|march|april|may|june|july|august|september|october|november|december'
  + '|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

/* A clause terminator that will not split a decimal: the punctuation must be
 * followed by whitespace or end-of-string. Without the lookahead, a lazy match
 * ending in [.,;] stopped at the point inside "$2.70" and read the value as 2. */
const CLAUSE_END = '(?:[.,;](?=\\s|$)|$)';

/* Currency magnitude suffixes. Kept explicit rather than computed so "$1B" and
 * "$1 billion" both resolve to the same value and unit. */
const MAGNITUDES = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

/**
 * Detect what KIND of measure a claim describes. This is the guard against
 * overstating evidence: a run rate is an annualisation of a shorter period, not
 * money received, and the renderer must not print it as revenue.
 */
function detectMeasureKind(text) {
  const t = String(text || '').toLowerCase();
  if (/annuali[sz]ed run rate|run[- ]rate|arr\b/.test(t)) { return 'annualized_run_rate'; }
  if (/\bforecast|expected to reach|will reach|projected/.test(t)) { return 'projection'; }
  if (/\bestimat|approximately|roughly|about \$|around \$/.test(t)) { return 'estimate'; }
  if (/\bsurvey|respondents|polled/.test(t)) { return 'survey_result'; }
  if (/monthly revenue|per month|a month|\bmrr\b/.test(t)) { return 'monthly_figure'; }
  if (/\bshare of|percent of|% of\b/.test(t)) { return 'share'; }
  if (/average|median|mean\b/.test(t)) { return 'average'; }
  if (/\breported|according to|said\b/.test(t)) { return 'reported_figure'; }
  return 'actual';
}

/** Extract a currency amount, resolving magnitude words and suffixes. */
function extractCurrency(text) {
  const m = String(text).match(
    /([$€£])\s?([\d,]+(?:\.\d+)?)\s*(k|m|mn|bn|b|tn|t|thousand|million|billion|trillion)?/i
  );
  if (!m) { return null; }
  const raw = parseFloat(m[2].replace(/,/g, ''));
  if (!isFinite(raw)) { return null; }
  const suffix = (m[3] || '').toLowerCase();
  const mult = MAGNITUDES[suffix] || 1;
  const abs = raw * mult;

  // Express in the most readable unit rather than raw dollars, so an axis reads
  // "83" with unit "USD_M" instead of "83000000".
  let unit = 'USD';
  let value = abs;
  if (abs >= 1e9) { unit = 'USD_B'; value = abs / 1e9; }
  else if (abs >= 1e6) { unit = 'USD_M'; value = abs / 1e6; }
  else if (abs >= 1e3) { unit = 'USD_K'; value = abs / 1e3; }

  return { value: Math.round(value * 100) / 100, unit: unit, absolute: abs };
}

/** Extract a plain number with a trailing unit, e.g. "3,400 tokens/second". */
function extractNumberWithUnit(text) {
  const t = String(text);

  const pct = t.match(/([\d.]+)\s?(%|percent|per cent)/i);
  if (pct) {
    const v = parseFloat(pct[1]);
    if (isFinite(v)) { return { value: v, unit: 'percent' }; }
  }

  const mult = t.match(/([\d.]+)\s?x\b/i);
  if (mult) {
    const v = parseFloat(mult[1]);
    if (isFinite(v)) { return { value: v, unit: 'multiple' }; }
  }

  const withUnit = t.match(
    /([\d,]+(?:\.\d+)?)\s?(tokens?\s?\/?\s?(?:per\s)?second|tok\/s|tps|GB\/s|PB\/s|petabytes? per second|GB|TB|MB|LPUs?|advertisers?)/i
  );
  if (withUnit) {
    const v = parseFloat(withUnit[1].replace(/,/g, ''));
    if (isFinite(v)) {
      const key = withUnit[2].toLowerCase().replace(/\s+/g, ' ').trim();
      return { value: v, unit: UNIT_ALIASES[key] || withUnit[2] };
    }
  }

  // Bare large number, e.g. "40,000 advertisers have onboarded".
  // A standalone four-digit token in the calendar range is almost always a year
  // ("the ads business launched in March 2026"), and reading it as a count
  // produced metric cards that literally said "2026". Comma-grouped values and
  // five-digit-plus values are unambiguous, so only the 4-digit case is guarded.
  const bare = t.match(/\b([\d]{1,3}(?:,[\d]{3})+|\d{4,})\b/);
  if (bare) {
    const v = parseFloat(bare[1].replace(/,/g, ''));
    const looksLikeYear = /^\d{4}$/.test(bare[1]) && v >= 1900 && v <= 2100;
    if (isFinite(v) && !looksLikeYear) { return { value: v, unit: 'count' }; }
  }

  return null;
}

/** Extract an ISO-ish date, preferring month-year precision. */
function extractDate(text) {
  const t = String(text);

  const iso = t.match(/\b(20\d{2})-(\d{2})(?:-(\d{2}))?\b/);
  if (iso) { return iso[3] ? iso[1] + '-' + iso[2] + '-' + iso[3] : iso[1] + '-' + iso[2]; }

  const monthYear = t.match(new RegExp('\\b(' + MONTH_ALT + ')\\.?\\s+(20\\d{2})\\b', 'i'));
  if (monthYear) {
    const mm = MONTHS[monthYear[1].toLowerCase()];
    if (mm) { return monthYear[2] + '-' + String(mm).padStart(2, '0'); }
  }

  const year = t.match(/\b(20\d{2})\b/);
  if (year) { return year[1]; }

  return null;
}

/* A month named without a year. Case-sensitive on purpose: lowercase "may" is
 * usually the modal verb ("may reach $2B"), and reading it as a month put
 * fictional dates on chart axes. */
const BARE_MONTH_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/;

function extractBareMonth(text) {
  const m = String(text).match(BARE_MONTH_RE);
  if (!m) { return null; }
  return MONTHS[m[1].toLowerCase()] || null;
}

/** Render an ISO year or year-month as a human axis label, e.g. "Aug 2026". */
function labelForDate(iso) {
  if (!iso) { return null; }
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(String(iso));
  if (!m) { return String(iso); }
  if (!m[2]) { return m[1]; }
  const label = MONTH_LABELS[Number(m[2]) - 1];
  return label ? label + ' ' + m[1] : m[1];
}

/**
 * Extract a progression from prose, e.g.
 *   "grew from $12 million in April to $83 million in August 2026"
 * This is the single highest-value extraction: a two-point progression is
 * exactly what makes a line chart possible, and it is the shape most commonly
 * buried in a research sentence.
 */
function extractProgression(text) {
  const t = String(text);
  const m = t.match(new RegExp(
    'from\\s+(.{1,60}?)\\s+(?:to|up to|\u2192)\\s+(.{1,60}?)' + CLAUSE_END, 'i'
  ));
  if (!m) { return null; }

  const leftRaw = m[1];
  const rightRaw = m[2];

  const l = extractCurrency(leftRaw) || extractNumberWithUnit(leftRaw);
  const r = extractCurrency(rightRaw) || extractNumberWithUnit(rightRaw);
  if (!l || !r) { return null; }
  // Mixing units across a progression would produce a misleading axis.
  if (l.unit !== r.unit) { return null; }

  let lDate = extractDate(leftRaw);
  let rDate = extractDate(rightRaw);

  /* Prose states the year once: "from $12M in April to $83M in August 2026".
   * Borrowing it gives the earlier point a real label instead of the placeholder
   * "before" - and because downstream code treats a dated first point as the
   * signal that a series is time-based, without this the progression was not
   * recognised as chartable at all. */
  if (!lDate && rDate && rDate.length >= 7) {
    const lMonth = extractBareMonth(leftRaw);
    if (lMonth) {
      let year = Number(rDate.slice(0, 4));
      const rMonth = Number(rDate.slice(5, 7));
      // A borrowed year must not make the series run backwards.
      if (rMonth && lMonth > rMonth) { year -= 1; }
      lDate = String(year) + '-' + String(lMonth).padStart(2, '0');
    }
  } else if (!rDate && lDate && lDate.length >= 7) {
    const rMonth = extractBareMonth(rightRaw);
    if (rMonth) {
      let year = Number(lDate.slice(0, 4));
      const lMonth = Number(lDate.slice(5, 7));
      if (lMonth && rMonth < lMonth) { year += 1; }
      rDate = String(year) + '-' + String(rMonth).padStart(2, '0');
    }
  }

  return {
    unit: l.unit,
    series: [
      { label: labelForDate(lDate) || 'before', value: l.value, date: lDate },
      { label: labelForDate(rDate) || 'after', value: r.value, date: rDate },
    ],
  };
}

/* Words that are capitalised only because they open a clause. Treating them as
 * entity names produced axis labels like "Average vs Google Search". */
const LEAD_WORDS = [
  'average', 'median', 'mean', 'monthly', 'annual', 'annualized', 'annualised',
  'quarterly', 'daily', 'weekly', 'total', 'over', 'under', 'about', 'around',
  'roughly', 'approximately', 'nearly', 'almost', 'the', 'this', 'that',
  'these', 'those', 'some', 'most', 'more', 'less', 'fewer', 'each', 'every',
  'its', 'their', 'they', 'we', 'it', 'up', 'down', 'from', 'and', 'but',
];

/* Label each side of a comparison with a proper noun from its own clause where
 * possible; "ChatGPT vs Google Search" is far more useful on an axis than
 * "A vs B". */
function labelFrom(clause, fallback) {
  const s = String(clause);
  const leadOffset = s.length - s.replace(/^\s+/, '').length;
  const re = /\b([A-Z][A-Za-z0-9+.]{2,}(?:\s+[A-Z][A-Za-z0-9+.]{2,})?)\b/g;
  const found = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const firstWord = m[1].split(/\s+/)[0].toLowerCase().replace(/\.+$/, '');
    if (m.index <= leadOffset && LEAD_WORDS.indexOf(firstWord) !== -1) { continue; }
    found.push(m[1]);
  }
  if (found.length > 0) { return found[found.length - 1]; }
  return fallback;
}

/**
 * Extract a two-sided comparison, e.g.
 *   "$1.40, compared to $2.70 on Google Search"
 * Produces a series suitable for a grouped bar chart. `subjectHint` names the
 * carousel's subject and is used for the left label when the clause itself does
 * not name it, which is common ("Average cost per click is $1.40, ...").
 */
function extractComparison(text, subjectHint) {
  const t = String(text);
  const m = t.match(new RegExp(
    '(.{1,70}?)\\s*,?\\s*(?:compared (?:to|with)|versus|vs\\.?)\\s+(.{1,70}?)' + CLAUSE_END, 'i'
  ));
  if (!m) { return null; }

  const l = extractCurrency(m[1]) || extractNumberWithUnit(m[1]);
  const r = extractCurrency(m[2]) || extractNumberWithUnit(m[2]);
  if (!l || !r || l.unit !== r.unit) { return null; }

  return {
    unit: l.unit,
    series: [
      { label: labelFrom(m[1], str(subjectHint) || 'This'), value: l.value },
      { label: labelFrom(m[2], 'That'), value: r.value },
    ],
  };
}

/* ------------------------------------------------------------- normalisation */

function str(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

/**
 * Map the legacy `credibility` field onto a confidence level. The old vocabulary
 * conflated source authority with claim certainty; keeping them separate lets a
 * community-sourced claim still be reported, just labelled honestly.
 */
function confidenceFromCredibility(cred) {
  const c = str(cred).toLowerCase();
  if (c === 'verified') { return 'high'; }
  if (c === 'community') { return 'medium'; }
  return 'low';
}

/**
 * Normalise one finding - new or legacy shape - into a canonical claim.
 * Never throws: a claim that cannot be parsed still passes through as a
 * text-only claim, because dropping evidence silently is worse than carrying a
 * claim that simply cannot be charted.
 *
 * `subject` is the carousel's subject (e.g. "ChatGPT Ads") and is used only to
 * label the near side of a comparison when the sentence does not name it.
 */
function normaliseClaim(raw, index, subject) {
  const text = str(raw && (raw.claim || raw.text));
  const id = str(raw && raw.id) || ('c' + String(index + 1));
  // Guard against Array#map passing its third argument (the source array).
  const subjectHint = (typeof subject === 'string') ? subject : '';

  const sourceName = str(raw && (raw.source_name || raw.source));
  const sourceUrl = str(raw && raw.source_url);

  const sources = [{
    name: sourceName || 'Unknown source',
    url: sourceUrl,
    tier: Number(raw && raw.source_tier) || classifySourceTier(sourceName, sourceUrl),
    published_at: str(raw && raw.source_published_at) || null,
  }];

  // Prefer structured fields when Workflow 2 supplied them; fall back to prose
  // extraction for legacy packages.
  let value = (typeof (raw && raw.value) === 'number') ? raw.value : null;
  let unit = str(raw && raw.unit) || null;
  let series = Array.isArray(raw && raw.series) ? raw.series : null;

  if (value === null && !series) {
    const prog = extractProgression(text);
    if (prog) {
      series = prog.series;
      unit = unit || prog.unit;
      value = prog.series[prog.series.length - 1].value;
    }
  }

  if (value === null && !series) {
    const cmp = extractComparison(text, subjectHint);
    if (cmp) {
      series = cmp.series;
      unit = unit || cmp.unit;
    }
  }

  if (value === null) {
    const cur = extractCurrency(text);
    if (cur) { value = cur.value; unit = unit || cur.unit; }
  }
  if (value === null) {
    const num = extractNumberWithUnit(text);
    if (num) { value = num.value; unit = unit || num.unit; }
  }

  const date = str(raw && raw.date) || extractDate(text);
  const measureKind = str(raw && raw.measure_kind) || detectMeasureKind(text);

  let claimType = str(raw && raw.claim_type);
  if (CLAIM_TYPES.indexOf(claimType) === -1) {
    // Infer a type rather than defaulting everything to "fact", which would let
    // a projection be presented with the authority of a measurement.
    if (series && series.length === 2 && !series[0].date) { claimType = 'comparison'; }
    else if (measureKind === 'projection') { claimType = 'projection'; }
    else if (measureKind === 'estimate') { claimType = 'estimate'; }
    else if (/^["'“]/.test(text) || /\bsaid\b|\btold\b/.test(text)) { claimType = 'quote'; }
    else { claimType = 'fact'; }
  }

  // supports_visual is the signal the visual planner uses to decide whether a
  // chart is even possible. A single number can be a metric card; two or more
  // points can be a real chart.
  const supportsVisual = Boolean(series && series.length >= 2) || value !== null;

  return {
    id: id,
    text: text,
    claim_type: claimType,
    measure_kind: measureKind,
    value: value,
    unit: unit,
    date: date,
    series: series,
    sources: sources,
    confidence: str(raw && raw.confidence) || confidenceFromCredibility(raw && raw.credibility),
    evidence_excerpt: str(raw && raw.evidence_excerpt) || null,
    supports_visual: supportsVisual,
    chartable: Boolean(series && series.length >= 2),
  };
}

/**
 * Merge claims that assert the same thing from different sources.
 *
 * This implements cross-source synthesis: one claim with two sources is
 * stronger evidence AND better editorial content than two near-identical
 * slides, which is what the previous pipeline produced.
 */
function mergeDuplicateClaims(claims) {
  const byKey = {};
  const merged = [];

  claims.forEach(function (c) {
    // Key on the numeric fingerprint when there is one, since two sources
    // reporting "$1B run rate" will word it differently but mean the same thing.
    const key = (c.value !== null && c.unit)
      ? 'v:' + c.value + ':' + c.unit + ':' + c.measure_kind
      : 't:' + c.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);

    if (byKey[key] === undefined) {
      byKey[key] = merged.length;
      merged.push(c);
      return;
    }

    const target = merged[byKey[key]];
    c.sources.forEach(function (s) {
      const already = target.sources.some(function (t) {
        return t.name === s.name && t.url === s.url;
      });
      if (!already) { target.sources.push(s); }
    });
    // Keep the richer of the two: a series beats a bare value.
    if (!target.series && c.series) { target.series = c.series; target.chartable = true; }
    if (!target.evidence_excerpt && c.evidence_excerpt) {
      target.evidence_excerpt = c.evidence_excerpt;
    }
  });

  return merged;
}

/**
 * Turn a Workflow 2 research package into a normalised claim set plus a
 * source manifest.
 */
function buildClaimSet(researchPackage) {
  const pkg = researchPackage || {};
  const findings = Array.isArray(pkg.findings) ? pkg.findings : [];
  const subject = str(pkg.subject || pkg.topic || pkg.title);

  const normalised = findings
    .map(function (f, i) { return normaliseClaim(f, i, subject); })
    .filter(function (c) { return c.text.length > 0; });

  const claims = mergeDuplicateClaims(normalised);

  // Best available tier per claim drives the "is this well supported" check.
  claims.forEach(function (c) {
    c.best_tier = c.sources.reduce(function (acc, s) {
      return Math.min(acc, Number(s.tier) || 4);
    }, 4);
    // A material numeric claim resting only on tier 4 is flagged rather than
    // dropped - it may still be worth reporting, but not as established fact.
    c.weakly_sourced = c.best_tier >= 4 && c.value !== null;
  });

  const sourceManifest = [];
  const seenSource = {};
  claims.forEach(function (c) {
    c.sources.forEach(function (s) {
      const k = (s.name || '') + '|' + (s.url || '');
      if (seenSource[k]) { return; }
      seenSource[k] = true;
      sourceManifest.push({
        name: s.name,
        url: s.url,
        tier: s.tier,
        tier_description: SOURCE_TIERS[s.tier] || null,
        published_at: s.published_at || null,
      });
    });
  });

  const chartable = claims.filter(function (c) { return c.chartable; });

  return {
    claims: claims,
    source_manifest: sourceManifest,
    stats: {
      findings_in: findings.length,
      claims_out: claims.length,
      merged: normalised.length - claims.length,
      with_value: claims.filter(function (c) { return c.value !== null; }).length,
      chartable: chartable.length,
      weakly_sourced: claims.filter(function (c) { return c.weakly_sourced; }).length,
      tier1: claims.filter(function (c) { return c.best_tier === 1; }).length,
      tier4_only: claims.filter(function (c) { return c.best_tier === 4; }).length,
    },
  };
}

module.exports = {
  buildClaimSet,
  normaliseClaim,
  mergeDuplicateClaims,
  classifySourceTier,
  detectMeasureKind,
  extractCurrency,
  extractNumberWithUnit,
  extractDate,
  extractProgression,
  extractComparison,
  labelForDate,
  publishEligibilityFor,
};
