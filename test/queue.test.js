'use strict';

/* Render queue and browser pool tests.
 *
 * These cover the load behaviour that has no visible symptom until it takes the
 * service down: launching a browser per request, letting requests pile up
 * unbounded, or blocking the queue on one wedged render. On a 512MB container the
 * failure is an OOM kill, which the caller sees as a dropped connection rather
 * than an error - so the bounds have to be asserted rather than assumed.
 *
 * The queue is tested with fake tasks, and the pool with a fake launcher, so
 * nothing here starts Chromium.
 */

const test = require('node:test');
const assert = require('node:assert');

const { RenderQueue } = require('../src/renderqueue');
const { BrowserPool } = require('../src/browserpool');

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* A task that records when it starts and finishes, so overlap can be detected. */
function tracker() {
  const log = [];
  let active = 0;
  let maxActive = 0;
  return {
    log: log,
    maxActive: function () { return maxActive; },
    task: function (name, ms) {
      return async function () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        log.push('start:' + name);
        await sleep(ms === undefined ? 10 : ms);
        log.push('end:' + name);
        active -= 1;
        return name;
      };
    },
  };
}

/* ------------------------------------------------------------------- queue */

test('renders are serialised, so two Chromium instances never coexist', async () => {
  /* This is the crash: several research requests fan out into several carousel
   * renders, each launching its own browser, and the container is OOM-killed. */
  const t = tracker();
  const q = new RenderQueue({ concurrency: 1, maxQueue: 10 });

  await Promise.all([
    q.run(t.task('a', 20)),
    q.run(t.task('b', 20)),
    q.run(t.task('c', 20)),
  ]);

  assert.equal(t.maxActive(), 1, 'more than one render ran at once');
  assert.deepEqual(t.log, [
    'start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c',
  ]);
});

test('queue order is FIFO, so slide batches come back in submission order', async () => {
  const t = tracker();
  const q = new RenderQueue({ concurrency: 1, maxQueue: 10 });
  const results = await Promise.all([
    q.run(t.task('first', 5)),
    q.run(t.task('second', 5)),
    q.run(t.task('third', 5)),
  ]);
  assert.deepEqual(results, ['first', 'second', 'third']);
});

test('a higher concurrency is honoured when the container can afford it', async () => {
  // The default is 1 for memory reasons, not because the queue cannot do more.
  const t = tracker();
  const q = new RenderQueue({ concurrency: 2, maxQueue: 10 });
  await Promise.all([q.run(t.task('a', 30)), q.run(t.task('b', 30)), q.run(t.task('c', 30))]);
  assert.equal(t.maxActive(), 2);
});

test('an overloaded queue rejects immediately with a retry hint', async () => {
  /* A fast 429 is far more useful to a workflow than a request that hangs until
   * some proxy times it out - it can wait the advertised time and retry. */
  const t = tracker();
  const q = new RenderQueue({ concurrency: 1, maxQueue: 2 });

  const running = q.run(t.task('running', 60));
  const queued = [q.run(t.task('q1', 5)), q.run(t.task('q2', 5))];

  await assert.rejects(
    () => q.run(t.task('overflow', 5)),
    (e) => e.isOverloaded === true
      && /render queue is full/.test(e.message)
      && typeof e.retryAfterSeconds === 'number'
      && e.retryAfterSeconds >= 1
  );

  await Promise.all([running].concat(queued));
  assert.equal(q.snapshot().rejected, 1);
});

test('rejection does not disturb the work already queued', async () => {
  const t = tracker();
  const q = new RenderQueue({ concurrency: 1, maxQueue: 1 });
  const running = q.run(t.task('running', 40));
  const queued = q.run(t.task('queued', 5));
  await assert.rejects(() => q.run(t.task('rejected', 5)), (e) => e.isOverloaded === true);

  assert.equal(await running, 'running');
  assert.equal(await queued, 'queued');
  const s = q.snapshot();
  assert.equal(s.completed, 2);
  assert.equal(s.rejected, 1);
});

test('a wedged render times out instead of blocking the queue forever', async () => {
  /* Without this one hung page makes the service permanently unavailable while
   * still answering /health, which is the worst possible failure shape. */
  const q = new RenderQueue({ concurrency: 1, maxQueue: 5, jobTimeoutMs: 1000 });

  const stuck = q.run(function () { return new Promise(function () { /* never settles */ }); });
  await assert.rejects(() => stuck, (e) => e.isTimeout === true && /render timeout/.test(e.message));

  // The slot must be free again immediately after the timeout.
  const after = await q.run(async function () { return 'ok'; });
  assert.equal(after, 'ok');
  assert.equal(q.snapshot().timed_out, 1);
});

test('a failing render frees its slot and surfaces the original error', async () => {
  const q = new RenderQueue({ concurrency: 1, maxQueue: 5 });

  await assert.rejects(
    () => q.run(async function () { throw new Error('slides[2] content overflows by 40px'); }),
    /overflows by 40px/
  );

  assert.equal(await q.run(async function () { return 'next'; }), 'next');
  const s = q.snapshot();
  assert.equal(s.failed, 1);
  assert.equal(s.running, 0);
  assert.equal(s.waiting, 0);
});

test('a validation error keeps its marker through the queue', async () => {
  // The HTTP layer classifies on this marker; losing it would turn a 400 into a
  // 500 and send the workflow down an error path.
  const q = new RenderQueue({ concurrency: 1 });
  const err = new Error('slides[0].headline is required');
  err.isValidation = true;
  await assert.rejects(() => q.run(async function () { throw err; }), (e) => e.isValidation === true);
});

test('load is reported so a caller can back off before being rejected', async () => {
  const t = tracker();
  const q = new RenderQueue({ concurrency: 1, maxQueue: 5 });
  const jobs = [q.run(t.task('a', 30)), q.run(t.task('b', 30)), q.run(t.task('c', 30))];

  await sleep(5);
  const mid = q.snapshot();
  assert.equal(mid.running, 1);
  assert.equal(mid.waiting, 2);

  await Promise.all(jobs);
  const done = q.snapshot();
  assert.equal(done.running, 0);
  assert.equal(done.waiting, 0);
  assert.equal(done.completed, 3);
  // Peak in-flight counts running plus waiting: 1 running with 2 queued is 3.
  assert.equal(done.max_in_flight_seen, 3);
  assert.ok(done.avg_duration_ms > 0);
});

test('the retry hint grows with queue depth', async () => {
  const t = tracker();
  const q = new RenderQueue({ concurrency: 1, maxQueue: 8 });
  const jobs = [];
  for (let i = 0; i < 6; i++) { jobs.push(q.run(t.task('j' + i, 20))); }
  const deep = q.retryAfterSeconds();
  await Promise.all(jobs);
  const idle = q.retryAfterSeconds();
  assert.ok(deep > idle, 'expected a longer hint under load, got ' + deep + ' vs ' + idle);
});

/* -------------------------------------------------------------------- pool */

/* Minimal stand-in for Playwright's chromium, so the pool's lifecycle can be
 * tested without launching a real browser. */
function fakeLauncher() {
  const state = { launched: 0, closed: 0, instances: [] };
  return {
    state: state,
    launch: async function () {
      state.launched += 1;
      const b = {
        _connected: true,
        _handlers: {},
        isConnected: function () { return this._connected; },
        on: function (evt, fn) { this._handlers[evt] = fn; },
        close: async function () {
          this._connected = false;
          state.closed += 1;
          if (this._handlers.disconnected) { this._handlers.disconnected(); }
        },
        // Simulates the process dying, e.g. near the container memory limit.
        kill: function () {
          this._connected = false;
          if (this._handlers.disconnected) { this._handlers.disconnected(); }
        },
        newContext: async function () { return { close: async function () {} }; },
      };
      state.instances.push(b);
      return b;
    },
  };
}

test('one browser is launched and reused across renders', async () => {
  /* The old code launched per request. Reuse is what keeps concurrent load inside
   * a 512MB container, and it removes a 300-800ms launch from every request. */
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 100, idleMs: 0 });

  for (let i = 0; i < 5; i++) {
    const b = await pool.acquire();
    assert.ok(b.isConnected());
    await pool.release(1);
  }

  assert.equal(l.state.launched, 1, 'expected one launch, got ' + l.state.launched);
  await pool.close();
});

test('concurrent cold starts share a single launch', async () => {
  // Without a shared launch promise, two requests arriving during a cold start
  // each launch a browser and one is orphaned - the leak the pool exists to stop.
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 100, idleMs: 0 });

  const browsers = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.equal(l.state.launched, 1);
  assert.equal(browsers[0], browsers[1]);
  assert.equal(browsers[1], browsers[2]);

  await pool.release(1); await pool.release(1); await pool.release(1);
  await pool.close();
});

test('the browser is recycled once its render budget is spent', async () => {
  /* Chromium's memory grows with page count however carefully contexts are
   * closed, so the process is replaced on a schedule rather than trusted
   * indefinitely. */
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 6, idleMs: 0 });

  // Three renders of two slides each hits the budget exactly.
  for (let i = 0; i < 3; i++) {
    await pool.acquire();
    await pool.release(2);
  }
  assert.equal(l.state.closed, 1, 'expected a recycle at the budget');

  await pool.acquire();
  await pool.release(1);
  assert.equal(l.state.launched, 2, 'expected a fresh browser after the recycle');
  await pool.close();
});

test('the budget counts slides, not requests', async () => {
  // A 10-slide carousel wears the process ten times as much as a 1-slide one.
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 10, idleMs: 0 });
  await pool.acquire();
  await pool.release(10);
  assert.equal(l.state.closed, 1, 'one 10-slide render should exhaust a budget of 10');
  await pool.close();
});

test('a browser is never recycled while another render holds it', async () => {
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 1, idleMs: 0 });

  await pool.acquire();
  await pool.acquire();
  await pool.release(5);
  assert.equal(l.state.closed, 0, 'closed the browser mid-render for another caller');

  await pool.release(5);
  assert.equal(l.state.closed, 1);
  await pool.close();
});

test('a crashed browser is replaced rather than handed out dead', async () => {
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 100, idleMs: 0 });

  const first = await pool.acquire();
  await pool.release(1);
  first.kill();

  const second = await pool.acquire();
  assert.ok(second.isConnected());
  assert.notEqual(second, first);
  assert.equal(l.state.launched, 2);
  assert.equal(pool.snapshot().crashes, 1);
  await pool.release(1);
  await pool.close();
});

test('a deliberate recycle is not counted as a crash', async () => {
  // Otherwise the crash figure would tick up on every recycle and be useless for
  // spotting a container that is genuinely running out of memory.
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 2, idleMs: 0 });

  await pool.acquire();
  await pool.release(2);
  await pool.acquire();
  await pool.release(2);

  const s = pool.snapshot();
  assert.equal(s.recycles, 2);
  assert.equal(s.crashes, 0, 'recycles were counted as crashes');
  await pool.close();
});

test('a late disconnect from a replaced browser does not clear its successor', async () => {
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 1, idleMs: 0 });

  const first = await pool.acquire();
  await pool.release(1);          // budget spent -> recycled
  const second = await pool.acquire();
  assert.notEqual(second, first);

  // The old instance emits disconnected after its replacement is already in place.
  first.kill();
  assert.equal(pool.browser, second, 'a stale event nulled the live browser');
  await pool.release(1);
  await pool.close();
});

test('an idle browser is closed so a sleeping container is not holding memory', async () => {
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 100, idleMs: 40 });

  await pool.acquire();
  await pool.release(1);
  assert.equal(l.state.closed, 0, 'closed too early');

  await sleep(90);
  assert.equal(l.state.closed, 1, 'idle browser was not closed');
  await pool.close();
});

test('activity cancels a pending idle shutdown', async () => {
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, renderBudget: 100, idleMs: 60 });

  await pool.acquire();
  await pool.release(1);
  await sleep(30);
  // A render arriving inside the idle window must keep the browser alive.
  await pool.acquire();
  await sleep(50);
  assert.equal(l.state.closed, 0, 'idle timer fired despite activity');
  await pool.release(1);
  await pool.close();
});

test('closing twice is safe', async () => {
  const l = fakeLauncher();
  const pool = new BrowserPool({ launcher: l, idleMs: 0 });
  await pool.acquire();
  await pool.release(1);
  await pool.close();
  await pool.close();
  assert.equal(l.state.closed, 1);
});

test('a launch failure is reported and does not leak a lease', async () => {
  const pool = new BrowserPool({
    launcher: { launch: async function () { throw new Error('no chromium'); } },
    idleMs: 0,
  });
  await assert.rejects(() => pool.acquire(), /no chromium/);
  assert.equal(pool.snapshot().active_leases, 0, 'a failed acquire leaked a lease');
});
