'use strict';

/* Browser pool - one Chromium, reused across requests, recycled on a budget.
 *
 * WHY THIS EXISTS: renderSlides used to call chromium.launch() per request and
 * close it in a finally block. On a 512MB container that is the crash: three
 * concurrent carousel renders means three Chromium processes, and Chromium alone
 * wants 150-250MB each. The container is OOM-killed, every in-flight render dies,
 * and the workflow sees a connection reset rather than an error it can act on.
 *
 * Reuse also removes a 300-800ms launch from every request, which matters on a
 * free tier where the whole render already competes with a cold start.
 *
 * THE TRADE-OFF, stated plainly: a long-lived browser accumulates memory that a
 * per-request browser could never accumulate. That is bounded here three ways -
 * a render budget, an idle timeout, and disconnect detection - rather than hoped
 * away. The budget is the important one: Chromium's memory grows slowly with page
 * count no matter how carefully contexts are closed, so the process is replaced
 * on a schedule instead of being trusted indefinitely.
 *
 * Contexts are NOT reused. Each render gets a fresh context, so no state leaks
 * between carousels - and a context is cheap where a process is not.
 */

const { chromium } = require('playwright');

/* Renders before the process is replaced. Deliberately conservative: recycling
 * costs one launch, whereas an OOM kill costs every in-flight request. */
const DEFAULT_RENDER_BUDGET = Number(process.env.BROWSER_RENDER_BUDGET || 40);

/* Shut the browser down when nothing has used it for this long, so an idle
 * container is not holding 200MB. On a free tier that sleeps after 15 minutes
 * this mostly matters between bursts. */
const DEFAULT_IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 90 * 1000);

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--font-render-hinting=none',
  /* Memory trims for a small container. These reduce Chromium's baseline without
   * touching how a page is painted - anything that could change rasterisation is
   * excluded, because the 1080x1350 output has to stay byte-stable. */
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
];

class BrowserPool {
  constructor(options) {
    const o = options || {};
    this.renderBudget = o.renderBudget || DEFAULT_RENDER_BUDGET;
    this.idleMs = o.idleMs === undefined ? DEFAULT_IDLE_MS : o.idleMs;
    this.launcher = o.launcher || chromium;

    this.browser = null;
    this.launching = null;
    this.rendersServed = 0;
    this.leases = 0;
    this.idleTimer = null;
    /* Set while we are the ones closing the browser, so the disconnect handler can
     * tell an intentional recycle from a crash. Without it every recycle would be
     * counted as a crash and the figure would be useless for spotting a container
     * that is actually running out of memory. */
    this.closingDeliberately = false;

    this.stats = { launches: 0, recycles: 0, crashes: 0, rendersServed: 0 };
  }

  /**
   * Get the shared browser, launching it if necessary.
   *
   * Concurrent callers share one launch: without the `launching` promise, two
   * requests arriving during a cold start would each launch a browser and one
   * would be orphaned - the exact leak this class exists to prevent.
   */
  async acquire() {
    this._cancelIdleTimer();
    this.leases += 1;

    try {
      if (this.browser && !this.browser.isConnected()) {
        /* Belt and braces: the disconnect handler normally clears this and counts
         * the crash. This catches a launcher whose browser goes unusable without
         * emitting the event. */
        this.browser = null;
        this.rendersServed = 0;
      }

      if (!this.browser && !this.launching) {
        this.launching = this._launch();
      }
      if (this.launching) {
        await this.launching;
      }

      return this.browser;
    } catch (err) {
      this.leases -= 1;
      throw err;
    }
  }

  async _launch() {
    try {
      const browser = await this.launcher.launch({ args: LAUNCH_ARGS });
      this.browser = browser;
      this.rendersServed = 0;
      this.stats.launches += 1;

      /* A browser can die between requests - a container near its memory limit
       * kills the biggest process, which is Chromium. Handling `disconnected` is
       * what notices that while nothing is calling isConnected. The instance is
       * captured rather than read off `this`, so a late event from an already
       * replaced browser cannot null out its successor. */
      browser.on('disconnected', () => {
        if (!this.closingDeliberately) { this.stats.crashes += 1; }
        if (this.browser === browser) {
          this.browser = null;
          this.rendersServed = 0;
        }
      });

      return browser;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Return the browser. `renders` is how many slides the caller drew, so the
   * budget tracks actual work rather than request count - a 10-slide carousel
   * wears the process ten times as much as a 1-slide one.
   */
  async release(renders) {
    this.leases = Math.max(0, this.leases - 1);
    const n = Number(renders) || 1;
    this.rendersServed += n;
    this.stats.rendersServed += n;

    // Only recycle when nothing else holds a lease, or we would close a browser
    // mid-render for another request.
    if (this.leases === 0 && this.rendersServed >= this.renderBudget) {
      this.stats.recycles += 1;
      await this.close();
      return;
    }

    if (this.leases === 0) { this._startIdleTimer(); }
  }

  _startIdleTimer() {
    if (!this.idleMs || this.idleTimer) { return; }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.leases === 0) {
        this.close().catch(() => { /* an idle close failing changes nothing */ });
      }
    }, this.idleMs);
    // Never hold the process open just to time out an idle browser.
    if (this.idleTimer.unref) { this.idleTimer.unref(); }
  }

  _cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async close() {
    this._cancelIdleTimer();
    const b = this.browser;
    this.browser = null;
    this.rendersServed = 0;
    if (!b) { return; }

    // Flagged so the disconnect handler does not record this as a crash.
    this.closingDeliberately = true;
    try {
      await b.close();
    } catch (err) {
      // A browser that will not close is already gone; forcing the issue would
      // only mask the state we have already cleared.
    } finally {
      this.closingDeliberately = false;
    }
  }

  snapshot() {
    return {
      open: Boolean(this.browser && this.browser.isConnected()),
      active_leases: this.leases,
      renders_since_launch: this.rendersServed,
      render_budget: this.renderBudget,
      launches: this.stats.launches,
      recycles: this.stats.recycles,
      crashes: this.stats.crashes,
      renders_served: this.stats.rendersServed,
    };
  }
}

module.exports = { BrowserPool, LAUNCH_ARGS, DEFAULT_RENDER_BUDGET, DEFAULT_IDLE_MS };
