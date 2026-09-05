'use strict';

/* Slide preparation - everything that must be computed BEFORE a template runs.
 *
 * WHY THIS IS NOT IN THE TEMPLATES: Nunjucks can iterate and interpolate, but it
 * cannot do arithmetic honestly. Proportional timeline gaps need real date
 * differencing; metric emphasis needs to know which figure is the largest;
 * attribution needs URL-to-publication-name resolution. Attempting any of that
 * in a template ends in either silently wrong output or logic smeared across
 * twelve files that then drift apart - which is exactly how the original frames
 * ended up sharing one skeleton while each reimplementing its own type scale.
 *
 * Everything here is pure and synchronous. Given the same slide it returns the
 * same view model, so it can be unit-tested without a browser.
 */

const {
  buildAttribution,
  sourceNameFromUrl,
  FRAME_LAYOUTS,
  validationError,
} = require('./contracts');

/* ------------------------------------------------------------------ helpers */

function str(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/* Collect sources from any of the shapes callers actually send. Legacy slides use
 * `source` or `credit` as a bare string; the planner sends `sources` arrays;
 * per-item attribution appears inside stats/bullets/events. Accepting all of them
 * is deliberate - the alternative is a slide silently publishing unattributed
 * because the field name did not match. */
function collectSources(slide) {
  const out = [];
  const push = function (v) {
    if (v === null || v === undefined || v === '') { return; }
    if (Array.isArray(v)) { v.forEach(push); return; }
    out.push(v);
  };

  push(slide.sources);
  push(slide.source);
  push(slide.credit);

  // `sources` as a comma-joined string is what the old outro frame sent.
  return out.reduce(function (acc, s) {
    if (typeof s === 'string' && s.indexOf(',') !== -1 && !/^https?:/i.test(s)) {
      s.split(',').forEach(function (part) {
        const t = part.trim();
        if (t) { acc.push(t); }
      });
    } else {
      acc.push(s);
    }
    return acc;
  }, []);
}

/**
 * Build the slide-level attribution view model.
 *
 * Returns `complete: false` when nothing was supplied, and the template prints a
 * visible placeholder rather than an empty line. A missing source has to be
 * visible to a human reviewer; a blank space is indistinguishable from a slide
 * that legitimately needs no citation.
 */
function prepareAttribution(slide) {
  const attribution = buildAttribution(collectSources(slide), slide.as_of || slide.asOf);
  if (attribution.complete || attribution.text) {
    return attribution;
  }
  return { text: 'Source not stated', names: [], complete: false };
}

/* Per-item attribution, used by metric cards and evidence rows. Falls back to
 * nothing (not to the slide's sources) so a card cannot inherit a citation that
 * does not actually support its number. */
function itemSource(item) {
  const raw = item && (item.source || item.sources || item.source_name || item.source_url);
  if (!raw) { return ''; }
  const a = buildAttribution(raw, null);
  return a.names.length ? a.names.join(', ') : '';
}

/* ---------------------------------------------------------------- metrics */

/* Length of the printable value, used to drive the CSS type scale. Grouping
 * commas and currency symbols are counted because they occupy width, but a
 * trailing unit is not - that is set separately and must not shrink the figure. */
function valueLength(value) {
  return str(value).length;
}

/**
 * Prepare metric cards.
 *
 * THE DEFECT THIS FIXES: the old stat-grid gave "3,400" and "40" identical
 * visual weight, so a slide with a headline figure and three supporting ones read
 * as four equal facts. Here one card is marked the lead and is set structurally
 * larger.
 *
 * Which card leads is an EDITORIAL decision, so an explicit `lead: true` always
 * wins. Only when the caller expresses no preference does it fall back to first
 * position - deliberately not "the largest number", because the biggest figure is
 * frequently the least interesting one on the slide.
 */
function prepareMetrics(stats) {
  const list = Array.isArray(stats) ? stats : [];
  const explicit = list.findIndex(function (s) { return s && (s.lead === true || s.emphasis === true); });
  const leadIndex = explicit === -1 ? 0 : explicit;

  return list.map(function (s, i) {
    const item = s || {};
    return {
      value: str(item.value),
      value_len: valueLength(item.value),
      unit: str(item.unit),
      label: str(item.label),
      source: itemSource(item),
      is_lead: i === leadIndex && list.length > 1,
    };
  });
}

/* ---------------------------------------------------------------- evidence */

/**
 * Prepare evidence rows. Accepts plain strings (the legacy bullet shape) and
 * objects with a figure, a source and a tier.
 *
 * `weak` marks a claim resting only on a tier-4 source. It is surfaced ON THE
 * SLIDE rather than filtered out: dropping it loses real reporting, but printing
 * it unmarked beside a Reuters figure implies equal standing.
 */
function prepareEvidence(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map(function (raw) {
    if (typeof raw === 'string') {
      return { text: raw.trim(), figure: '', source: '', weak: false };
    }
    const item = raw || {};
    const tier = Number(item.source_tier || item.tier);
    return {
      text: str(item.text || item.claim),
      figure: str(item.figure || item.value),
      source: itemSource(item),
      weak: item.weakly_sourced === true || tier === 4,
    };
  }).filter(function (e) { return e.text.length > 0 || e.figure.length > 0; });
}

/* ---------------------------------------------------------------- timeline */

/* Parse YYYY, YYYY-MM, YYYY-MM-DD, or "March 2026" into days. Prose months are
 * accepted here but not in charts.js, because this frame's legacy callers send
 * `date: "March 2026"` and refusing them would break existing workflows. */
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function eventDateToDays(value) {
  const s = str(value);
  if (!s) { return null; }

  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(s);
  if (iso) {
    const mo = iso[2] ? Number(iso[2]) : 1;
    const d = iso[3] ? Number(iso[3]) : 1;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) { return null; }
    return Date.UTC(Number(iso[1]), mo - 1, d) / 86400000;
  }

  const prose = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(s);
  if (prose) {
    const mo = MONTHS[prose[1].toLowerCase()];
    if (mo) { return Date.UTC(Number(prose[2]), mo - 1, 1) / 86400000; }
  }

  const bareYear = /^(\d{4})$/.exec(s);
  if (bareYear) { return Date.UTC(Number(bareYear[1]), 0, 1) / 86400000; }

  return null;
}

function humaniseGap(days) {
  const months = days / 30.44;
  if (months >= 22) {
    const years = months / 12;
    const r = Math.round(years * 10) / 10;
    return (r % 1 === 0 ? String(r) : r.toFixed(1)) + (r === 1 ? ' year' : ' years');
  }
  if (months >= 1.6) { return Math.round(months) + ' months'; }
  if (days >= 45) { return '1 month'; }
  if (days >= 1) { return Math.round(days) + (Math.round(days) === 1 ? ' day' : ' days'); }
  return '';
}

/**
 * Prepare a timeline with PROPORTIONAL spacing.
 *
 * The old frame listed events at equal intervals. That misrepresents pace: three
 * events in March and one in November drawn evenly implies steady progress when
 * the actual story is the gap. Here each connector's flex-grow is the real
 * elapsed time, so a six-month gap looks like a six-month gap.
 *
 * When any date fails to parse the whole timeline falls back to even spacing and
 * sets `proportional: false`, because a timeline that is proportional for some
 * gaps and arbitrary for others is worse than one that is honestly uniform.
 */
function prepareTimeline(events) {
  const list = Array.isArray(events) ? events : [];

  const prepared = list.map(function (raw) {
    const e = raw || {};
    return {
      date: str(e.date),
      text: str(e.text || e.label),
      source: itemSource(e),
      is_key: e.emphasis === true || e.key === true,
      days: eventDateToDays(e.date),
    };
  });

  const parsed = prepared.filter(function (e) { return e.days !== null; });
  const proportional = prepared.length >= 2 && parsed.length === prepared.length;

  // Gaps sit BETWEEN events, so there is one fewer of them than events.
  const gaps = [];
  if (!proportional) {
    for (let i = 1; i < prepared.length; i++) {
      gaps.push({ flex: 1, elapsed: '' });
    }
    return { events: prepared, gaps: gaps, proportional: false };
  }

  const raw = [];
  for (let i = 1; i < prepared.length; i++) {
    raw.push(Math.max(0, prepared[i].days - prepared[i - 1].days));
  }
  const largest = Math.max.apply(null, raw.concat([1]));

  raw.forEach(function (d) {
    /* TRUE proportion, with no floor. The first pass clamped short gaps to 0.35,
     * which turned a real 5:1 ratio into a rendered 2.9:1 and understated exactly
     * the pacing this layout exists to show. Visibility of a short connector is
     * handled instead by `min-height` on .tl-gap in layouts.css - a floor in
     * pixels, which cannot distort the ratio between the flexible parts. */
    gaps.push({
      flex: largest > 0 ? Math.round((d / largest) * 1000) / 1000 : 0,
      elapsed: humaniseGap(d),
    });
  });

  return { events: prepared, gaps: gaps, proportional: true };
}

/* ------------------------------------------------------------------- images */

/* Only data URIs are allowed: render.js blocks all network requests inside the
 * page, so an http(s) image would render as a broken box after a silent abort. */
function prepareImage(slide) {
  const data = str(slide.imageData);
  if (!data) {
    return { present: false, css: '', note: str(slide.imagePlaceholderNote) || 'Reference image not supplied' };
  }
  if (data.indexOf('data:image/') !== 0) {
    throw validationError('imageData must be a data URI starting with "data:image/" (network fetches are blocked)');
  }
  // Quotes and parens are the only characters that can break out of url(...).
  const safe = data.replace(/["'()\\]/g, '');
  return { present: true, css: 'url("' + safe + '")', note: '' };
}

/* ------------------------------------------------------------------ process */

/* Steps arrive either as plain strings or as { title, detail }. The last step is
 * flagged because it is the outcome of the process, which the layout marks. */
function prepareSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list.map(function (raw, i) {
    if (typeof raw === 'string' || typeof raw === 'number') {
      return { title: str(raw), detail: '', is_last: i === list.length - 1 };
    }
    const s = raw || {};
    return {
      title: str(s.title || s.text),
      detail: str(s.detail),
      is_last: i === list.length - 1,
    };
  });
}

/* --------------------------------------------------------------------- main */

/**
 * Build the complete view model for a slide. The template then only places
 * values - it makes no decisions.
 */
function prepareSlide(slide, type) {
  const s = slide || {};
  const view = {
    layout: FRAME_LAYOUTS[type] || 'editorial_hero',
    attribution: prepareAttribution(s),
    // Drives the headline type scale. Computed once here so every layout uses the
    // same measure instead of each template counting characters its own way.
    headline_len: str(s.headline || s.text).length,
    quote_len: str(s.quote).length,
    /* Some layouts carry their attribution somewhere better than the footer: the
     * chart bakes it into the SVG, the outro prints a full manifest. Printing the
     * footer line as well produced a slide that listed four sources and then said
     * "Source not stated" directly underneath. */
    suppress_meta_source: false,
  };

  if (type === 'stat') {
    // A single stat is a one-card metric grid, so both frames share one layout
    // and one type scale rather than drifting apart.
    view.metrics = prepareMetrics([{
      value: s.value, unit: s.unit, label: s.label || s.body, lead: true,
    }]);
    view.support = str(s.label && s.body ? s.body : '');
  }
  if (type === 'stat-grid') {
    view.metrics = prepareMetrics(s.stats);
    /* Per-card badges are only worth the space when the figures actually come from
     * different publications. With one shared source the footer states it once and
     * repeating it on every card is noise. */
    const distinct = {};
    view.metrics.forEach(function (m) { if (m.source) { distinct[m.source] = true; } });
    view.show_metric_sources = Object.keys(distinct).length > 1;
  }
  if (type === 'bullet-list') {
    view.evidence = prepareEvidence(s.bullets);
  }
  if (type === 'comparison') {
    /* On a comparison the two VALUES are the slide - "1x versus 4x" is the whole
     * argument. They were set at a fixed 96px, which in an 800px-tall panel left
     * the figure looking incidental and the panel looking empty. Carrying the
     * length lets CSS scale each figure to fill the space it has. */
    view.left_len = str(s.leftValue).length;
    view.right_len = str(s.rightValue).length;
  }
  if (type === 'timeline') {
    view.timeline = prepareTimeline(s.events);
  }
  if (type === 'numbered-steps') {
    view.steps = prepareSteps(s.steps);
  }
  if (type === 'image-caption') {
    view.image = prepareImage(s);
  }
  if (type === 'chart') {
    /* The chart draws its own source inside the SVG (contracts rule 4), so the
     * footer must not repeat it - and must not claim it is missing when the chart
     * spec carried it. */
    view.suppress_meta_source = true;
  }
  if (type === 'outro') {
    /* The closing slide carries the whole carousel's source manifest - the one
     * place a reader can audit every figure at once. */
    view.manifest = buildAttribution(
      collectSources({ sources: s.source_manifest || s.sourceManifest || s.sources }),
      null
    ).names;
    view.suppress_meta_source = view.manifest.length > 0;
  }

  return view;
}

module.exports = {
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
  itemSource,
  valueLength,
  sourceNameFromUrl,
};
