/**
 * pdf-render-pool
 *
 * A persistent, concurrency-capped headless-Chromium HTML→PDF renderer built
 * on Puppeteer. One browser stays warm across calls (launching a fresh
 * Chromium per PDF costs ~1-2s and ~150-300MB RSS); each render is just a new
 * page, closed when it's done. If Chromium crashes, the next render
 * transparently relaunches it.
 *
 * Requires `puppeteer` (or `puppeteer-core` with an explicit `executablePath`)
 * as a peer dependency — it's required lazily so importing this package
 * doesn't pull in Chromium until you actually render something.
 */

'use strict';

const { createSemaphore } = require('./semaphore');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const DEFAULT_ASSET_TIMEOUT_MS = 3000;

/**
 * Race `promise` against a timer. On timeout, rejects with code 'ETIMEDOUT';
 * the original promise keeps running (its rejection is swallowed so it can't
 * surface as an unhandled rejection).
 */
function withTimeout(promise, ms, label) {
  promise.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`[pdf-render-pool] ${label} timed out after ${ms}ms.`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {Object} PdfRenderPoolOptions
 * @property {number} [concurrency=2] - max renders running at once across the pool.
 * @property {number} [maxQueue=Infinity] - max renders allowed to wait for a slot; beyond this, renders reject with code 'EQUEUEFULL'.
 * @property {number} [idleTimeout=0] - close the browser after this many ms without renders (0 = keep it open). It relaunches on the next render.
 * @property {string|string[]} [waitUntil='domcontentloaded'] - default load event to wait for before printing (e.g. 'load', 'networkidle0').
 * @property {number} [assetTimeout=3000] - with waitUntil 'domcontentloaded': how long (ms) to let images/fonts finish loading before cancelling the rest. 0 = cancel immediately.
 * @property {boolean} [isolate=true] - give each render its own browser context (no shared cookies/storage/cache). Set false to share the default context.
 * @property {string} [puppeteerModule='puppeteer'] - module name to require for launch()/newPage() (e.g. 'puppeteer-core').
 * @property {Object} [launchOptions] - extra puppeteer.launch() options, merged over the sandbox-safe defaults below.
 * @property {(msg: string) => void} [onInfo] - optional logger for lifecycle events (launch, crash/relaunch, idle close).
 * @property {(msg: string) => void} [onWarn] - optional logger for warnings.
 */

/**
 * Create an independent render pool: its own browser instance and its own
 * concurrency cap. Most apps only need one pool for the whole process — call
 * this once and reuse the returned functions everywhere.
 * @param {PdfRenderPoolOptions} [options]
 */
function createPdfRenderPool(options = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    maxQueue = Infinity,
    idleTimeout = 0,
    waitUntil: defaultWaitUntil = DEFAULT_WAIT_UNTIL,
    assetTimeout: defaultAssetTimeout = DEFAULT_ASSET_TIMEOUT_MS,
    isolate = true,
    puppeteerModule = 'puppeteer',
    launchOptions = {},
    onInfo = () => {},
    onWarn = () => {},
  } = options;

  const renderLimiter = createSemaphore(concurrency, maxQueue);
  let browserPromise = null;
  // Browsers closed on purpose — their 'disconnected' event isn't a crash.
  const intentionallyClosed = new WeakSet();
  let inFlight = 0;
  let idleTimer = null;

  async function getBrowser() {
    if (browserPromise) {
      const existing = await browserPromise.catch(() => null);
      if (existing && existing.connected) return existing;
      browserPromise = null; // launch failed or browser died — fall through to relaunch
    }

    const puppeteer = require(puppeteerModule);
    const thisLaunch = puppeteer
      .launch({
        headless: true,
        args: [
          // Required on typical Linux servers where Chromium runs as a
          // non-root user without kernel user-namespace support.
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // /dev/shm is tiny in containers/VPSes; use /tmp instead of crashing.
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
        ...launchOptions,
      })
      .then((browser) => {
        onInfo('[pdf-render-pool] Headless Chromium launched (persistent).');
        browser.once('disconnected', () => {
          // Only clear the cache if it still points at this browser — a newer
          // launch may already have replaced it.
          if (browserPromise === thisLaunch) browserPromise = null;
          if (!intentionallyClosed.has(browser)) {
            onWarn('[pdf-render-pool] Chromium disconnected — will relaunch on next render.');
          }
        });
        return browser;
      });
    browserPromise = thisLaunch;

    try {
      return await thisLaunch;
    } catch (err) {
      if (browserPromise === thisLaunch) browserPromise = null;
      throw err;
    }
  }

  // Puppeteer >= 22 renamed createIncognitoBrowserContext to createBrowserContext.
  function createContext(browser) {
    return typeof browser.createBrowserContext === 'function'
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext();
  }

  async function closeTarget({ context, page }) {
    if (context) await context.close().catch(() => {});
    else await page.close().catch(() => {});
  }

  function scheduleIdleClose() {
    if (!(idleTimeout > 0) || inFlight > 0 || !browserPromise) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight > 0) return;
      onInfo(`[pdf-render-pool] Idle for ${idleTimeout}ms — closing Chromium.`);
      closeBrowser();
    }, idleTimeout);
    // Don't keep the process alive just to close an idle browser.
    if (idleTimer.unref) idleTimer.unref();
  }

  /**
   * Shared render path. `load(page, { waitUntil, timeout })` puts content into
   * the page. `timeout` is one deadline covering browser launch, page
   * creation, content load and PDF generation.
   */
  async function render(load, pdfOptions = {}) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    inFlight += 1;
    try {
      return await renderLimiter(async () => {
        const {
          timeout = DEFAULT_TIMEOUT_MS,
          waitUntil = defaultWaitUntil,
          assetTimeout = defaultAssetTimeout,
          ...pageOptions
        } = pdfOptions;
        const deadline = Date.now() + timeout;
        const remaining = () => Math.max(1, deadline - Date.now());

        const browser = await withTimeout(getBrowser(), remaining(), 'Browser launch');
        // With `isolate`, each render gets its own browser context (separate
        // cookies, localStorage and cache); closing it closes its page too.
        const targetPromise = isolate
          ? createContext(browser).then(async (context) => {
            try {
              return { context, page: await context.newPage() };
            } catch (err) {
              await context.close().catch(() => {});
              throw err;
            }
          })
          : browser.newPage().then((page) => ({ context: null, page }));
        let target;
        try {
          target = await withTimeout(targetPromise, remaining(), 'Opening page');
        } catch (err) {
          // If the page shows up after we gave up on it, don't leak it.
          targetPromise.then(closeTarget).catch(() => {});
          throw err;
        }
        try {
          await load(target.page, { waitUntil, timeout: remaining() });
          if (waitUntil === 'domcontentloaded') {
            // Give images/fonts up to `assetTimeout` to finish, then cancel
            // whatever is still pending. Without the cancel, page.pdf() waits
            // on them (it awaits document.fonts.ready), so a dead remote image
            // could stall printing until `timeout`; without the grace period,
            // a slow-but-working logo would be cut from the PDF.
            const page = target.page;
            const grace = Math.min(assetTimeout, remaining());
            if (grace > 0 && typeof page.waitForNetworkIdle === 'function') {
              await page.waitForNetworkIdle({ idleTime: 100, timeout: grace }).catch(() => {});
            }
            await page.evaluate(() => window.stop()).catch(() => {});
          }
          const pdf = await target.page.pdf({ printBackground: true, ...pageOptions, timeout: remaining() });
          return Buffer.from(pdf);
        } finally {
          await closeTarget(target);
        }
      });
    } finally {
      inFlight -= 1;
      scheduleIdleClose();
    }
  }

  /**
   * Render an HTML string to a PDF buffer.
   * @param {string} html - fully self-contained HTML (inline CSS; avoid relying on external fetches).
   * @param {Object} [pdfOptions] - puppeteer page.pdf() options + { timeout, waitUntil }.
   * @returns {Promise<Buffer>}
   */
  function renderPdf(html, pdfOptions) {
    // domcontentloaded (the default) fires once the HTML is parsed — it does
    // NOT block on external subresource loads, so a dead/slow remote image
    // renders blank instead of hanging the whole render (and the shared
    // concurrency slot) until `timeout`.
    return render((page, loadOptions) => page.setContent(html, loadOptions), pdfOptions);
  }

  /**
   * Navigate to a URL and render the page to a PDF buffer.
   * @param {string|URL} url
   * @param {Object} [pdfOptions] - puppeteer page.pdf() options + { timeout, waitUntil }.
   * @returns {Promise<Buffer>}
   */
  function renderPdfFromUrl(url, pdfOptions) {
    return render((page, loadOptions) => page.goto(String(url), loadOptions), pdfOptions);
  }

  /** Close the shared browser (graceful shutdown / test teardown). Safe to call when never launched. */
  async function closeBrowser() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!browserPromise) return;
    const pending = browserPromise;
    browserPromise = null;
    const browser = await pending.catch(() => null);
    if (browser) {
      intentionallyClosed.add(browser);
      await browser.close().catch(() => {});
    }
  }

  /** Current load: renders running and renders waiting for a slot. */
  function stats() {
    return renderLimiter.stats();
  }

  return { renderPdf, renderPdfFromUrl, closeBrowser, stats };
}

module.exports = { createPdfRenderPool };
