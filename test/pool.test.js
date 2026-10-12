'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPdfRenderPool } = require('../src/index.js');

const FAKE_PUPPETEER = path.join(__dirname, 'fixtures', 'fake-puppeteer.js');

test('renderPdf returns a Buffer using the fake browser', async () => {
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  const buf = await pool.renderPdf('<h1>hi</h1>');
  assert.ok(Buffer.isBuffer(buf));
  await pool.closeBrowser();
});

test('reuses one browser launch across multiple renders', async () => {
  delete require.cache[require.resolve(FAKE_PUPPETEER)];
  const fake = require(FAKE_PUPPETEER);
  fake.resetLaunchCount();

  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  await Promise.all([pool.renderPdf('<p>a</p>'), pool.renderPdf('<p>b</p>'), pool.renderPdf('<p>c</p>')]);

  assert.equal(fake.launchCount, 1);
  await pool.closeBrowser();
});

test('concurrency option caps simultaneous renders', async () => {
  let active = 0;
  let maxActive = 0;
  const slowPuppeteer = {
    launch: async () => ({
      connected: true,
      newPage: async () => ({
        setContent: async () => {},
        evaluate: async () => {},
        pdf: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
          return Buffer.from('%PDF-fake');
        },
        close: async () => {},
      }),
      once: () => {},
    createBrowserContext: async function () { this.contextsCreated = (this.contextsCreated || 0) + 1; const ctx = { newPage: this.newPage, close: async () => { ctx.closed = true; } }; (this.contexts = this.contexts || []).push(ctx); return ctx; },
      close: async () => {},
    }),
  };

  const modPath = require.resolve(FAKE_PUPPETEER);
  require.cache[modPath] = { exports: slowPuppeteer };

  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER, concurrency: 2 });
  await Promise.all([1, 2, 3, 4, 5].map(() => pool.renderPdf('<p>x</p>')));

  assert.ok(maxActive <= 2, `expected max 2 concurrent renders, got ${maxActive}`);
  delete require.cache[modPath];
});

test('closeBrowser is a no-op when never launched', async () => {
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  await assert.doesNotReject(() => pool.closeBrowser());
});

// Install `impl` as the module at FAKE_PUPPETEER for one test.
function useFake(impl) {
  const modPath = require.resolve(FAKE_PUPPETEER);
  require.cache[modPath] = { exports: impl };
  return () => delete require.cache[modPath];
}

function makeFakeBrowser(pageOverrides = {}) {
  const listeners = {};
  const browser = {
    connected: true,
    gotoCalls: [],
    setContentCalls: [],
    newPage: async () => ({
      setContent: async (html, opts) => { browser.setContentCalls.push(opts); },
      evaluate: async () => {},
      goto: async (url, opts) => { browser.gotoCalls.push({ url, opts }); },
      pdf: async () => Buffer.from('%PDF-fake'),
      close: async () => {},
      ...pageOverrides,
    }),
    once: (event, cb) => { listeners[event] = cb; },
    createBrowserContext: async function () { this.contextsCreated = (this.contextsCreated || 0) + 1; const ctx = { newPage: this.newPage, close: async () => { ctx.closed = true; } }; (this.contexts = this.contexts || []).push(ctx); return ctx; },
    close: async () => {
      browser.connected = false;
      if (listeners.disconnected) listeners.disconnected();
    },
    crash: () => {
      browser.connected = false;
      if (listeners.disconnected) listeners.disconnected();
    },
  };
  return browser;
}

test('renderPdfFromUrl navigates with page.goto', async () => {
  const browser = makeFakeBrowser();
  const restore = useFake({ launch: async () => browser });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  const buf = await pool.renderPdfFromUrl(new URL('https://example.com/invoice'));
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(browser.gotoCalls[0].url, 'https://example.com/invoice');
  assert.equal(browser.gotoCalls[0].opts.waitUntil, 'domcontentloaded');
  await pool.closeBrowser();
  restore();
});

test('waitUntil can be set per pool and per render', async () => {
  const browser = makeFakeBrowser();
  const restore = useFake({ launch: async () => browser });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER, waitUntil: 'load' });
  await pool.renderPdf('<p>a</p>');
  await pool.renderPdf('<p>b</p>', { waitUntil: 'networkidle0' });
  assert.equal(browser.setContentCalls[0].waitUntil, 'load');
  assert.equal(browser.setContentCalls[1].waitUntil, 'networkidle0');
  await pool.closeBrowser();
  restore();
});

test('timeout covers a hanging browser launch', async () => {
  const restore = useFake({ launch: () => new Promise(() => {}) });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  await assert.rejects(pool.renderPdf('<p>x</p>', { timeout: 50 }), { code: 'ETIMEDOUT' });
  restore();
});

test('closeBrowser does not warn about a crash; a real crash does', async () => {
  let browser;
  const restore = useFake({ launch: async () => (browser = makeFakeBrowser()) });
  const warnings = [];
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER, onWarn: (m) => warnings.push(m) });

  await pool.renderPdf('<p>x</p>');
  await pool.closeBrowser();
  assert.equal(warnings.length, 0);

  await pool.renderPdf('<p>y</p>');
  browser.crash();
  assert.equal(warnings.length, 1);
  restore();
});

test('relaunches after a crash', async () => {
  let launches = 0;
  let browser;
  const restore = useFake({ launch: async () => { launches += 1; return (browser = makeFakeBrowser()); } });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  await pool.renderPdf('<p>x</p>');
  browser.crash();
  await pool.renderPdf('<p>y</p>');
  assert.equal(launches, 2);
  await pool.closeBrowser();
  restore();
});

test('idleTimeout closes the browser after inactivity and relaunches on demand', async () => {
  let launches = 0;
  let browser;
  const restore = useFake({ launch: async () => { launches += 1; return (browser = makeFakeBrowser()); } });
  const warnings = [];
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER, idleTimeout: 30, onWarn: (m) => warnings.push(m) });

  await pool.renderPdf('<p>x</p>');
  assert.equal(browser.connected, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(browser.connected, false);
  assert.equal(warnings.length, 0);

  await pool.renderPdf('<p>y</p>');
  assert.equal(launches, 2);
  await pool.closeBrowser();
  restore();
});

test('maxQueue rejects renders beyond the queue limit', async () => {
  const restore = useFake({
    launch: async () => makeFakeBrowser({
      pdf: () => new Promise((r) => setTimeout(() => r(Buffer.from('%PDF-fake')), 30)),
    }),
  });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER, concurrency: 1, maxQueue: 1 });
  const results = await Promise.allSettled([1, 2, 3].map(() => pool.renderPdf('<p>x</p>')));
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.code, 'EQUEUEFULL');
  assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
  await pool.closeBrowser();
  restore();
});

test('ESM entry exports createPdfRenderPool', async () => {
  const esm = await import('../src/index.mjs');
  assert.equal(typeof esm.createPdfRenderPool, 'function');
  assert.equal(esm.createPdfRenderPool, createPdfRenderPool);
});

test('isolate (default) renders in a fresh browser context that is closed afterwards', async () => {
  const browser = makeFakeBrowser();
  const restore = useFake({ launch: async () => browser });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  await pool.renderPdf('<p>a</p>');
  await pool.renderPdf('<p>b</p>');
  assert.equal(browser.contexts.length, 2);
  assert.ok(browser.contexts.every((c) => c.closed));
  await pool.closeBrowser();
  restore();
});

test('isolate: false uses the default context', async () => {
  const browser = makeFakeBrowser();
  const restore = useFake({ launch: async () => browser });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER, isolate: false });
  await pool.renderPdf('<p>a</p>');
  assert.equal(browser.contexts, undefined);
  await pool.closeBrowser();
  restore();
});

test('falls back to createIncognitoBrowserContext on Puppeteer < 22', async () => {
  const browser = makeFakeBrowser();
  let incognito = 0;
  browser.createIncognitoBrowserContext = async () => { incognito += 1; return { newPage: browser.newPage, close: async () => {} }; };
  delete browser.createBrowserContext;
  const restore = useFake({ launch: async () => browser });
  const pool = createPdfRenderPool({ puppeteerModule: FAKE_PUPPETEER });
  await pool.renderPdf('<p>a</p>');
  assert.equal(incognito, 1);
  await pool.closeBrowser();
  restore();
});
