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
