'use strict';

/* Chart rendering - hand-rolled SVG, zero dependencies.
 *
 * WHY NOT A CHARTING LIBRARY: the design audit found the real problem was not
 * "our charts look bad", it was that there were NO charts - every figure in
 * every carousel was set as typography, because nothing structured existed to
 * plot. What is needed is a small number of chart forms that are correct and
 * legible at phone size, not a general-purpose plotting engine. Chart.js and
 * friends would add a browser-runtime dependency, a bundle to keep alive inside
 * the Playwright page, and a whole configuration surface whose defaults
 * (non-zero baselines, decorative gradients, unlabelled axes) are exactly the
 * things this module exists to forbid.
 *
 * The output is INLINE SVG, not an <img> or data URI, specifically so the theme
 * cascade reaches it: every colour is a CSS custom property, so a chart adopts
 * whichever of the 11 themes the slide is using without this file knowing any
 * of them. Nothing here sets a literal colour.
 *
 * EDITORIAL RULES, enforced in code rather than left to the caller:
 *   1. Value axes start at zero. A truncated baseline exaggerates a difference,
 *      which on a chart presented as evidence is a misrepresentation.
 *   2. No 3D, no perspective, no drop shadows on data marks. Depth encodes
 *      nothing and distorts area comparison.
 *   3. Every data point carries a label, and the chart carries its unit.
 *   4. Every chart carries its source, baked into the SVG, so attribution
 *      cannot be lost by a template that forgets to print it.
 *   5. No chart below its minimum point count. A "trend" through two points is
 *      a line segment; a "line chart" through one point is decoration.
 * A violation raises a caller-fault error rather than rendering something
 * quietly misleading.
 *
 * Bars are HORIZONTAL throughout. Vertical bars force category labels into
 * rotated text, which is the single worst legibility failure at 1080px on a
 * phone; horizontal bars give every label a full line to itself.
 */

const {
  CHART_KINDS,
  CHART_MIN_POINTS,
  CHART_MAX_POINTS,
  validationError,
} = require('./contracts');

/* Default drawing box. 888 is the 1080 canvas less the 96px safe-area padding
 * on each side, so a chart at this width lines up with the text above it. */
const DEFAULT_WIDTH = 888;
const DEFAULT_HEIGHT = 560;

/* Type sizes are absolute pixels at 1080 wide. 22px is the floor: below that,
 * text is unreadable once Instagram has scaled the image down on a phone. */
const FS_MIN = 22;
const FS_TICK = 24;
const FS_LABEL = 28;
const FS_VALUE = 34;
const FS_LEGEND = 26;
const FS_SOURCE = 22;

/* ------------------------------------------------------------------ escaping */

/* Text reaching the SVG is source-derived, so it is escaped rather than
 * trusted. `"` and `'` are included because the same helper is used for
 * attribute values. */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Round to 2dp for SVG coordinates. Full float precision bloats the markup and
 * changes nothing a screenshot can resolve. */
function n2(v) {
  return Math.round(Number(v) * 100) / 100;
}

/* ------------------------------------------------------------ text measuring */

/* Approximate advance widths as a fraction of font size, for a humanist sans
 * (Inter and the system fallbacks). This exists to decide label column widths
 * and truncation BEFORE the SVG reaches a browser, so no layout pass is needed.
 * It only has to be close: every consumer adds slack, and render.js has a hard
 * overflow check that fails loudly if an estimate was ever badly wrong. */
const NARROW = "iljtIf.,:;'|!()[]{}/\\-";
const WIDE = 'mwMW@%&';

function textWidth(text, fontSize) {
  const s = String(text || '');
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') { units += 0.28; }
    else if (NARROW.indexOf(ch) !== -1) { units += 0.33; }
    else if (WIDE.indexOf(ch) !== -1) { units += 0.9; }
    else if (ch >= '0' && ch <= '9') { units += 0.56; }
    else if (ch >= 'A' && ch <= 'Z') { units += 0.68; }
    else { units += 0.54; }
  }
  return units * fontSize;
}

/* Truncate to fit, on a word boundary where one is available - a label cut
 * mid-word reads as a rendering bug rather than an editorial choice. */
function truncateToWidth(text, fontSize, maxWidth) {
  const s = String(text || '');
  if (textWidth(s, fontSize) <= maxWidth) { return { text: s, truncated: false }; }

  const ellipsis = '\u2026';
  const budget = maxWidth - textWidth(ellipsis, fontSize);
  if (budget <= 0) { return { text: ellipsis, truncated: true }; }

  let cut = s.length;
  while (cut > 0 && textWidth(s.slice(0, cut), fontSize) > budget) { cut -= 1; }

  const hard = s.slice(0, cut);
  const lastSpace = hard.lastIndexOf(' ');
  const body = (lastSpace > budget / (fontSize * 0.9)) ? hard.slice(0, lastSpace) : hard;
  return { text: body.replace(/[\s,;:.-]+$/, '') + ellipsis, truncated: true };
}

/**
 * Wrap text to at most `maxLines` lines of `maxWidth`, truncating the last line
 * if it still will not fit.
 *
 * Wrapping rather than shrinking is deliberate: dropping the font size to make a
 * label fit is how charts become unreadable at phone scale, and FS_MIN exists to
 * stop that. Two lines of 28px beat one line of 18px every time.
 */
function wrapToWidth(text, fontSize, maxWidth, maxLines) {
  const limit = maxLines || 2;
  const words = String(text || '').split(/\s+/).filter(function (w) { return w.length > 0; });
  if (words.length === 0) { return { lines: [], truncated: false }; }

  const lines = [];
  let current = '';

  for (let i = 0; i < words.length; i++) {
    const candidate = current ? current + ' ' + words[i] : words[i];
    if (textWidth(candidate, fontSize) <= maxWidth || current === '') {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = words[i];
    if (lines.length === limit) { break; }
  }

  if (lines.length < limit && current) { lines.push(current); }

  // Anything left over is folded into the last line and truncated there, so the
  // ellipsis marks the actual loss rather than appearing mid-label.
  const consumed = lines.join(' ').split(/\s+/).length;
  if (consumed < words.length) {
    const rest = words.slice(consumed).join(' ');
    const tail = truncateToWidth(lines[lines.length - 1] + ' ' + rest, fontSize, maxWidth);
    lines[lines.length - 1] = tail.text;
    return { lines: lines, truncated: true };
  }

  // A single word longer than the box still has to be cut.
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (textWidth(lines[i], fontSize) > maxWidth) {
      const t = truncateToWidth(lines[i], fontSize, maxWidth);
      lines[i] = t.text;
      truncated = true;
    }
  }
  return { lines: lines, truncated: truncated };
}

/* ----------------------------------------------------------- value formatting */

/* Unit metadata. `axis` is what a tick row is captioned with; `suffix`/`prefix`
 * are what sits against an individual number. Splitting the two is what lets a
 * bar read "$83M" while the axis reads "USD, millions" without repeating the
 * unit on every tick. */
const UNIT_INFO = {
  USD: { prefix: '$', axis: 'USD' },
  USD_K: { prefix: '$', suffix: 'K', axis: 'USD, thousands' },
  USD_M: { prefix: '$', suffix: 'M', axis: 'USD, millions' },
  USD_B: { prefix: '$', suffix: 'B', axis: 'USD, billions' },
  USD_T: { prefix: '$', suffix: 'T', axis: 'USD, trillions' },
  percent: { suffix: '%', axis: 'percent' },
  percentage_point: { suffix: ' pp', axis: 'percentage points' },
  multiple: { suffix: 'x', axis: 'multiple' },
  count: { axis: 'count' },
  tokens_per_sec: { axis: 'tokens / second' },
  GB_per_sec: { axis: 'GB / second' },
  PB_per_sec: { axis: 'PB / second' },
  GB: { suffix: ' GB', axis: 'gigabytes' },
  TB: { suffix: ' TB', axis: 'terabytes' },
  MB: { suffix: ' MB', axis: 'megabytes' },
  ms: { suffix: ' ms', axis: 'milliseconds' },
  seconds: { suffix: 's', axis: 'seconds' },
};

/** Human-readable axis caption for a unit, e.g. "USD, millions". */
function axisUnitLabel(unit) {
  if (!unit) { return ''; }
  const info = UNIT_INFO[unit];
  if (info && info.axis) { return info.axis; }
  // An unrecognised unit is passed through rather than dropped: losing it would
  // leave an unlabelled axis, which rule 3 exists to prevent.
  return String(unit).replace(/_/g, ' ');
}

function groupThousands(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* Significant-figure rules chosen for reading at a glance: whole numbers where
 * the magnitude allows, one decimal for small values, two only for currency
 * under $10 where cents are the whole point (a $1.40 CPC is not "$1"). */
function formatNumber(value, unit) {
  const v = Number(value);
  if (!isFinite(v)) { return String(value); }
  const abs = Math.abs(v);

  let decimals;
  if (unit === 'USD' && abs < 10) { decimals = 2; }
  else if (abs === 0) { decimals = 0; }
  else if (abs < 10) { decimals = (Math.round(v * 10) === Math.round(v) * 10) ? 0 : 1; }
  else if (abs < 100) { decimals = (Math.round(v) === v) ? 0 : 1; }
  else { decimals = 0; }

  const fixed = v.toFixed(decimals);
  const parts = fixed.split('.');
  const out = groupThousands(parts[0]) + (parts[1] ? '.' + parts[1] : '');
  return out;
}

/** Format a value with its unit, e.g. 83 + USD_M -> "$83M". */
function formatValue(value, unit) {
  const info = UNIT_INFO[unit] || {};
  const num = formatNumber(value, unit);
  return (info.prefix || '') + num + (info.suffix || '');
}

/* Axis ticks carry no unit markers - the axis caption states the unit once. */
function formatTick(value, unit) {
  const info = UNIT_INFO[unit] || {};
  return (info.prefix || '') + formatNumber(value, unit) + (info.suffix || '');
}

/* --------------------------------------------------------------- axis domains */

/* Classic 1-2-5 step selection. */
function niceStep(rough) {
  if (!(rough > 0)) { return 1; }
  const exp = Math.floor(Math.log10(rough));
  const pow = Math.pow(10, exp);
  const frac = rough / pow;
  let mult;
  if (frac <= 1) { mult = 1; }
  else if (frac <= 2) { mult = 2; }
  else if (frac <= 5) { mult = 5; }
  else { mult = 10; }
  return mult * pow;
}

/**
 * Build a value axis. RULE 1 LIVES HERE: the domain always includes zero.
 *
 * With only positive data the axis runs 0..max; with negatives present it runs
 * min..max spanning zero so the zero line sits inside the plot where it can be
 * drawn. There is deliberately no option to truncate the baseline - a caller
 * that wants to emphasise a small difference should say so in the headline,
 * not by distorting the geometry.
 */
function buildAxis(values, unit, targetTicks) {
  const nums = values.filter(function (v) { return isFinite(v); });
  const dataMax = nums.length ? Math.max.apply(null, nums) : 0;
  const dataMin = nums.length ? Math.min.apply(null, nums) : 0;

  let lo = Math.min(0, dataMin);
  let hi = Math.max(0, dataMax);

  // All-zero data still needs a drawable axis rather than a zero-width domain.
  if (lo === hi) { hi = lo + 1; }

  const want = targetTicks || 5;
  const step = niceStep((hi - lo) / want);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const ticks = [];
  // Float accumulation drifts, so ticks are indexed rather than incremented.
  const count = Math.round((hi - lo) / step);
  for (let i = 0; i <= count; i++) {
    const raw = lo + i * step;
    // Kill -0 and 1e-15 artefacts that would print as "-0".
    ticks.push(Math.abs(raw) < step * 1e-9 ? 0 : raw);
  }

  return {
    min: lo,
    max: hi,
    step: step,
    ticks: ticks,
    unit: unit || null,
    unitLabel: axisUnitLabel(unit),
    includesNegative: lo < 0,
  };
}

/* ------------------------------------------------------------ svg primitives */

/* Every mark uses a semantic class so themes.css owns the palette. */
function svgText(x, y, content, opts) {
  const o = opts || {};
  const attrs = [
    'x="' + n2(x) + '"',
    'y="' + n2(y) + '"',
    'class="' + esc(o.cls || 'c-label') + '"',
    'font-size="' + n2(o.size || FS_LABEL) + '"',
  ];
  if (o.anchor) { attrs.push('text-anchor="' + esc(o.anchor) + '"'); }
  if (o.weight) { attrs.push('font-weight="' + esc(o.weight) + '"'); }
  if (o.baseline) { attrs.push('dominant-baseline="' + esc(o.baseline) + '"'); }
  return '<text ' + attrs.join(' ') + '>' + esc(content) + '</text>';
}

function svgRect(x, y, w, h, cls, radius) {
  const r = radius === undefined ? 4 : radius;
  // A negative width would silently drop the rect in some renderers.
  const width = Math.max(0, w);
  const height = Math.max(0, h);
  return '<rect x="' + n2(x) + '" y="' + n2(y) + '" width="' + n2(width)
    + '" height="' + n2(height) + '" rx="' + n2(Math.min(r, height / 2, width / 2))
    + '" class="' + esc(cls) + '"/>';
}

function svgLine(x1, y1, x2, y2, cls) {
  return '<line x1="' + n2(x1) + '" y1="' + n2(y1) + '" x2="' + n2(x2)
    + '" y2="' + n2(y2) + '" class="' + esc(cls) + '"/>';
}

function svgCircle(cx, cy, r, cls) {
  return '<circle cx="' + n2(cx) + '" cy="' + n2(cy) + '" r="' + n2(r)
    + '" class="' + esc(cls) + '"/>';
}

function svgPath(d, cls) {
  return '<path d="' + d + '" class="' + esc(cls) + '"/>';
}

/* --------------------------------------------------------------- normalisation */

/* Accepts either an explicit chart spec or a normalised claim from claims.js,
 * so the visual planner can hand a claim straight through without restating its
 * series. `date` is preserved because timeline-scaled needs real positions. */
function normalisePoints(input) {
  const raw = Array.isArray(input) ? input : [];
  /* null and '' must NOT become 0. Number(null) is 0 and Number('') is 0, so a
   * missing figure would have been drawn as a zero-length bar sitting on the
   * axis - a real data point, as far as a reader is concerned, asserting
   * something the research never said. Mapping them to NaN routes them into the
   * finite-number check, which refuses the chart instead. */
  const num = function (v) {
    if (v === null || v === undefined || v === '') { return NaN; }
    return Number(v);
  };

  return raw.map(function (p, i) {
    if (p === null || p === undefined) { return { label: '', value: NaN, index: i }; }
    if (typeof p === 'number') { return { label: String(i + 1), value: p, index: i }; }
    const values = Array.isArray(p.values)
      ? p.values.map(num)
      : (p.value === undefined ? [] : [num(p.value)]);
    return {
      label: p.label === undefined || p.label === null ? '' : String(p.label),
      value: values.length ? values[0] : NaN,
      values: values,
      date: p.date || null,
      note: p.note || null,
      // Emphasis is an editorial signal from the planner ("this is the point of
      // the chart"), not a styling instruction - the theme decides how it looks.
      emphasis: Boolean(p.emphasis),
      index: i,
    };
  });
}

/* A chart's source is baked in (rule 4). Multiple sources are joined because a
 * merged claim legitimately has two, and dropping one would misattribute. */
function sourceLine(spec) {
  if (spec.source) { return String(spec.source); }

  const list = []
    .concat(spec.sources || [])
    .map(function (s) {
      if (!s) { return ''; }
      return typeof s === 'string' ? s : String(s.name || '');
    })
    .filter(function (s) { return s.length > 0; });

  const unique = [];
  list.forEach(function (s) { if (unique.indexOf(s) === -1) { unique.push(s); } });
  if (unique.length === 0) { return ''; }

  const named = unique.length > 2
    ? unique.slice(0, 2).join(', ') + ' +' + (unique.length - 2) + ' more'
    : unique.join(', ');

  const asOf = spec.as_of || spec.asOf;
  return 'Source: ' + named + (asOf ? ' \u00b7 as of ' + asOf : '');
}

const SORT_MODES = ['none', 'asc', 'desc'];

/**
 * Order the points of a categorical chart.
 *
 * Default is 'none' - the caller's order is preserved. That is deliberate and it
 * is the opposite of what most charting libraries do. A bar chart has no
 * meaningful category order, so sorting is usually an improvement; but a
 * comparison frequently leads with the subject on purpose ("ChatGPT Ads" first,
 * then the competitors), and silently moving it would change what the slide is
 * about. So sorting is offered and must be asked for.
 *
 * Sorting is meaningless for the ordered kinds - a line or a timeline is ordered
 * by its axis - so it is rejected there rather than quietly ignored.
 */
function sortPoints(points, mode, kind) {
  const m = String(mode || 'none');
  if (SORT_MODES.indexOf(m) === -1) {
    throw validationError('chart.sort must be one of ' + SORT_MODES.join(', ') + ', got ' + JSON.stringify(mode));
  }
  if (m === 'none') { return points; }
  if (kind === 'line' || kind === 'timeline-scaled' || kind === 'progression') {
    throw validationError(
      'chart.sort cannot be used with kind "' + kind + '" - its order is the axis, and reordering it would falsify the sequence'
    );
  }

  // Sorted on a copy: mutating the caller's array would be a side effect on data
  // they may render again.
  const sorted = points.slice();
  const dir = m === 'asc' ? 1 : -1;
  sorted.sort(function (a, b) {
    // Grouped bars sort on their first series, which is the one the eye reads as
    // the subject.
    const av = (a.values && a.values.length) ? a.values[0] : a.value;
    const bv = (b.values && b.values.length) ? b.values[0] : b.value;
    if (av === bv) { return a.index - b.index; }
    return (av - bv) * dir;
  });
  return sorted;
}

/**
 * Validate a chart spec. Enforces the point-count rules (rule 5) and the
 * label/unit requirements (rule 3) as caller-fault errors, because a chart that
 * cannot be labelled honestly must not be drawn at all.
 */
function validateChartSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw validationError('chart spec must be an object');
  }
  const kind = String(spec.kind || '').trim();
  if (CHART_KINDS.indexOf(kind) === -1) {
    throw validationError('chart.kind "' + kind + '" is not supported. Supported: ' + CHART_KINDS.join(', '));
  }

  const points = normalisePoints(spec.series);
  const min = CHART_MIN_POINTS[kind];
  const max = CHART_MAX_POINTS[kind];

  if (points.length < min) {
    throw validationError(
      'chart.kind "' + kind + '" needs at least ' + min + ' data points, got ' + points.length
      + ' - render this as a metric card or sentence instead of a chart'
    );
  }
  if (points.length > max) {
    throw validationError(
      'chart.kind "' + kind + '" has ' + points.length + ' points; at most ' + max
      + ' stay legible at phone size - aggregate or split across slides'
    );
  }

  points.forEach(function (p, i) {
    if (!p.label) {
      throw validationError('chart.series[' + i + '].label is required - unlabelled data points are not publishable');
    }
    const vals = p.values && p.values.length ? p.values : [p.value];
    vals.forEach(function (v, vi) {
      if (!isFinite(v)) {
        const at = 'chart.series[' + i + ']' + (vals.length > 1 ? '.values[' + vi + ']' : '.value');
        throw validationError(at + ' must be a finite number, got ' + JSON.stringify(v));
      }
    });
  });

  if (!spec.unit) {
    throw validationError('chart.unit is required - an axis without a unit cannot be read');
  }

  if (kind === 'grouped-bar') {
    const widths = points.map(function (p) { return p.values.length; });
    const distinct = widths.filter(function (w, i) { return widths.indexOf(w) === i; });
    if (distinct.length > 1) {
      throw validationError('grouped-bar requires the same number of values in every group, got ' + widths.join(', '));
    }
    if (widths[0] < 2) {
      throw validationError('grouped-bar needs at least 2 values per group; use kind "bar" for a single series');
    }
    const names = Array.isArray(spec.series_names || spec.seriesNames) ? (spec.series_names || spec.seriesNames) : [];
    if (names.length !== widths[0]) {
      throw validationError('grouped-bar requires series_names naming all ' + widths[0] + ' series, got ' + names.length);
    }
  }

  if (kind === 'share') {
    const negative = points.filter(function (p) { return p.value < 0; });
    if (negative.length > 0) {
      throw validationError('chart.kind "share" cannot represent negative values - a part of a whole is never negative');
    }
    const total = points.reduce(function (a, p) { return a + p.value; }, 0);
    if (!(total > 0)) {
      throw validationError('chart.kind "share" needs a positive total');
    }
  }

  if (kind === 'timeline-scaled') {
    const undated = points.filter(function (p) { return !p.date; });
    if (undated.length > 0) {
      throw validationError(
        'chart.kind "timeline-scaled" requires a date on every point (' + undated.length
        + ' missing) - without real dates the spacing would be fictional; use kind "bar" instead'
      );
    }
  }

  return { kind: kind, points: sortPoints(points, spec.sort, kind) };
}

/* ------------------------------------------------------------- chart chrome */

/* Vertical space reserved for the baked-in source line. */
function sourceBlockHeight(text) {
  return text ? FS_SOURCE + 20 : 0;
}

/* Wrapping the SVG in a figure with a stable class list is what lets themes.css
 * style data marks without this module holding any colours, and what lets
 * render.js's overflow check attribute a failure to the chart. */
function wrapSvg(body, spec, size, meta) {
  const src = meta.source;
  const kind = meta.kind;

  const parts = [];
  parts.push(
    '<svg class="chart chart-' + esc(kind) + '" viewBox="0 0 ' + n2(size.width) + ' ' + n2(size.height) + '"'
    + ' width="' + n2(size.width) + '" height="' + n2(size.height) + '"'
    + ' role="img" aria-label="' + esc(meta.aria || (kind + ' chart')) + '"'
    + ' xmlns="http://www.w3.org/2000/svg">'
  );
  parts.push(body);
  if (src) {
    parts.push(svgText(0, size.height - 6, src, {
      cls: 'c-source', size: FS_SOURCE, anchor: 'start',
    }));
  }
  parts.push('</svg>');

  return {
    svg: parts.join(''),
    kind: kind,
    width: size.width,
    height: size.height,
    unit: spec.unit,
    unit_label: axisUnitLabel(spec.unit),
    source: src,
    points: meta.pointCount,
    warnings: meta.warnings,
  };
}

/* ---------------------------------------------------------- horizontal bars */

/* Label column sizing. Bars stay horizontal (see header) so each category gets
 * a full line; the column is capped at 38% of width so the bars themselves keep
 * enough room to be comparable, and longer labels are truncated rather than
 * allowed to squeeze the data. */
function labelColumnWidth(points, width, fontSize) {
  const cap = width * 0.38;
  const longest = points.reduce(function (acc, p) {
    return Math.max(acc, textWidth(p.label, fontSize));
  }, 0);
  return Math.min(cap, Math.max(140, longest + 16));
}

/* Tick labels are centred on their gridline, so the outermost ones would hang
 * past the plot edges. Anchoring the first to its start and the last to its end
 * keeps every tick inside the box - the alternative (letting them overhang) put
 * the rightmost tick underneath the axis unit caption and produced two strings
 * drawn on top of each other. */
function tickAnchor(x, plotLeft, plotRight, text, fontSize) {
  const half = textWidth(text, fontSize) / 2;
  if (x - half < plotLeft) { return 'start'; }
  if (x + half > plotRight) { return 'end'; }
  return 'middle';
}

/* Width to reserve at the right edge for value labels sitting outside their bar
 * tip. Without this the longest bar's value had nowhere to go and fell back to
 * being drawn INSIDE the bar, which made it look like a different style of label
 * from all the others on the same chart. */
function valueColumnWidth(texts, fontSize) {
  const widest = texts.reduce(function (acc, t) {
    return Math.max(acc, textWidth(t, fontSize));
  }, 0);
  return widest + 22;
}

/**
 * Horizontal bar chart - the default for comparing named categories.
 *
 * The zero line is drawn explicitly whenever the domain spans negatives, since
 * that is the reference the eye needs and rule 1 guarantees it is in frame.
 */
function renderBar(spec, opts) {
  const o = opts || {};
  const checked = validateChartSpec(spec);
  const points = checked.points;
  const width = o.width || DEFAULT_WIDTH;

  const src = sourceLine(spec);
  const warnings = [];

  const rowH = points.length <= 3 ? 96 : (points.length <= 5 ? 78 : 62);
  const gap = Math.max(12, Math.round(rowH * 0.22));
  const axisCaptionH = FS_TICK + 14;
  const height = o.height
    || (points.length * rowH + (points.length - 1) * gap + axisCaptionH + sourceBlockHeight(src) + 12);

  const labelW = labelColumnWidth(points, width, FS_LABEL);
  const plotX = labelW + 20;
  const valueW = valueColumnWidth(
    points.map(function (p) { return formatValue(p.value, spec.unit); }),
    FS_VALUE
  );
  const plotW = width - plotX - valueW;

  const axis = buildAxis(points.map(function (p) { return p.value; }), spec.unit, 4);
  const span = axis.max - axis.min;
  const xFor = function (v) { return plotX + ((v - axis.min) / span) * plotW; };
  const zeroX = xFor(0);
  const plotRight = plotX + plotW;

  const body = [];

  // Gridlines sit behind the bars and carry the tick values.
  const gridBottom = points.length * rowH + (points.length - 1) * gap;
  const tickY = gridBottom + FS_TICK + 6;
  axis.ticks.forEach(function (t) {
    const x = xFor(t);
    const text = formatTick(t, spec.unit);
    body.push(svgLine(x, 0, x, gridBottom, t === 0 ? 'c-axis-zero' : 'c-grid'));
    body.push(svgText(x, tickY, text, {
      cls: 'c-tick', size: FS_TICK,
      anchor: tickAnchor(x, plotX, plotRight, text, FS_TICK),
    }));
  });

  points.forEach(function (p, i) {
    const y = i * (rowH + gap);
    const cy = y + rowH / 2;

    const lab = truncateToWidth(p.label, FS_LABEL, labelW - 16);
    if (lab.truncated) { warnings.push('label truncated: ' + p.label); }
    body.push(svgText(labelW, cy, lab.text, {
      cls: 'c-label', size: FS_LABEL, anchor: 'end', baseline: 'middle',
      weight: p.emphasis ? '700' : '500',
    }));

    const vx = xFor(p.value);
    const barX = Math.min(zeroX, vx);
    const barW = Math.abs(vx - zeroX);
    const barH = Math.round(rowH * 0.62);
    const barY = cy - barH / 2;
    body.push(svgRect(barX, barY, barW, barH, p.emphasis ? 'c-bar c-bar-key' : 'c-bar', 6));

    // With a reserved value column the label fits outside the tip in every
    // normal case; the inset fallback survives only for negative bars long
    // enough to reach the left edge.
    const valText = formatValue(p.value, spec.unit);
    const valW = textWidth(valText, FS_VALUE);
    const outside = p.value >= 0
      ? (vx + 14 + valW <= width)
      : (barX - 14 - valW >= 0);

    if (outside) {
      body.push(svgText(p.value >= 0 ? vx + 14 : barX - 14, cy, valText, {
        cls: 'c-value', size: FS_VALUE, weight: '700', baseline: 'middle',
        anchor: p.value >= 0 ? 'start' : 'end',
      }));
    } else {
      body.push(svgText(p.value >= 0 ? vx - 14 : barX + 14, cy, valText, {
        cls: 'c-value c-value-inset', size: FS_VALUE, weight: '700', baseline: 'middle',
        anchor: p.value >= 0 ? 'end' : 'start',
      }));
    }
  });

  // The unit caption sits under the label column, which is empty at this row -
  // putting it at the right edge collided with the last tick value.
  if (axis.unitLabel) {
    body.push(svgText(labelW, tickY, axis.unitLabel, {
      cls: 'c-axis-unit', size: FS_TICK, anchor: 'end',
    }));
  }

  return wrapSvg(body.join(''), spec, { width: width, height: height }, {
    kind: 'bar',
    source: src,
    pointCount: points.length,
    warnings: warnings,
    aria: 'Bar chart, ' + axis.unitLabel + ': ' + points.map(function (p) {
      return p.label + ' ' + formatValue(p.value, spec.unit);
    }).join('; '),
  });
}

/**
 * Grouped horizontal bars - two or three series compared across categories.
 * This is what a "comparison" claim becomes when it has more than one dimension.
 */
function renderGroupedBar(spec, opts) {
  const o = opts || {};
  const checked = validateChartSpec(spec);
  const points = checked.points;
  const width = o.width || DEFAULT_WIDTH;
  const names = spec.series_names || spec.seriesNames;
  const seriesCount = points[0].values.length;

  const src = sourceLine(spec);
  const warnings = [];

  const barH = seriesCount >= 3 ? 40 : 48;
  const innerGap = 8;
  const groupH = seriesCount * barH + (seriesCount - 1) * innerGap;
  const groupGap = 34;
  const legendH = FS_LEGEND + 26;
  const axisCaptionH = FS_TICK + 14;

  const height = o.height
    || (legendH + points.length * groupH + (points.length - 1) * groupGap + axisCaptionH + sourceBlockHeight(src) + 12);

  const labelW = labelColumnWidth(points, width, FS_LABEL);
  const plotX = labelW + 20;
  const allValueTexts = [];
  points.forEach(function (p) {
    p.values.forEach(function (v) { allValueTexts.push(formatValue(v, spec.unit)); });
  });
  const valueW = valueColumnWidth(allValueTexts, FS_LABEL);
  const plotW = width - plotX - valueW;

  const allValues = [];
  points.forEach(function (p) { p.values.forEach(function (v) { allValues.push(v); }); });
  const axis = buildAxis(allValues, spec.unit, 4);
  const span = axis.max - axis.min;
  const xFor = function (v) { return plotX + ((v - axis.min) / span) * plotW; };
  const zeroX = xFor(0);
  const plotRight = plotX + plotW;

  const body = [];

  // Legend first: with more than one series, an unlabelled colour is unreadable.
  let lx = plotX;
  names.forEach(function (name, si) {
    body.push(svgRect(lx, 4, 26, 26, 'c-swatch c-series-' + (si + 1), 4));
    const text = String(name);
    body.push(svgText(lx + 36, 17, text, {
      cls: 'c-legend', size: FS_LEGEND, baseline: 'middle',
    }));
    lx += 36 + textWidth(text, FS_LEGEND) + 34;
  });
  if (lx > width) { warnings.push('legend is wider than the chart; shorten series_names'); }

  const top = legendH;
  const gridBottom = top + points.length * groupH + (points.length - 1) * groupGap;
  const tickY = gridBottom + FS_TICK + 6;

  axis.ticks.forEach(function (t) {
    const x = xFor(t);
    const text = formatTick(t, spec.unit);
    body.push(svgLine(x, top, x, gridBottom, t === 0 ? 'c-axis-zero' : 'c-grid'));
    body.push(svgText(x, tickY, text, {
      cls: 'c-tick', size: FS_TICK,
      anchor: tickAnchor(x, plotX, plotRight, text, FS_TICK),
    }));
  });

  points.forEach(function (p, i) {
    const gy = top + i * (groupH + groupGap);

    const lab = truncateToWidth(p.label, FS_LABEL, labelW - 16);
    if (lab.truncated) { warnings.push('label truncated: ' + p.label); }
    body.push(svgText(labelW, gy + groupH / 2, lab.text, {
      cls: 'c-label', size: FS_LABEL, anchor: 'end', baseline: 'middle',
      weight: p.emphasis ? '700' : '500',
    }));

    p.values.forEach(function (v, si) {
      const y = gy + si * (barH + innerGap);
      const vx = xFor(v);
      const barX = Math.min(zeroX, vx);
      body.push(svgRect(barX, y, Math.abs(vx - zeroX), barH, 'c-bar c-series-' + (si + 1), 5));

      const valText = formatValue(v, spec.unit);
      const valW = textWidth(valText, FS_LABEL);
      const outside = v >= 0 ? (vx + 12 + valW <= width) : (barX - 12 - valW >= 0);
      body.push(svgText(
        outside ? (v >= 0 ? vx + 12 : barX - 12) : (v >= 0 ? vx - 12 : barX + 12),
        y + barH / 2, valText,
        {
          cls: outside ? 'c-value-sm' : 'c-value-sm c-value-inset',
          size: FS_LABEL, weight: '700', baseline: 'middle',
          anchor: (outside === (v >= 0)) ? 'start' : 'end',
        }
      ));
    });
  });

  if (axis.unitLabel) {
    body.push(svgText(labelW, tickY, axis.unitLabel, {
      cls: 'c-axis-unit', size: FS_TICK, anchor: 'end',
    }));
  }

  return wrapSvg(body.join(''), spec, { width: width, height: height }, {
    kind: 'grouped-bar',
    source: src,
    pointCount: points.length,
    warnings: warnings,
    aria: 'Grouped bar chart comparing ' + names.join(' and ') + ' in ' + axis.unitLabel,
  });
}

/* --------------------------------------------------------------- line / trend */

/* Tick labels on a horizontal axis collide long before they overlap visually,
 * so only every nth is printed once they would touch. Dropping labels is safer
 * than rotating them: rotated text at phone size is the legibility failure this
 * module exists to avoid. */
function tickStride(points, plotW, fontSize) {
  const widest = points.reduce(function (acc, p) {
    return Math.max(acc, textWidth(p.label, fontSize));
  }, 0);
  const perLabel = widest + 20;
  const fit = Math.max(1, Math.floor(plotW / perLabel));
  return Math.max(1, Math.ceil(points.length / fit));
}

/**
 * Line chart - a trend over three or more ordered points.
 *
 * Requires 3 points by contract: two points make a segment, and calling a
 * segment a "trend" overstates what the data shows. Two-point movement belongs
 * in `progression`, which is honest about being a before/after.
 */
function renderLine(spec, opts) {
  const o = opts || {};
  const checked = validateChartSpec(spec);
  const points = checked.points;
  const width = o.width || DEFAULT_WIDTH;

  const src = sourceLine(spec);
  const warnings = [];

  const axis = buildAxis(points.map(function (p) { return p.value; }), spec.unit, 5);
  const tickW = points.reduce(function (acc, t) {
    return Math.max(acc, textWidth(formatTick(t, spec.unit), FS_TICK));
  }, textWidth(formatTick(axis.max, spec.unit), FS_TICK));

  const padLeft = Math.max(90, tickW + 24);
  const padRight = 24;
  /* Two separate allowances above the plot: a row for the unit caption, then
   * headroom for the end-point callout. Sharing one row put the caption level
   * with the topmost tick value and with the first point's label, so three
   * strings competed for the same line. */
  const unitRowH = axis.unitLabel ? FS_LABEL + 14 : 0;
  const padTop = unitRowH + FS_VALUE + 26;
  const xLabelH = FS_LABEL + 16;
  const height = o.height || (padTop + 340 + xLabelH + sourceBlockHeight(src) + 8);
  const plotBottom = height - sourceBlockHeight(src) - xLabelH - 8;
  const plotH = plotBottom - padTop;
  const plotW = width - padLeft - padRight;

  const span = axis.max - axis.min;
  const yFor = function (v) { return plotBottom - ((v - axis.min) / span) * plotH; };
  const xFor = function (i) {
    return points.length === 1
      ? padLeft + plotW / 2
      : padLeft + (i / (points.length - 1)) * plotW;
  };

  const body = [];

  axis.ticks.forEach(function (t) {
    const y = yFor(t);
    body.push(svgLine(padLeft, y, width - padRight, y, t === 0 ? 'c-axis-zero' : 'c-grid'));
    body.push(svgText(padLeft - 16, y, formatTick(t, spec.unit), {
      cls: 'c-tick', size: FS_TICK, anchor: 'end', baseline: 'middle',
    }));
  });

  if (axis.unitLabel) {
    // Its own row at the very top, above the callout headroom.
    body.push(svgText(padLeft - 16, FS_LABEL, axis.unitLabel, {
      cls: 'c-axis-unit', size: FS_LABEL, anchor: 'start',
    }));
  }

  // Area fill under the line reads as magnitude and only makes sense when the
  // whole series sits on one side of zero.
  if (!axis.includesNegative) {
    const areaPts = points.map(function (p, i) { return n2(xFor(i)) + ' ' + n2(yFor(p.value)); });
    body.push(svgPath(
      'M ' + n2(xFor(0)) + ' ' + n2(yFor(axis.min))
      + ' L ' + areaPts.join(' L ')
      + ' L ' + n2(xFor(points.length - 1)) + ' ' + n2(yFor(axis.min)) + ' Z',
      'c-area'
    ));
  }

  body.push(svgPath(
    'M ' + points.map(function (p, i) { return n2(xFor(i)) + ' ' + n2(yFor(p.value)); }).join(' L '),
    'c-line'
  ));

  const stride = tickStride(points, plotW, FS_LABEL);
  if (stride > 1) { warnings.push('x labels thinned to every ' + stride + ' points to stay legible'); }

  points.forEach(function (p, i) {
    const x = xFor(i);
    const y = yFor(p.value);
    const isLast = i === points.length - 1;
    const isFirst = i === 0;
    body.push(svgCircle(x, y, (isLast || p.emphasis) ? 11 : 7,
      (isLast || p.emphasis) ? 'c-dot c-dot-key' : 'c-dot'));

    // First and last are always labelled - they are the endpoints of the claim.
    if (isFirst || isLast || i % stride === 0) {
      body.push(svgText(x, plotBottom + FS_LABEL + 8, p.label, {
        cls: 'c-label', size: FS_LABEL,
        anchor: isFirst ? 'start' : (isLast ? 'end' : 'middle'),
      }));
    }

    if (isLast || isFirst || p.emphasis) {
      // The first label is nudged clear of the value axis: anchored flush to the
      // plot edge it sat one gridline away from a y tick, and the two read as
      // one collided string.
      body.push(svgText(isFirst ? x + 16 : x, y - 22, formatValue(p.value, spec.unit), {
        cls: 'c-value', size: isLast ? FS_VALUE : FS_LABEL, weight: '700',
        anchor: isFirst ? 'start' : (isLast ? 'end' : 'middle'),
      }));
    }
  });

  return wrapSvg(body.join(''), spec, { width: width, height: height }, {
    kind: 'line',
    source: src,
    pointCount: points.length,
    warnings: warnings,
    aria: 'Line chart in ' + axis.unitLabel + ' from ' + points[0].label + ' '
      + formatValue(points[0].value, spec.unit) + ' to ' + points[points.length - 1].label
      + ' ' + formatValue(points[points.length - 1].value, spec.unit),
  });
}

/* ----------------------------------------------------------------- progression */

/**
 * Progression - the honest two-to-six point before/after.
 *
 * This is the form most legacy findings collapse into ("grew from $12M in April
 * to $83M in August"), and it is deliberately NOT a line chart: it states the
 * endpoints as figures with the change between them computed once, rather than
 * implying continuous movement the data never measured.
 */
function renderProgression(spec, opts) {
  const o = opts || {};
  const checked = validateChartSpec(spec);
  const points = checked.points;
  const width = o.width || DEFAULT_WIDTH;

  const src = sourceLine(spec);
  const warnings = [];

  const first = points[0];
  const last = points[points.length - 1];

  const axis = buildAxis(points.map(function (p) { return p.value; }), spec.unit, 4);
  const span = axis.max - axis.min;

  const colGap = 28;
  const colW = (width - colGap * (points.length - 1)) / points.length;
  const capH = FS_LABEL + FS_VALUE + 26;
  const deltaH = FS_LABEL + 22;
  const height = o.height || (deltaH + 300 + capH + sourceBlockHeight(src) + 8);
  const baseline = height - sourceBlockHeight(src) - capH - 8;
  const colTop = deltaH + 8;
  const maxColH = baseline - colTop;

  const body = [];
  body.push(svgLine(0, baseline, width, baseline, 'c-axis-zero'));

  points.forEach(function (p, i) {
    const x = i * (colW + colGap);
    const h = span > 0 ? ((p.value - axis.min) / span) * maxColH : 0;
    const y = baseline - h;
    const isEnd = i === points.length - 1;
    body.push(svgRect(x, y, colW, h, isEnd ? 'c-bar c-bar-key' : 'c-bar', 8));

    body.push(svgText(x + colW / 2, y - 16, formatValue(p.value, spec.unit), {
      cls: 'c-value', size: FS_VALUE, weight: '700', anchor: 'middle',
    }));

    const lab = truncateToWidth(p.label, FS_LABEL, colW - 8);
    if (lab.truncated) { warnings.push('label truncated: ' + p.label); }
    body.push(svgText(x + colW / 2, baseline + FS_LABEL + 12, lab.text, {
      cls: 'c-label', size: FS_LABEL, anchor: 'middle',
    }));
  });

  /* The change is stated once, as a figure, rather than left to be eyeballed.
   * Percentage change is meaningless across zero and undefined from zero, so
   * those cases fall back to an absolute delta instead of printing nonsense. */
  const delta = last.value - first.value;
  let changeText;
  if (first.value === 0 || (first.value < 0) !== (last.value < 0)) {
    changeText = (delta >= 0 ? '+' : '\u2212') + formatValue(Math.abs(delta), spec.unit) + ' change';
  } else if (spec.unit === 'percent' || spec.unit === 'percentage_point') {
    // Percent-of-a-percent is a classic misreading; state percentage points.
    changeText = (delta >= 0 ? '+' : '\u2212') + formatNumber(Math.abs(delta), spec.unit) + ' pp';
  } else {
    const pct = (delta / Math.abs(first.value)) * 100;
    const mult = last.value / first.value;
    changeText = (mult >= 2)
      ? formatNumber(mult, 'multiple') + 'x ' + (delta >= 0 ? 'increase' : 'decrease')
      : (pct >= 0 ? '+' : '\u2212') + formatNumber(Math.abs(pct), 'percent') + '%';
  }

  body.push(svgText(0, FS_LABEL, changeText, {
    cls: 'c-delta', size: FS_LABEL, weight: '700', anchor: 'start',
  }));
  if (axis.unitLabel) {
    body.push(svgText(width, FS_LABEL, axis.unitLabel, {
      cls: 'c-axis-unit', size: FS_TICK, anchor: 'end',
    }));
  }

  return wrapSvg(body.join(''), spec, { width: width, height: height }, {
    kind: 'progression',
    source: src,
    pointCount: points.length,
    warnings: warnings,
    aria: 'Progression in ' + axis.unitLabel + ' from ' + first.label + ' '
      + formatValue(first.value, spec.unit) + ' to ' + last.label + ' '
      + formatValue(last.value, spec.unit) + ', ' + changeText,
  });
}

/* ---------------------------------------------------------------------- share */

/**
 * Share - parts of a whole, drawn as a single stacked bar rather than a pie.
 *
 * Pie and donut charts are excluded on purpose: angle and area are read far less
 * accurately than length, small slices become unlabellable, and a donut's hole
 * invites a decorative number in the middle that is not part of the data. A
 * stacked bar with a labelled legend states the same thing and stays readable
 * when one share is 3%.
 *
 * The percentages shown are computed from the supplied values, so they always
 * sum to the whole - a caller cannot ship a chart whose slices add to 108%.
 */
function renderShare(spec, opts) {
  const o = opts || {};
  const checked = validateChartSpec(spec);
  const points = checked.points;
  const width = o.width || DEFAULT_WIDTH;

  const src = sourceLine(spec);
  const warnings = [];

  const total = points.reduce(function (a, p) { return a + p.value; }, 0);
  /* When the unit is already a percentage, the value and its share of the total
   * are the same number, and printing both produced a legend reading "92% 92%".
   * The share column is what this chart is about, so the absolute column is
   * dropped in that case rather than duplicated. */
  const showAbsolute = spec.unit !== 'percent';
  const barH = 96;
  const rowH = FS_LABEL + 22;
  const legendH = points.length * rowH;
  const height = o.height || (barH + 28 + legendH + sourceBlockHeight(src) + 8);

  const body = [];

  // Segments. Sub-pixel rounding is absorbed by the last segment so the bar is
  // exactly full - a 2px gap at the end would read as a missing share.
  let x = 0;
  const widths = points.map(function (p) { return (p.value / total) * width; });
  points.forEach(function (p, i) {
    const w = (i === points.length - 1) ? (width - x) : widths[i];
    body.push(svgRect(x, 0, w, barH, 'c-share-seg c-series-' + (i + 1), i === 0 || i === points.length - 1 ? 6 : 0));

    const pct = (p.value / total) * 100;
    const pctText = formatNumber(pct, 'percent') + '%';
    /* Only label in place when the segment holds the text with real margin.
     * A number crammed into a narrow band reads as a rendering artefact, and the
     * legend below lists every share anyway - which is why the legend is not
     * optional on this chart. */
    if (textWidth(pctText, FS_LABEL) + 44 <= w) {
      body.push(svgText(x + w / 2, barH / 2, pctText, {
        cls: 'c-share-pct', size: FS_LABEL, weight: '700', anchor: 'middle', baseline: 'middle',
      }));
    } else {
      warnings.push('share "' + p.label + '" (' + pctText + ') is too narrow to label in place; shown in the legend only');
    }
    x += w;
  });

  // Legend doubles as the value table: swatch, label, share, and the absolute
  // figure when it says something the share does not.
  points.forEach(function (p, i) {
    const y = barH + 28 + i * rowH;
    body.push(svgRect(0, y + 4, 24, 24, 'c-swatch c-series-' + (i + 1), 4));

    const pct = formatNumber((p.value / total) * 100, 'percent') + '%';
    const valText = showAbsolute ? formatValue(p.value, spec.unit) : '';
    const rightW = textWidth(pct, FS_LABEL) + textWidth(valText, FS_LABEL) + 60;
    const lab = truncateToWidth(p.label, FS_LABEL, width - 34 - rightW);
    if (lab.truncated) { warnings.push('label truncated: ' + p.label); }

    body.push(svgText(34, y + 16, lab.text, { cls: 'c-label', size: FS_LABEL, baseline: 'middle' }));
    if (showAbsolute) {
      body.push(svgText(width - textWidth(valText, FS_LABEL) - 24, y + 16, pct, {
        cls: 'c-value-sm', size: FS_LABEL, weight: '700', anchor: 'end', baseline: 'middle',
      }));
      body.push(svgText(width, y + 16, valText, {
        cls: 'c-tick', size: FS_LABEL, anchor: 'end', baseline: 'middle',
      }));
    } else {
      body.push(svgText(width, y + 16, pct, {
        cls: 'c-value-sm', size: FS_LABEL, weight: '700', anchor: 'end', baseline: 'middle',
      }));
    }
  });

  return wrapSvg(body.join(''), spec, { width: width, height: height }, {
    kind: 'share',
    source: src,
    pointCount: points.length,
    warnings: warnings,
    aria: 'Share of total in ' + axisUnitLabel(spec.unit) + ': ' + points.map(function (p) {
      return p.label + ' ' + formatNumber((p.value / total) * 100, 'percent') + '%';
    }).join('; '),
  });
}

/* -------------------------------------------------------------- timeline-scaled */

/* Parse a YYYY, YYYY-MM or YYYY-MM-DD date into a sortable number of days.
 * Deliberately not `new Date()`: parsing "2026-03" with the Date constructor is
 * implementation-defined, and a bare "2026" would be read as a millisecond
 * epoch by some engines. */
function dateToDays(iso) {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(String(iso || '').trim());
  if (!m) { return null; }
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 1;
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) { return null; }
  return Date.UTC(y, mo - 1, d) / 86400000;
}

/* Resolve horizontal overlaps among label boxes that all want to sit centred on
 * their own data point.
 *
 * Boxes are nudged sideways, never shrunk, and the dot stays where the date puts
 * it - a leader line reconnects the two. That ordering matters: shrinking the
 * type to dodge a collision is what makes a chart unreadable at phone scale, and
 * moving the DOT would falsify the timing the chart exists to show.
 *
 * Two passes: left-to-right pushing overlaps rightwards, then right-to-left to
 * pull anything that ran past the right edge back in. A single pass leaves the
 * last box hanging outside the canvas.
 */
function resolveLabelBoxes(centres, widths, minX, maxX, gap) {
  const g = gap === undefined ? 16 : gap;
  const boxes = centres.map(function (cx, i) {
    return { index: i, width: widths[i], left: cx - widths[i] / 2 };
  }).sort(function (a, b) { return a.left - b.left; });

  boxes.forEach(function (b, i) {
    const floor = i === 0 ? minX : boxes[i - 1].left + boxes[i - 1].width + g;
    if (b.left < floor) { b.left = floor; }
  });

  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    const ceiling = (i === boxes.length - 1)
      ? maxX - b.width
      : boxes[i + 1].left - g - b.width;
    if (b.left > ceiling) { b.left = ceiling; }
    if (b.left < minX) { b.left = minX; }
  }

  const out = [];
  let collided = false;
  boxes.forEach(function (b) {
    out[b.index] = b.left + b.width / 2;
    if (Math.abs(out[b.index] - centres[b.index]) > 1) { collided = true; }
  });
  return { centres: out, adjusted: collided };
}

/**
 * Timeline with TRUE proportional spacing.
 *
 * The existing `timeline` frame lists events at equal intervals, which
 * misrepresents pace: "March, April, November" drawn evenly implies steady
 * progress when the real story is a gap. Here the axis is time, so a six-month
 * gap looks like a six-month gap. That is also why every point must carry a
 * parseable date - without one the spacing would be invented, so the chart is
 * refused rather than faked.
 *
 * Labels alternate above and below the axis and are wrapped to two lines, then
 * shifted sideways where they would collide, with an elbow leader back to the
 * dot. The first version centred each label on its dot and let them overlap;
 * with events one month apart in a six-month span that made the two longest
 * labels mutually illegible, which is the whole content of the slide.
 */
function renderTimelineScaled(spec, opts) {
  const o = opts || {};
  const checked = validateChartSpec(spec);
  const points = checked.points;
  const width = o.width || DEFAULT_WIDTH;

  const src = sourceLine(spec);
  const warnings = [];

  const dated = points.map(function (p) {
    const days = dateToDays(p.date);
    if (days === null) {
      throw validationError(
        'chart.series point "' + p.label + '" has date ' + JSON.stringify(p.date)
        + ' which is not YYYY, YYYY-MM or YYYY-MM-DD'
      );
    }
    return { label: p.label, note: p.note, days: days, date: String(p.date), emphasis: p.emphasis };
  }).sort(function (a, b) { return a.days - b.days; });

  const minDays = dated[0].days;
  const maxDays = dated[dated.length - 1].days;
  const spanDays = maxDays - minDays;
  if (spanDays <= 0) {
    throw validationError('timeline-scaled needs points on at least two different dates');
  }

  const STEM = 24;
  const LINE_H = Math.round(FS_LABEL * 1.18);
  const MAX_LINES = 2;
  const spanRowH = FS_TICK + 16;

  // Label width budget: each lane holds at most half the events, so a lane with
  // three of them gets a third of the width each.
  const perLane = Math.ceil(dated.length / 2);
  const labelBudget = Math.max(200, Math.floor((width - (perLane - 1) * 16) / perLane));

  const prepared = dated.map(function (p) {
    const wrapped = wrapToWidth(p.label, FS_LABEL, labelBudget, MAX_LINES);
    if (wrapped.truncated) { warnings.push('event label truncated: ' + p.label); }
    const boxW = wrapped.lines.reduce(function (acc, l) {
      return Math.max(acc, textWidth(l, FS_LABEL));
    }, textWidth(p.date, FS_TICK));
    return { point: p, lines: wrapped.lines, boxW: boxW };
  });

  const maxLines = prepared.reduce(function (acc, p) { return Math.max(acc, p.lines.length); }, 1);
  const laneH = STEM + 12 + FS_TICK + 8 + maxLines * LINE_H;
  const axisY = spanRowH + laneH;
  const height = o.height || (axisY + laneH + sourceBlockHeight(src) + 10);

  // Inset so a first or last label centred on its dot still fits inside the box.
  const inset = Math.min(120, Math.round(labelBudget / 2));
  const plotW = width - inset * 2;
  const xFor = function (days) { return inset + ((days - minDays) / spanDays) * plotW; };

  // Lanes resolved independently: an above-label and a below-label may share the
  // same x without colliding.
  const above = [];
  const below = [];
  prepared.forEach(function (p, i) { (i % 2 === 0 ? above : below).push(i); });

  const labelCx = [];
  [above, below].forEach(function (lane) {
    if (lane.length === 0) { return; }
    const centres = lane.map(function (i) { return xFor(prepared[i].point.days); });
    const widths = lane.map(function (i) { return prepared[i].boxW; });
    const resolved = resolveLabelBoxes(centres, widths, 0, width, 18);
    lane.forEach(function (idx, k) { labelCx[idx] = resolved.centres[k]; });
  });

  const body = [];
  body.push(svgLine(0, axisY, width, axisY, 'c-axis-time'));

  prepared.forEach(function (prep, i) {
    const p = prep.point;
    const dotX = xFor(p.days);
    const cx = labelCx[i];
    const isAbove = i % 2 === 0;
    const dir = isAbove ? -1 : 1;
    const railY = axisY + dir * STEM;

    // Elbow leader: straight down from the dot to the rail, then across to the
    // label. When nothing moved, the horizontal leg has zero length and this is
    // just a tick.
    body.push(svgLine(dotX, axisY, dotX, railY, 'c-tick-line'));
    if (Math.abs(cx - dotX) > 1) {
      body.push(svgLine(dotX, railY, cx, railY, 'c-tick-line'));
    }

    body.push(svgCircle(dotX, axisY, p.emphasis ? 12 : 9, p.emphasis ? 'c-dot c-dot-key' : 'c-dot'));

    const dateY = isAbove ? railY - 12 : railY + 12 + FS_TICK;
    body.push(svgText(cx, dateY, p.date, { cls: 'c-tick', size: FS_TICK, anchor: 'middle' }));

    prep.lines.forEach(function (line, li) {
      // Above the axis the block grows upward, so lines are laid out from the
      // last one back to the first to keep reading order top-to-bottom.
      const y = isAbove
        ? dateY - FS_TICK - 8 - (prep.lines.length - 1 - li) * LINE_H
        : dateY + 8 + (li + 1) * LINE_H;
      body.push(svgText(cx, y, line, {
        cls: 'c-label', size: FS_LABEL, anchor: 'middle',
        weight: p.emphasis ? '700' : '500',
      }));
    });
  });

  const monthsSpan = spanDays / 30.44;
  const spanText = monthsSpan >= 24
    ? formatNumber(monthsSpan / 12, 'multiple') + ' years'
    : (monthsSpan >= 2 ? Math.round(monthsSpan) + ' months' : Math.round(spanDays) + ' days');
  // Its own row at the top of the figure, clear of the upper label lane.
  body.push(svgText(width, FS_TICK, spanText + ' total', {
    cls: 'c-axis-unit', size: FS_TICK, anchor: 'end',
  }));

  return wrapSvg(body.join(''), spec, { width: width, height: height }, {
    kind: 'timeline-scaled',
    source: src,
    pointCount: dated.length,
    warnings: warnings,
    aria: 'Timeline over ' + spanText + ': ' + dated.map(function (p) {
      return p.date + ' ' + p.label;
    }).join('; '),
  });
}

/* --------------------------------------------------------------------- facade */

const RENDERERS = {
  'bar': renderBar,
  'grouped-bar': renderGroupedBar,
  'line': renderLine,
  'progression': renderProgression,
  'share': renderShare,
  'timeline-scaled': renderTimelineScaled,
};

/**
 * Render any supported chart kind. This is the only entry point templates and
 * the planner should use.
 */
function renderChart(spec, opts) {
  if (!spec || typeof spec !== 'object') {
    throw validationError('chart spec must be an object');
  }
  const kind = String(spec.kind || '').trim();
  const fn = RENDERERS[kind];
  if (!fn) {
    throw validationError('chart.kind "' + kind + '" is not supported. Supported: ' + CHART_KINDS.join(', '));
  }
  return fn(spec, opts);
}

/**
 * Decide whether a claim can honestly become a chart, and which kind.
 *
 * Returns null rather than throwing, because "this claim has no chart in it" is
 * the normal case, not an error - most claims are prose and belong in
 * typography. The visual planner uses this to avoid asking for charts that would
 * then be refused.
 */
function suggestChartKind(claim) {
  if (!claim || !Array.isArray(claim.series)) { return null; }
  const points = normalisePoints(claim.series);
  if (points.length < 2) { return null; }
  if (!claim.unit) { return null; }
  if (points.some(function (p) { return !isFinite(p.value) || !p.label; })) { return null; }

  const grouped = points.every(function (p) { return p.values && p.values.length >= 2; });
  if (grouped) { return 'grouped-bar'; }

  const allDated = points.every(function (p) { return dateToDays(p.date) !== null; });
  if (allDated) {
    const days = points.map(function (p) { return dateToDays(p.date); });
    const gaps = [];
    for (let i = 1; i < days.length; i++) { gaps.push(days[i] - days[i - 1]); }
    const maxGap = Math.max.apply(null, gaps);
    const minGap = Math.min.apply(null, gaps);
    // Uneven spacing is the whole reason timeline-scaled exists; even spacing is
    // better served by a line, which reads as a trend.
    if (points.length >= 3 && maxGap > minGap * 1.6) { return 'timeline-scaled'; }
    if (points.length >= 3) { return 'line'; }
    return 'progression';
  }

  if (claim.claim_type === 'comparison') { return 'bar'; }
  if (points.length >= 3) { return 'bar'; }
  return 'progression';
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  esc,
  textWidth,
  truncateToWidth,
  wrapToWidth,
  resolveLabelBoxes,
  formatValue,
  formatNumber,
  formatTick,
  axisUnitLabel,
  niceStep,
  buildAxis,
  dateToDays,
  normalisePoints,
  validateChartSpec,
  sourceLine,
  renderBar,
  renderGroupedBar,
  renderLine,
  renderProgression,
  renderShare,
  renderTimelineScaled,
  renderChart,
  suggestChartKind,
  sortPoints,
  SORT_MODES,
  CHART_KINDS,
};
