'use strict';

/* Render queue - bounded concurrency, bounded wait, bounded queue.
 *
 * THE PROBLEM: clicking several research buttons fans out into several carousel
 * generations, and each of those posts slides to /render. Nothing was stopping
 * them arriving at once. On a 512MB container that means several Chromium
 * processes and an OOM kill, which the caller sees as a dropped connection rather
 * than an error it can retry.
 *
 * THE FIX IS SERVER-SIDE ON PURPOSE. The workflow will also submit carousels one
 * at a time, but that is cooperation, not enforcement: a retry, a manual test, or
 * a second workflow would break it. The service has to survive being called
 * wrongly, because it is the thing that dies.
 *
 * Three bounds, each answering a different failure:
 *   - CONCURRENCY (default 1) stops the OOM.
 *   - QUEUE DEPTH stops unbounded memory growth from queued payloads, and turns
 *     overload into an immediate 429 with Retry-After instead of a request that
 *     hangs until some proxy times it out. A fast rejection is far more useful to
 *     a workflow than a slow one.
 *   - JOB TIMEOUT stops one wedged render blocking the queue forever. Without it a
 *     single hung page would make the service permanently unavailable while still
 *     answering /health.
 *
 * FIFO ordering, so a carousel submitted first finishes first and slide batches
 * come back in the order the workflow sent them.
 */

const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.RENDER_CONCURRENCY || 1));
const DEFAULT_MAX_QUEUE = Math.max(1, Number(process.env.RENDER_MAX_QUEUE || 12));
const DEFAULT_JOB_TIMEOUT_MS = Math.max(1000, Number(process.env.RENDER_JOB_TIMEOUT_MS || 120000));

/* Raised when the queue is full. Carries retryAfterSeconds so the HTTP layer can
 * set a real Retry-After header - a workflow that is told "try in 8 seconds" can
 * behave sensibly, where a bare 429 leaves it guessing. */
function overloadedError(message, retryAfterSeconds) {
  const err = new Error(message);
  err.isOverloaded = true;
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

function timeoutError(message) {
  const err = new Error(message);
  err.isTimeout = true;
  return err;
}

class RenderQueue {
  constructor(options) {
    const o = options || {};
    this.concurrency = Math.max(1, o.concurrency || DEFAULT_CONCURRENCY);
    this.maxQueue = Math.max(1, o.maxQueue || DEFAULT_MAX_QUEUE);
    this.jobTimeoutMs = Math.max(1000, o.jobTimeoutMs || DEFAULT_JOB_TIMEOUT_MS);

    this.running = 0;
    this.waiting = [];
    this.seq = 0;

    /* A rolling estimate of how long a job takes, used only to advise on
     * Retry-After. Seeded rather than left at zero so the first overload still
     * gives useful advice. */
    this.avgDurationMs = 8000;

    this.stats = {
      accepted: 0, completed: 0, failed: 0, rejected: 0, timedOut: 0,
      maxInFlightSeen: 0, maxWaitMsSeen: 0,
    };
  }

  /** Seconds a caller should wait, from queue depth and observed job duration. */
  retryAfterSeconds() {
    const ahead = this.waiting.length + this.running;
    const est = (ahead * this.avgDurationMs) / Math.max(1, this.concurrency);
    return Math.max(1, Math.min(120, Math.ceil(est / 1000)));
  }

  /**
   * Run `task` under the queue. Resolves with the task's value; rejects with the
   * task's error, or an overload/timeout error raised here.
   *
   * `label` and `weight` are for observability only - weight records how many
   * slides a job carried so the load figures mean something.
   */
  async run(task, meta) {
    const m = meta || {};

    if (this.waiting.length >= this.maxQueue) {
      this.stats.rejected += 1;
      const retry = this.retryAfterSeconds();
      throw overloadedError(
        'render queue is full (' + this.waiting.length + ' waiting, ' + this.running
        + ' running); retry in about ' + retry + 's',
        retry
      );
    }

    const job = {
      id: ++this.seq,
      label: m.label || 'render',
      weight: Number(m.weight) || 1,
      queuedAt: Date.now(),
      startedAt: null,
      task: task,
    };

    this.stats.accepted += 1;
    /* Peak load counts RUNNING plus WAITING, not the waiting list alone. That is
     * the figure that determines how long a new caller will wait, and the one that
     * says whether the queue cap is set sensibly - "2 waiting" means something
     * different depending on whether anything was running. */
    this.stats.maxInFlightSeen = Math.max(
      this.stats.maxInFlightSeen,
      this.running + this.waiting.length + 1
    );

    const done = new Promise(function (resolve, reject) {
      job.resolve = resolve;
      job.reject = reject;
    });

    this.waiting.push(job);
    this._pump();
    return done;
  }

  _pump() {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift();
      this.running += 1;
      this._execute(job);
    }
  }

  async _execute(job) {
    job.startedAt = Date.now();
    const waited = job.startedAt - job.queuedAt;
    this.stats.maxWaitMsSeen = Math.max(this.stats.maxWaitMsSeen, waited);

    /* The timeout races the task rather than cancelling it. A Playwright call
     * cannot be aborted from outside, so the honest behaviour is to stop WAITING
     * on it, free the slot, and let it finish into nothing. Holding the slot until
     * a wedged page returns is what would take the service down. */
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError(
          job.label + ' exceeded the ' + Math.round(this.jobTimeoutMs / 1000) + 's render timeout'
        ));
      }, this.jobTimeoutMs);
      if (timer.unref) { timer.unref(); }
    });

    try {
      const value = await Promise.race([job.task(), timeout]);
      const took = Date.now() - job.startedAt;
      // Exponential moving average: recent jobs matter more than old ones.
      this.avgDurationMs = Math.round(this.avgDurationMs * 0.7 + took * 0.3);
      this.stats.completed += 1;
      job.resolve(value);
    } catch (err) {
      if (err && err.isTimeout) { this.stats.timedOut += 1; } else { this.stats.failed += 1; }
      job.reject(err);
    } finally {
      if (timer) { clearTimeout(timer); }
      this.running -= 1;
      this._pump();
    }
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      max_queue: this.maxQueue,
      job_timeout_ms: this.jobTimeoutMs,
      running: this.running,
      waiting: this.waiting.length,
      avg_duration_ms: this.avgDurationMs,
      accepted: this.stats.accepted,
      completed: this.stats.completed,
      failed: this.stats.failed,
      rejected: this.stats.rejected,
      timed_out: this.stats.timedOut,
      max_in_flight_seen: this.stats.maxInFlightSeen,
      max_wait_ms_seen: this.stats.maxWaitMsSeen,
    };
  }
}

module.exports = {
  RenderQueue,
  overloadedError,
  timeoutError,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_QUEUE,
  DEFAULT_JOB_TIMEOUT_MS,
};
