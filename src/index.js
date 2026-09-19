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

/**
 * @typedef {Object} PdfRenderPoolOptions
 * @property {number} [concurrency=2] - max renders running at once across the pool.
 * @property {string} [puppeteerModule='puppeteer'] - module name to require for launch()/newPage() (e.g. 'puppeteer-core').
 * @property {Object} [launchOptions] - extra puppeteer.launch() options, merged over the sandbox-safe defaults below.
 * @property {(msg: string) => void} [onInfo] - optional logger for lifecycle events (launch, crash/relaunch).
 * @property {(msg: string) => void} [onWarn] - optional logger for warnings.
 */

/**
 * Create an independent render pool: its own browser instance and its own
 * concurrency cap. Most apps only need one pool for the whole process — call
 * this once and reuse the returned renderPdf/closeBrowser everywhere.
 * @param {PdfRenderPoolOptions} [options]
 */
function createPdfRenderPool(options = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    puppeteerModule = 'puppeteer',
    launchOptions = {},
    onInfo = () => {},
    onWarn = () => {},
  } = options;

  const renderLimiter = createSemaphore(concurrency);
  let browserPromise = null;

  async function getBrowser() {
    if (browserPromise) {
      const existing = await browserPromise.catch(() => null);
      if (existing && existing.connected) return existing;
      browserPromise = null; // launch failed or browser died — fall through to relaunch
    }

    const puppeteer = require(puppeteerModule);
    browserPromise = puppeteer
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
          onWarn('[pdf-render-pool] Chromium disconnected — will relaunch on next render.');
          browserPromise = null;
        });
        return browser;
      });

    try {
      return await browserPromise;
    } catch (err) {
      browserPromise = null;
      throw err;
    }
  }

  /**
   * Render an HTML string to a PDF buffer.
   * @param {string} html - fully self-contained HTML (inline CSS; avoid relying on external fetches).
   * @param {Object} [pdfOptions] - puppeteer page.pdf() options + { timeout } (ms, default 30000, applied to both content load and PDF generation).
   * @returns {Promise<Buffer>}
   */
  async function renderPdf(html, pdfOptions = {}) {
    return renderLimiter(async () => {
      const { timeout = DEFAULT_TIMEOUT_MS, ...pageOptions } = pdfOptions;
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        // domcontentloaded fires once the HTML is parsed — it does NOT block
        // on external subresource loads, so a dead/slow remote image renders
        // blank instead of hanging the whole render (and the shared
        // concurrency slot) until `timeout`.
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout });
        const pdf = await page.pdf({ printBackground: true, ...pageOptions, timeout });
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** Close the shared browser (graceful shutdown / test teardown). Safe to call when never launched. */
  async function closeBrowser() {
    if (!browserPromise) return;
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) await browser.close().catch(() => {});
  }

  return { renderPdf, closeBrowser };
}

module.exports = { createPdfRenderPool };
