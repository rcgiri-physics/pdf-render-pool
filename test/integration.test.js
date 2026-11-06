'use strict';

// Real Chromium. Needs `puppeteer` installed: npm run test:integration
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPdfRenderPool } = require('../src/index.js');

const LONG = { timeout: 90000 };
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

let server;
let base;
const hits = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/missing') res.statusCode = 404;
    res.end('<h1>page</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.subarray(0, 4).toString() === '%PDF';
}

test('renders HTML and URLs to a PDF', async () => {
  const pool = createPdfRenderPool();
  assert.ok(isPdf(await pool.renderPdf('<h1>hi</h1>', LONG)));
  assert.ok(isPdf(await pool.renderPdfFromUrl(`${base}/ok`, LONG)));
  await pool.close();
});

test('rejects 404 pages unless allowed', async () => {
  const pool = createPdfRenderPool();
  await assert.rejects(pool.renderPdfFromUrl(`${base}/missing`, LONG), { code: 'EHTTPSTATUS', status: 404 });
  assert.ok(isPdf(await pool.renderPdfFromUrl(`${base}/missing`, { ...LONG, allowHttpErrors: true })));
  await pool.close();
});

test('requestFilter stops HTML reaching internal hosts', async () => {
  hits.length = 0;
  const pool = createPdfRenderPool({ requestFilter: (url) => !url.startsWith(base) });
  const html = `<img src="${base}/img"><script>fetch("${base}/fetch",{mode:"no-cors"}).catch(()=>{})</script>`;
  assert.ok(isPdf(await pool.renderPdf(html, LONG)));
  assert.deepEqual(hits, []);
  await pool.close();
});

test('an infinite-loop page times out, and the pool keeps working', async () => {
  const pool = createPdfRenderPool({ concurrency: 1 });
  await pool.renderPdf('<p>warm</p>', LONG);
  const started = Date.now();
  await assert.rejects(pool.renderPdf('<script>while(true){}</script>', { timeout: 5000 }), { code: 'ETIMEDOUT' });
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
  assert.ok(isPdf(await pool.renderPdf('<p>after</p>', LONG)));
  await pool.close();
});

test('a real browser crash is reported and retried', async () => {
  let killed = false;
  const pool = createPdfRenderPool({
    retries: 1,
    beforeRender: async (page) => {
      if (killed) return;
      killed = true;
      page.browser().process().kill('SIGKILL');
      await page.waitForFunction('false', { timeout: 60000 });
    },
  });
  assert.ok(isPdf(await pool.renderPdf('<p>x</p>', LONG)));
  const s = pool.stats();
  assert.equal(s.crashes, 1);
  assert.equal(s.launches, 2);
  await pool.close();
});

test('close() during load finishes the work and launches nothing afterwards', async () => {
  const pool = createPdfRenderPool({ concurrency: 1 });
  await pool.renderPdf('<p>warm</p>', LONG);
  const results = Promise.allSettled([1, 2, 3].map(() => pool.renderPdf('<p>x</p>', LONG)));
  await pool.close();
  assert.deepEqual((await results).map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(pool.stats().launches, 1);
  assert.equal(pool.stats().browser, 'none');
});

test('closeBrowser() during load fails running work with ECLOSED', async () => {
  const pool = createPdfRenderPool({ concurrency: 1 });
  await pool.renderPdf('<p>warm</p>', LONG);
  const results = Promise.allSettled([1, 2, 3].map(() => pool.renderPdf('<p>x</p>', LONG)));
  await new Promise((r) => setTimeout(r, 50));
  await pool.closeBrowser();
  const settled = await results;
  assert.ok(settled.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ECLOSED'));
  await pool.close();
});

test('streams a PDF', async () => {
  const pool = createPdfRenderPool();
  const chunks = [];
  for await (const chunk of await pool.renderPdfStream('<h1>stream</h1>', LONG)) chunks.push(chunk);
  assert.ok(isPdf(Buffer.concat(chunks)));
  await pool.close();
});

test('no unhandled rejections in any test', async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(unhandled.map((e) => e.message), []);
});
