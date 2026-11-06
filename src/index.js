/**
 * pdf-render-pool
 *
 * A persistent, concurrency-capped headless-Chromium HTML→PDF renderer built
 * on Puppeteer. One browser stays warm across calls; each render is just a new
 * browser context and page, closed when it's done. A browser that crashes or
 * stops responding is replaced.
 *
 * Requires `puppeteer` (or `puppeteer-core` with an explicit `executablePath`)
 * as a peer dependency — it's required lazily so importing this package
 * doesn't pull in Chromium until you actually render something.
 */

'use strict';

const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { createSemaphore, makeError, abortError } = require('./semaphore');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const DEFAULT_ASSET_TIMEOUT_MS = 3000;
// How long closing a page, context or browser may take before we give up on it.
const CLEANUP_TIMEOUT_MS = 3000;

const noop = () => {};

/**
 * Race `promise` against a timer and an optional AbortSignal. On timeout,
 * rejects with code 'ETIMEDOUT'; the original promise keeps running (its
 * rejection is swallowed so it can't surface as an unhandled rejection).
 */
function withTimeout(promise, ms, label, signal) {
  promise.catch(noop);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(makeError('ETIMEDOUT', `${label} timed out after ${ms}ms.`));
    }, ms);
    const onAbort = () => reject(abortError());
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    promise.then(
      (value) => { done(); resolve(value); },
      (err) => { done(); reject(err); },
    );
  });
}

function assertNumber(name, value, { min = 0, integer = false, allowInfinity = false } = {}) {
  const valid = typeof value === 'number'
    && !Number.isNaN(value)
    && value >= min
    && (value !== Infinity || allowInfinity)
    && (!integer || value === Infinity || Number.isInteger(value));
  if (!valid) {
    const kind = integer ? 'an integer' : 'a number';
    throw new RangeError(`[pdf-render-pool] ${name} must be ${kind} >= ${min}${allowInfinity ? ' or Infinity' : ''}, got ${String(value)}.`);
  }
}

/**
 * Create an independent render pool: its own browser instance and its own
 * concurrency cap. Most apps only need one pool for the whole process — call
 * this once and reuse the returned functions everywhere. Options are documented
 * in the README and in index.d.ts.
 */
function createPdfRenderPool(options = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    maxQueue = Infinity,
    queueTimeout: defaultQueueTimeout = Infinity,
    idleTimeout = 0,
    maxRendersPerBrowser = 0,
    launchTimeout = DEFAULT_LAUNCH_TIMEOUT_MS,
    retries: defaultRetries = 0,
    waitUntil: defaultWaitUntil = DEFAULT_WAIT_UNTIL,
    assetTimeout: defaultAssetTimeout = DEFAULT_ASSET_TIMEOUT_MS,
    isolate = true,
    sandbox = false,
    allowFileUrls = false,
    allowHttpErrors: defaultAllowHttpErrors = false,
    requestFilter: defaultRequestFilter,
    beforeRender: defaultBeforeRender,
    puppeteerModule = 'puppeteer',
    launchOptions = {},
    onInfo = noop,
    onWarn = noop,
    onEvent = noop,
  } = options;

  assertNumber('concurrency', concurrency, { min: 1, integer: true });
  assertNumber('maxQueue', maxQueue, { integer: true, allowInfinity: true });
  assertNumber('queueTimeout', defaultQueueTimeout, { allowInfinity: true });
  assertNumber('idleTimeout', idleTimeout);
  assertNumber('maxRendersPerBrowser', maxRendersPerBrowser, { integer: true });
  assertNumber('launchTimeout', launchTimeout, { min: 1 });
  assertNumber('retries', defaultRetries, { integer: true });
  assertNumber('assetTimeout', defaultAssetTimeout);

  const renderLimiter = createSemaphore(concurrency, maxQueue);
  // The launch new renders share: { promise, abandoned, browser }.
  let launch = null;
  // Browsers closed on purpose — their 'disconnected' event isn't a crash.
  const intentionallyClosed = new WeakSet();
  let inFlight = 0;
  let idleTimer = null;
  let closePromise = null;
  let idleWaiters = [];
  // Per-browser render counts, for maxRendersPerBrowser.
  const usage = new WeakMap();
  // Browsers taking no new renders, closed once drained.
  const retired = new Set();
  const totals = { completed: 0, failed: 0, launches: 0, crashes: 0, recycles: 0 };

  function emit(type, detail) {
    try {
      onEvent({ type, ...detail });
    } catch (err) {
      onWarn(`[pdf-render-pool] onEvent threw: ${err.message}`);
    }
  }

  function startLaunch() {
    const puppeteer = require(puppeteerModule);
    const state = { abandoned: false, browser: null, promise: null };
    const raw = Promise.resolve().then(() => puppeteer.launch({
      headless: true,
      args: [
        // Without a sandbox, a Chromium exploit in rendered content reaches the
        // whole user account. See "Security" in the README.
        ...(sandbox ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
        // /dev/shm is tiny in containers/VPSes; use /tmp instead of crashing.
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      ...launchOptions,
    }));
    raw.then((browser) => {
      if (state.abandoned) {
        // It finished after the launch timed out or the pool closed.
        closeInstance(browser);
        return;
      }
      state.browser = browser;
      totals.launches += 1;
      onInfo('[pdf-render-pool] Headless Chromium launched (persistent).');
      emit('launch');
      browser.once('disconnected', () => {
        retired.delete(browser);
        if (launch === state) launch = null;
        if (!intentionallyClosed.has(browser)) {
          totals.crashes += 1;
          onWarn('[pdf-render-pool] Chromium disconnected — will relaunch on next render.');
          emit('crash');
        }
      });
    }).catch(noop);
    state.promise = withTimeout(raw, launchTimeout, 'Browser launch').catch((err) => {
      state.abandoned = true;
      if (launch === state) launch = null;
      if (!err.code) err.code = 'ELAUNCH';
      throw err;
    });
    state.promise.catch(noop);
    return state;
  }

  /** Get a usable browser and count one render against it. */
  async function acquireBrowser() {
    for (;;) {
      if (!launch) launch = startLaunch();
      const current = launch;
      const browser = await current.promise;
      if (!browser.connected || retired.has(browser)) {
        if (launch === current) launch = null;
        continue;
      }
      let u = usage.get(browser);
      if (!u) usage.set(browser, (u = { renders: 0, active: 0 }));
      u.renders += 1;
      u.active += 1;
      if (maxRendersPerBrowser > 0 && u.renders >= maxRendersPerBrowser) {
        totals.recycles += 1;
        emit('recycle');
        retire(browser, `reached ${maxRendersPerBrowser} renders`);
      }
      return browser;
    }
  }

  /** New renders go to a fresh browser; this one closes once it has drained. */
  function retire(browser, reason) {
    if (retired.has(browser) || !browser.connected) return;
    retired.add(browser);
    if (launch && launch.browser === browser) launch = null;
    onInfo(`[pdf-render-pool] Chromium ${reason} — recycling.`);
  }

  /** Close a browser without ever hanging; kill it if it won't close. */
  async function closeInstance(browser) {
    intentionallyClosed.add(browser);
    const closing = Promise.resolve().then(() => browser.close());
    await withTimeout(closing, CLEANUP_TIMEOUT_MS, 'Browser close').catch(() => {
      try {
        const child = typeof browser.process === 'function' ? browser.process() : null;
        if (child) child.kill('SIGKILL');
      } catch { /* already gone */ }
    });
  }

  function releaseBrowser(browser) {
    const u = usage.get(browser);
    if (u) u.active -= 1;
    if (retired.has(browser) && (!u || u.active <= 0)) {
      retired.delete(browser);
      closeInstance(browser);
    }
  }

  async function openTarget(browser) {
    // With `isolate`, each render gets its own browser context (separate
    // cookies, localStorage and cache); closing it closes its page too.
    if (!isolate) return { context: null, page: await browser.newPage() };
    const context = await browser.createBrowserContext();
    try {
      return { context, page: await context.newPage() };
    } catch (err) {
      await context.close().catch(noop);
      throw err;
    }
  }

  async function closeTarget({ context, page }) {
    if (context) await context.close().catch(noop);
    else await page.close().catch(noop);
  }

  function scheduleIdleClose() {
    if (!(idleTimeout > 0) || inFlight > 0 || !launch || closePromise) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight > 0) return;
      onInfo(`[pdf-render-pool] Idle for ${idleTimeout}ms — closing Chromium.`);
      emit('idle-close');
      closeBrowser();
    }, idleTimeout);
    // Don't keep the process alive just to close an idle browser.
    if (idleTimer.unref) idleTimer.unref();
  }

  function installRequestFilter(page, filter) {
    page.on('request', (request) => {
      // Fail closed: anything but a truthy answer blocks the request.
      Promise.resolve()
        .then(() => filter(request.url(), request))
        .catch(() => false)
        .then((allowed) => (allowed ? request.continue() : request.abort('blockedbyclient')))
        .catch(noop);
    });
    return page.setRequestInterception(true);
  }

  /** Put content in the page and print it. Bounded by the caller's deadline. */
  async function produce(page, load, settings, remaining, deliver) {
    const { waitUntil, assetTimeout, requestFilter, beforeRender, waitForSelector, waitForFunction, pageOptions } = settings;
    if (requestFilter) await installRequestFilter(page, requestFilter);
    if (beforeRender) await beforeRender(page);
    await load(page, { waitUntil, timeout: remaining() });
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: remaining() });
    if (waitForFunction) await page.waitForFunction(waitForFunction, { timeout: remaining() });
    if (waitUntil === 'domcontentloaded') {
      // Give images/fonts up to `assetTimeout` to finish, then cancel whatever
      // is still pending. Without the cancel, page.pdf() waits on them (it
      // awaits document.fonts.ready), so a dead remote image could stall
      // printing until `timeout`; without the grace period, a slow-but-working
      // logo would be cut from the PDF.
      const grace = Math.min(assetTimeout, remaining());
      if (grace > 0 && typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({ idleTime: 100, timeout: grace }).catch(noop);
      }
      await page.evaluate(() => window.stop()).catch(noop);
    }
    const printOptions = { printBackground: true, ...pageOptions, timeout: remaining() };
    if (!deliver) return Buffer.from(await page.pdf(printOptions));

    // The page must stay open while the caller reads, so this holds the slot
    // until the stream ends, is destroyed, or the deadline passes.
    const stream = Readable.fromWeb(await page.createPDFStream(printOptions));
    deliver.stream = stream;
    deliver.resolve(stream);
    await finished(stream).catch((err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
    });
    return undefined;
  }

  /** Give failures stable codes. */
  function classify(err, browser) {
    if (err && err.name === 'TimeoutError' && !err.code) err.code = 'ETIMEDOUT';
    if (err && err.code) return err;
    // The render can see the connection drop before `connected` turns false.
    const closedOnPurpose = browser && intentionallyClosed.has(browser);
    if (browser && (closedOnPurpose || !browser.connected || (err && err.name === 'TargetCloseError'))) {
      const wrapped = makeError(
        closedOnPurpose ? 'ECLOSED' : 'EBROWSERCRASHED',
        closedOnPurpose ? 'Browser was closed during the render.' : 'Chromium crashed during the render.',
      );
      wrapped.cause = err;
      return wrapped;
    }
    return err;
  }

  async function attempt(load, settings, deadline, deliver) {
    const { signal } = settings;
    const remaining = () => Math.max(1, deadline - Date.now());
    const race = (promise, label) => withTimeout(promise, remaining(), label, signal);

    const acquiring = acquireBrowser();
    let browser;
    try {
      browser = await race(acquiring, 'Waiting for browser');
    } catch (err) {
      // If the browser shows up after we gave up on it, don't hold it open.
      acquiring.then(releaseBrowser).catch(noop);
      throw err;
    }
    try {
      const opening = openTarget(browser);
      let target;
      try {
        target = await race(opening, 'Opening page');
      } catch (err) {
        // If the page shows up after we gave up on it, don't leak it.
        opening.then(closeTarget).catch(noop);
        // A browser that can't open a page in time may be stuck.
        if (err.code === 'ETIMEDOUT') retire(browser, 'did not open a page in time');
        throw err;
      }
      try {
        return await race(produce(target.page, load, settings, remaining, deliver), 'Render');
      } catch (err) {
        if (deliver && deliver.stream) deliver.stream.destroy(err);
        throw err;
      } finally {
        // A page stuck in a script can make cleanup hang too; never let that
        // hold the slot. Replace the browser instead.
        await withTimeout(closeTarget(target), CLEANUP_TIMEOUT_MS, 'Page close')
          .catch(() => retire(browser, 'did not close a page in time'));
      }
    } catch (err) {
      throw classify(err, browser);
    } finally {
      releaseBrowser(browser);
    }
  }

  /**
   * Shared render path. `load(page, { waitUntil, timeout })` puts content into
   * the page. `timeout` is one deadline, starting when a slot is free, covering
   * browser launch, page creation, content load, PDF generation and retries.
   */
  async function render(load, renderOptions = {}, deliver) {
    const {
      timeout = DEFAULT_TIMEOUT_MS,
      queueTimeout = defaultQueueTimeout,
      retries = defaultRetries,
      waitUntil = defaultWaitUntil,
      assetTimeout = defaultAssetTimeout,
      allowHttpErrors = defaultAllowHttpErrors,
      requestFilter = defaultRequestFilter,
      beforeRender = defaultBeforeRender,
      waitForSelector,
      waitForFunction,
      signal,
      ...pageOptions
    } = renderOptions;
    assertNumber('timeout', timeout, { min: 1 });
    assertNumber('queueTimeout', queueTimeout, { allowInfinity: true });
    assertNumber('retries', retries, { integer: true });
    assertNumber('assetTimeout', assetTimeout);
    if (closePromise) throw makeError('ECLOSED', 'Pool is closed.');

    const settings = {
      waitUntil, assetTimeout, allowHttpErrors, requestFilter, beforeRender, waitForSelector, waitForFunction, signal, pageOptions,
    };

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    inFlight += 1;
    try {
      const result = await renderLimiter(async () => {
        const deadline = Date.now() + timeout;
        for (let tries = 0; ; tries += 1) {
          try {
            return await attempt(load, settings, deadline, deliver);
          } catch (err) {
            const canRetry = err.code === 'EBROWSERCRASHED' && tries < retries
              && Date.now() < deadline && !closePromise && !(deliver && deliver.stream);
            if (!canRetry) throw err;
            onWarn(`[pdf-render-pool] Retrying after a browser crash (${tries + 1}/${retries}).`);
            emit('retry', { attempt: tries + 1 });
          }
        }
      }, { signal, queueTimeout });
      totals.completed += 1;
      return result;
    } catch (err) {
      totals.failed += 1;
      throw err;
    } finally {
      inFlight -= 1;
      if (inFlight === 0) {
        idleWaiters.forEach((resolve) => resolve());
        idleWaiters = [];
      }
      scheduleIdleClose();
    }
  }

  function assertHtml(html) {
    if (typeof html !== 'string') {
      throw new TypeError(`[pdf-render-pool] html must be a string, got ${html === null ? 'null' : typeof html}.`);
    }
  }

  function loadHtml(html) {
    return (page, loadOptions) => page.setContent(html, loadOptions);
  }

  /** Reject anything but http(s) (and file: if allowed) before opening a page. */
  function checkUrl(url) {
    const parsed = new URL(String(url));
    const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      || (parsed.protocol === 'file:' && allowFileUrls);
    if (!allowed) {
      const err = makeError('EBLOCKEDURL', `Refusing to render ${parsed.protocol} URLs${parsed.protocol === 'file:' ? ' (set allowFileUrls to permit them)' : ''}.`);
      err.url = parsed.href;
      throw err;
    }
    return parsed.href;
  }

  function loadUrl(href, renderOptions = {}) {
    const { allowHttpErrors = defaultAllowHttpErrors } = renderOptions;
    return async (page, loadOptions) => {
      const response = await page.goto(href, loadOptions);
      if (response && response.status() >= 400 && !allowHttpErrors) {
        const err = makeError('EHTTPSTATUS', `${href} responded with HTTP ${response.status()}.`);
        err.status = response.status();
        err.url = href;
        throw err;
      }
    };
  }

  /** Render an HTML string to a PDF buffer. */
  async function renderPdf(html, renderOptions) {
    assertHtml(html);
    return render(loadHtml(html), renderOptions);
  }

  /** Navigate to a URL and render the page to a PDF buffer. */
  async function renderPdfFromUrl(url, renderOptions) {
    return render(loadUrl(checkUrl(url), renderOptions), renderOptions);
  }

  function stream(load, renderOptions) {
    return new Promise((resolve, reject) => {
      render(load, renderOptions, { resolve, stream: null }).catch(reject);
    });
  }

  /** Render an HTML string to a Node Readable. Holds its slot until read or destroyed. */
  async function renderPdfStream(html, renderOptions) {
    assertHtml(html);
    return stream(loadHtml(html), renderOptions);
  }

  /** Navigate to a URL and render it to a Node Readable. Holds its slot until read or destroyed. */
  async function renderPdfStreamFromUrl(url, renderOptions) {
    return stream(loadUrl(checkUrl(url), renderOptions), renderOptions);
  }

  /**
   * Close the current browser now, failing renders using it. The pool stays
   * usable: anything still queued or rendered later launches a new browser.
   * For process shutdown, use close().
   */
  async function closeBrowser() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const closing = [...retired];
    retired.clear();
    const current = launch;
    launch = null;
    if (current) {
      if (current.browser) closing.push(current.browser);
      // Still launching: it gets closed when (and if) it arrives.
      else current.abandoned = true;
    }
    await Promise.all(closing.map(closeInstance));
  }

  /**
   * Shut the pool down for good: new renders reject with ECLOSED, then the
   * browser is closed. With `drain` (default), running and queued renders
   * finish first, for at most `timeout` ms if given.
   */
  function close({ drain = true, timeout = Infinity } = {}) {
    if (closePromise) return closePromise;
    assertNumber('timeout', timeout, { allowInfinity: true });
    closePromise = (async () => {
      if (drain && inFlight > 0) {
        const idle = new Promise((resolve) => idleWaiters.push(resolve));
        if (timeout === Infinity) await idle;
        else await withTimeout(idle, timeout, 'Drain').catch(noop);
      }
      renderLimiter.rejectQueued(makeError('ECLOSED', 'Pool closed before this render started.'));
      await closeBrowser();
    })();
    return closePromise;
  }

  /** Current load, browser state and running totals. */
  function stats() {
    let browser = 'none';
    if (launch) browser = launch.browser ? 'ready' : 'launching';
    return { ...renderLimiter.stats(), browser, closed: Boolean(closePromise), ...totals };
  }

  const pool = { renderPdf, renderPdfFromUrl, renderPdfStream, renderPdfStreamFromUrl, closeBrowser, close, stats };
  if (Symbol.asyncDispose) pool[Symbol.asyncDispose] = () => close();
  return pool;
}

module.exports = { createPdfRenderPool };
