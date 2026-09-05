'use strict';

/* Shared type contracts for the editorial pipeline.
 *
 * These are plain JSDoc typedefs plus runtime validators - no TypeScript build
 * step, because the service runs straight from source in a container and a build
 * step is one more thing to break at deploy time.
 *
 * The contracts matter more than usual here because the pipeline is STATELESS:
 * n8n holds the plan between /carousel/plan and /carousel/render, so the plan
 * object crosses a process boundary and must round-trip through JSON intact.
 * Anything not expressible in JSON cannot live in a plan.
 */

/** Rights states. UNKNOWN must never be treated as publishable. */
const RIGHTS_STATES = [
  'OWNED',
  'LICENSED',
  'PUBLIC_DOMAIN',
  'CC0',
  'CC_LICENSE',
  'EDITORIAL_PERMISSION',
  'UNKNOWN',
  'RESTRICTED',
  'PROHIBITED',
];

const PUBLISH_ELIGIBILITY = ['eligible', 'review_required', 'blocked'];

/* Only content we generated ourselves is publish-eligible without review.
 * Everything sourced externally defaults to review, including permissively
 * licensed material - a CC licence still carries attribution conditions that a
 * human should confirm are satisfied. */
const AUTO_ELIGIBLE_RIGHTS = ['OWNED'];

/** Claim taxonomy. The distinction is editorial, not cosmetic: it governs the
 *  wording the renderer is allowed to use. A projection may not be stated as a
 *  fact. */
const CLAIM_TYPES = [
  'fact',
  'estimate',
  'projection',
  'comparison',
  'quote',
  'analysis',
];

/** Source tiers. Tier 4 must not be the sole support for a material claim. */
const SOURCE_TIERS = {
  1: 'primary - official announcement, filing, dataset, original research',
  2: 'major reputable outlet - Reuters, AP, Bloomberg, FT, WSJ',
  3: 'respected specialist or industry publication',
  4: 'social, blog, aggregator - sentiment and reaction only',
};

/** Narrative roles a slide can occupy. */
const SLIDE_ROLES = [
  'hook',
  'key_fact',
  'statistic',
  'timeline',
  'trend',
  'comparison',
  'ranking',
  'before_after',
  'process',
  'explainer',
  'quote',
  'evidence',
  'product_ui',
  'counterpoint',
  'implications',
  'conclusion',
  'cta',
];

/** How a slide's content is primarily communicated. Chosen by the visual
 *  planner BEFORE rendering, and decoupled from layout so the renderer keeps
 *  ownership of presentation. */
const VISUAL_TYPES = [
  'chart',
  'metric_cards',
  'image',
  'diagram',
  'timeline',
  'quote_card',
  'typographic',
  'comparison_panels',
];

/** Layout families. The renderer picks from these using visual_type plus
 *  density; the planner does not address pixels.
 *
 *  These are STRUCTURALLY distinct, which is the point. The 12 original frames
 *  all shared one skeleton - eyebrow, headline, content block, dead space,
 *  footer - so twelve "different" templates produced twelve slides with the same
 *  silhouette, and a carousel read as one slide repeated. Each family here
 *  places its content differently: where the eye enters, where the mass sits,
 *  and how much of the canvas the content occupies. */
const LAYOUTS = [
  'editorial_hero',
  'chart_dominant',
  'split_comparison',
  'image_annotated',
  'metric_cards',
  'timeline_scaled',
  'quote_evidence',
  'diagram_explainer',
  'evidence_list',
  'conclusion_cta',
];

/* Which layout each frame type is built on. Frames are the caller-facing
 * vocabulary (n8n sends `type: "stat-grid"`); layouts are the structural
 * skeletons. Keeping the mapping here means the planner can reason in layouts
 * while existing callers keep sending frame types, and neither has to know about
 * the other. */
const FRAME_LAYOUTS = {
  'cover': 'editorial_hero',
  'big-text': 'editorial_hero',
  'chart': 'chart_dominant',
  'stat': 'metric_cards',
  'stat-grid': 'metric_cards',
  'comparison': 'split_comparison',
  'two-column': 'split_comparison',
  'bullet-list': 'evidence_list',
  'numbered-steps': 'diagram_explainer',
  'timeline': 'timeline_scaled',
  'quote': 'quote_evidence',
  'image-caption': 'image_annotated',
  'outro': 'conclusion_cta',
};

/* Which layouts can satisfy a given visual_type. The planner chooses a
 * visual_type from the CLAIMS; the renderer then picks a layout that can carry
 * it. Listed most-preferred first. */
const VISUAL_TYPE_LAYOUTS = {
  'chart': ['chart_dominant'],
  'metric_cards': ['metric_cards'],
  'image': ['image_annotated'],
  'diagram': ['diagram_explainer'],
  'timeline': ['timeline_scaled', 'chart_dominant'],
  'quote_card': ['quote_evidence'],
  'comparison_panels': ['split_comparison', 'chart_dominant'],
  'typographic': ['editorial_hero', 'evidence_list', 'conclusion_cta'],
};

/** Chart families the renderer can draw. Kept separate from VISUAL_TYPES: a
 *  slide's visual_type says "this is a chart", the chart kind says which one. */
const CHART_KINDS = [
  'bar',
  'grouped-bar',
  'line',
  'progression',
  'share',
  'timeline-scaled',
];

/** Minimum data points per chart kind. Below this the chart is not a chart -
 *  a "line" through one point is decoration pretending to be evidence. */
const CHART_MIN_POINTS = {
  'bar': 2,
  'grouped-bar': 2,
  'line': 3,
  'progression': 2,
  'share': 2,
  'timeline-scaled': 2,
};

/** Maximum points that stay legible at 1080px on a phone screen. */
const CHART_MAX_POINTS = {
  'bar': 7,
  'grouped-bar': 8,
  'line': 12,
  'progression': 6,
  'share': 6,
  'timeline-scaled': 6,
};

const MEDIA_TYPES = ['image', 'video'];

const CANVAS = { width: 1080, height: 1350 };

/* ---------------------------------------------------------------- validators */

/* Caller-fault errors are tagged so the HTTP layer can return 400 rather than
 * 500. Tagging is explicit because classifying by message text is fragile - a
 * reworded message would silently start being reported as a server fault, and a
 * workflow would take an error path instead of being told to fix its input.
 *
 * This lives in contracts rather than render.js so the chart builder can raise
 * caller-fault errors too without the two modules requiring each other. */
function validationError(message) {
  const err = new Error(message);
  err.isValidation = true;
  return err;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(errors, path, message) {
  errors.push(path + ': ' + message);
}

/**
 * Validate a normalised claim. Returns an array of error strings; empty means
 * valid. Deliberately does NOT throw - callers collect errors across many
 * claims and report them together.
 */
function validateClaim(claim, path) {
  const errors = [];
  const p = path || 'claim';

  if (!isPlainObject(claim)) {
    fail(errors, p, 'must be an object');
    return errors;
  }
  if (!claim.id) { fail(errors, p + '.id', 'required'); }
  if (!claim.text) { fail(errors, p + '.text', 'required'); }
  if (CLAIM_TYPES.indexOf(claim.claim_type) === -1) {
    fail(errors, p + '.claim_type', 'must be one of ' + CLAIM_TYPES.join(', '));
  }
  if (!Array.isArray(claim.sources) || claim.sources.length === 0) {
    fail(errors, p + '.sources', 'at least one source required');
  } else {
    claim.sources.forEach(function (s, i) {
      const sp = p + '.sources[' + i + ']';
      if (!s || !s.name) { fail(errors, sp + '.name', 'required'); }
      const tier = Number(s && s.tier);
      if (!SOURCE_TIERS[tier]) { fail(errors, sp + '.tier', 'must be 1-4'); }
    });
  }

  // A claim carrying a numeric value must carry a unit, otherwise a chart axis
  // cannot be labelled and the number is meaningless on a slide.
  if (claim.value !== null && claim.value !== undefined) {
    if (typeof claim.value !== 'number' || !isFinite(claim.value)) {
      fail(errors, p + '.value', 'must be a finite number when present');
    }
    if (!claim.unit) { fail(errors, p + '.unit', 'required when value is present'); }
  }

  if (claim.series !== null && claim.series !== undefined) {
    if (!Array.isArray(claim.series)) {
      fail(errors, p + '.series', 'must be an array when present');
    } else {
      claim.series.forEach(function (pt, i) {
        const sp = p + '.series[' + i + ']';
        if (!pt || !pt.label) { fail(errors, sp + '.label', 'required'); }
        if (typeof (pt && pt.value) !== 'number' || !isFinite(pt.value)) {
          fail(errors, sp + '.value', 'must be a finite number');
        }
      });
    }
  }

  return errors;
}

/**
 * Validate a slide plan entry. Pagination is validated here because getting it
 * wrong is exactly the bug this rebuild exists to fix.
 */
function validateSlidePlan(slide, path, totalSlides) {
  const errors = [];
  const p = path || 'slide';

  if (!isPlainObject(slide)) {
    fail(errors, p, 'must be an object');
    return errors;
  }

  if (typeof slide.slide_index !== 'number' || slide.slide_index < 1) {
    fail(errors, p + '.slide_index', 'must be a positive number');
  }
  // total_slides must be carried explicitly on every slide. The old renderer
  // derived it from the array it happened to receive, so batching 3 slides at a
  // time produced "1/3 2/3 3/3" inside a 7-slide carousel.
  if (typeof slide.total_slides !== 'number' || slide.total_slides < 1) {
    fail(errors, p + '.total_slides', 'must be a positive number');
  } else if (totalSlides !== undefined && slide.total_slides !== totalSlides) {
    fail(errors, p + '.total_slides',
      'is ' + slide.total_slides + ' but carousel has ' + totalSlides + ' slides');
  }

  if (SLIDE_ROLES.indexOf(slide.role) === -1) {
    fail(errors, p + '.role', 'must be one of ' + SLIDE_ROLES.join(', '));
  }
  if (VISUAL_TYPES.indexOf(slide.visual_type) === -1) {
    fail(errors, p + '.visual_type', 'must be one of ' + VISUAL_TYPES.join(', '));
  }
  if (slide.layout && LAYOUTS.indexOf(slide.layout) === -1) {
    fail(errors, p + '.layout', 'must be one of ' + LAYOUTS.join(', '));
  }
  if (!slide.purpose) { fail(errors, p + '.purpose', 'required'); }

  // Every content slide must trace back to claims. hook/cta/conclusion are
  // exempt because they are editorial framing rather than assertions.
  const exempt = ['hook', 'cta', 'conclusion'];
  if (exempt.indexOf(slide.role) === -1) {
    if (!Array.isArray(slide.claim_ids) || slide.claim_ids.length === 0) {
      fail(errors, p + '.claim_ids', 'required for role "' + slide.role + '"');
    }
  }

  return errors;
}

/** Validate a whole plan object as it crosses the JSON boundary. */
function validatePlan(plan) {
  const errors = [];

  if (!isPlainObject(plan)) { return ['plan: must be an object']; }
  if (!isPlainObject(plan.story)) { fail(errors, 'plan.story', 'required'); }
  if (!Array.isArray(plan.claims)) { fail(errors, 'plan.claims', 'must be an array'); }
  if (!Array.isArray(plan.slides) || plan.slides.length === 0) {
    fail(errors, 'plan.slides', 'must be a non-empty array');
    return errors;
  }
  if (plan.slides.length > 10) {
    fail(errors, 'plan.slides', 'Instagram carousels cap at 10 slides');
  }

  const total = plan.slides.length;
  plan.slides.forEach(function (s, i) {
    validateSlidePlan(s, 'plan.slides[' + i + ']', total)
      .forEach(function (e) { errors.push(e); });
  });

  // Indices must be a contiguous 1..N sequence, in order.
  plan.slides.forEach(function (s, i) {
    if (s && s.slide_index !== i + 1) {
      fail(errors, 'plan.slides[' + i + '].slide_index',
        'is ' + s.slide_index + ' but should be ' + (i + 1));
    }
  });

  // Claim references must resolve, or attribution silently breaks.
  const claimIds = {};
  (plan.claims || []).forEach(function (c) { if (c && c.id) { claimIds[c.id] = true; } });
  plan.slides.forEach(function (s, i) {
    (s && Array.isArray(s.claim_ids) ? s.claim_ids : []).forEach(function (id) {
      if (!claimIds[id]) {
        fail(errors, 'plan.slides[' + i + '].claim_ids',
          'references unknown claim "' + id + '"');
      }
    });
  });

  return errors;
}

/** Decide publish eligibility from a rights state. Conservative by design. */
function publishEligibilityFor(rightsStatus) {
  if (rightsStatus === 'PROHIBITED' || rightsStatus === 'RESTRICTED') { return 'blocked'; }
  if (AUTO_ELIGIBLE_RIGHTS.indexOf(rightsStatus) !== -1) { return 'eligible'; }
  return 'review_required';
}

/* ------------------------------------------------------------- attribution */

/* Source-name normalisation for on-slide display. A slide footer has room for a
 * publication name, not a URL - "theinformation.com/articles/..." on a slide is
 * noise, and worse, it looks like a citation while being unreadable. */
const DOMAIN_NAMES = {
  'theinformation.com': 'The Information',
  'reuters.com': 'Reuters',
  'apnews.com': 'AP',
  'bloomberg.com': 'Bloomberg',
  'ft.com': 'Financial Times',
  'wsj.com': 'WSJ',
  'nytimes.com': 'New York Times',
  'techcrunch.com': 'TechCrunch',
  'theverge.com': 'The Verge',
  'arstechnica.com': 'Ars Technica',
  'wired.com': 'Wired',
  'siliconangle.com': 'SiliconANGLE',
  'venturebeat.com': 'VentureBeat',
  'openai.com': 'OpenAI',
  'anthropic.com': 'Anthropic',
  'nvidia.com': 'NVIDIA',
  'blogs.nvidia.com': 'NVIDIA',
  'artificialanalysis.ai': 'Artificial Analysis',
  'arxiv.org': 'arXiv',
  'sec.gov': 'SEC filing',
};

/** Pull a displayable publication name out of a URL. */
function sourceNameFromUrl(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || '').trim());
  if (!m) { return ''; }
  const host = m[1].toLowerCase().replace(/^www\./, '');
  if (DOMAIN_NAMES[host]) { return DOMAIN_NAMES[host]; }

  // Strip a leading subdomain (blog., newsroom., investor.) then try again, so
  // "blogs.nvidia.com" and "nvidia.com" resolve the same way.
  const parts = host.split('.');
  if (parts.length > 2) {
    const bare = parts.slice(-2).join('.');
    if (DOMAIN_NAMES[bare]) { return DOMAIN_NAMES[bare]; }
  }

  // Fall back to the registrable name, title-cased: "example.com" -> "Example".
  const name = parts.length >= 2 ? parts[parts.length - 2] : host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Build the attribution line for a slide.
 *
 * EVERY slide gets one. The design audit found zero source attribution across
 * all 12 templates, which for a feed that publishes numbers is the difference
 * between reporting and asserting. Sources are accepted in whatever shape the
 * caller has - a string, a name, a URL, an array of any of those - because the
 * alternative is a slide silently shipping unattributed when the shape does not
 * match.
 *
 * `asOf` matters for anything time-sensitive: "$83M" without "as of Aug 2026" is
 * a claim that silently ages.
 */
function buildAttribution(sources, asOf) {
  const list = [].concat(sources === null || sources === undefined ? [] : sources);

  const names = [];
  list.forEach(function (s) {
    if (!s) { return; }
    let name = '';
    if (typeof s === 'string') {
      // A bare string may be either a name or a URL.
      name = /^https?:\/\//i.test(s.trim()) ? sourceNameFromUrl(s) : s.trim();
    } else {
      name = String(s.name || s.source_name || '').trim() || sourceNameFromUrl(s.url || s.source_url);
    }
    name = name.replace(/\s+/g, ' ').trim();
    if (name && names.indexOf(name) === -1) { names.push(name); }
  });

  const stamp = String(asOf || '').trim();
  if (names.length === 0) {
    // No sources is still a state worth printing, because a slide with numbers
    // and no attribution should look wrong to a human reviewer.
    return stamp ? { text: 'As of ' + stamp, names: [], complete: false } : { text: '', names: [], complete: false };
  }

  const shown = names.length > 3 ? names.slice(0, 3) : names;
  let text = 'Source: ' + shown.join(', ');
  if (names.length > shown.length) { text += ' +' + (names.length - shown.length); }
  if (stamp) { text += ' \u00b7 as of ' + stamp; }

  return { text: text, names: names, complete: true };
}

module.exports = {
  RIGHTS_STATES,
  PUBLISH_ELIGIBILITY,
  AUTO_ELIGIBLE_RIGHTS,
  CLAIM_TYPES,
  SOURCE_TIERS,
  SLIDE_ROLES,
  VISUAL_TYPES,
  LAYOUTS,
  FRAME_LAYOUTS,
  VISUAL_TYPE_LAYOUTS,
  CHART_KINDS,
  CHART_MIN_POINTS,
  CHART_MAX_POINTS,
  MEDIA_TYPES,
  CANVAS,
  validationError,
  validateClaim,
  validateSlidePlan,
  validatePlan,
  publishEligibilityFor,
  sourceNameFromUrl,
  buildAttribution,
};
