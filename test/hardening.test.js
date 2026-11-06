'use strict';

// Failure modes that need a controllable fake browser. See integration.test.js
// for the same behaviour against real Chromium.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createPdfRenderPool } = require('../src/index.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-puppeteer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

function fakePage(overrides = {}) {
  return {
    setContent: async () => {},
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => {},
    pdf: async () => Buffer.from('%PDF-fake'),
    close: async () => {},
    ...overrides,
  };
}

function fakeBrowser({ page = {}, context = {}, ...rest } = {}) {
  const listeners = {};
  const browser = {
    connected: true,
    newPage: async () => fakePage(page),
    createBrowserContext: async () => ({ newPage: async () => fakePage(page), close: async () => {}, ...context }),
    once: (event, cb) => { listeners[event] = cb; },
    close: async () => { browser.crash(); },
    crash: () => {
      browser.connected = false;
      if (listeners.disconnected) listeners.disconnected();
    },
    ...rest,
  };
  return browser;
}

// Each pool requires the module when it launches, so give each its own launch.
function poolWith(launch, options = {}) {
  const modPath = require.resolve(FAKE);
  require.cache[modPath] = { exports: { launch } };
  return createPdfRenderPool({ puppeteerModule: FAKE, ...options });
}

test('invalid options throw instead of being silently changed', () => {
  for (const options of [{ concurrency: 0 }, { concurrency: 'abc' }, { concurrency: Infinity }, { concurrency: 2.9 }, { maxQueue: -1 }, { retries: 1.5 }]) {
    assert.throws(() => createPdfRenderPool(options), RangeError);
  }
});

test('invalid render input rejects', async () => {
  const pool = poolWith(async () => fakeBrowser());
  await assert.rejects(pool.renderPdf(undefined), TypeError);
  await assert.rejects(pool.renderPdf('x', { timeout: 0 }), RangeError);
  await assert.rejects(pool.renderPdfFromUrl('not a url'), TypeError);
});

test('non-http URLs are blocked; file: needs allowFileUrls', async () => {
  let visited = null;
  const launch = async () => fakeBrowser({ page: { goto: async (url) => { visited = url; return null; } } });
  const pool = poolWith(launch);
  await assert.rejects(pool.renderPdfFromUrl('file:///etc/passwd'), { code: 'EBLOCKEDURL' });
  await assert.rejects(pool.renderPdfFromUrl('chrome://version'), { code: 'EBLOCKEDURL' });
  assert.equal(visited, null);
  const allowed = poolWith(launch, { allowFileUrls: true });
  await allowed.renderPdfFromUrl('file:///tmp/a.html');
  assert.equal(visited, 'file:///tmp/a.html');
});

test('HTTP errors reject with EHTTPSTATUS unless allowed', async () => {
  const pool = poolWith(async () => fakeBrowser({ page: { goto: async () => ({ status: () => 404 }) } }));
  await assert.rejects(pool.renderPdfFromUrl('https://x.test/'), { code: 'EHTTPSTATUS', status: 404 });
  assert.ok(Buffer.isBuffer(await pool.renderPdfFromUrl('https://x.test/', { allowHttpErrors: true })));
});

test('a hanging page step is bounded and frees its slot', async () => {
  const pool = poolWith(async () => fakeBrowser({ page: { setContent: never } }), { concurrency: 1 });
  await assert.rejects(pool.renderPdf('x', { timeout: 30 }), { code: 'ETIMEDOUT' });
  assert.equal(pool.stats().active, 0);
});

test('a hanging cleanup replaces the browser and frees its slot', async () => {
  const browsers = [];
  const pool = poolWith(async () => {
    const b = fakeBrowser({ context: browsers.length === 0 ? { close: never } : {} });
    browsers.push(b);
    return b;
  }, { concurrency: 1 });
  await pool.renderPdf('x');
  assert.equal(pool.stats().active, 0);
  await pool.renderPdf('y');
  assert.equal(browsers.length, 2);
  assert.equal(browsers[0].connected, false);
});

test('a browser that cannot open pages is replaced', async () => {
  const browsers = [];
  const pool = poolWith(async () => {
    const b = browsers.length === 0 ? fakeBrowser({ createBrowserContext: never }) : fakeBrowser();
    browsers.push(b);
    return b;
  });
  await assert.rejects(pool.renderPdf('x', { timeout: 30 }), { code: 'ETIMEDOUT' });
  assert.ok(Buffer.isBuffer(await pool.renderPdf('y')));
  assert.equal(browsers.length, 2);
});

test('a hung launch is abandoned, retried, and closed if it arrives late', async () => {
  let launches = 0;
  let resolveFirst;
  const late = fakeBrowser();
  const pool = poolWith(() => {
    launches += 1;
    return launches === 1 ? new Promise((r) => { resolveFirst = r; }) : Promise.resolve(fakeBrowser());
  }, { launchTimeout: 20 });
  await assert.rejects(pool.renderPdf('x'), { code: 'ETIMEDOUT' });
  assert.ok(Buffer.isBuffer(await pool.renderPdf('y')));
  assert.equal(launches, 2);
  resolveFirst(late);
  await sleep(5);
  assert.equal(late.connected, false);
});

test('closeBrowser does not hang on a pending launch', async () => {
  const pool = poolWith(never);
  pool.renderPdf('x', { timeout: 10 }).catch(() => {});
  await sleep(1);
  await pool.closeBrowser();
});

test('queueTimeout rejects a render that waits too long', async () => {
  const pool = poolWith(async () => fakeBrowser({ page: { pdf: async () => { await sleep(60); return Buffer.from('x'); } } }), { concurrency: 1 });
  const first = pool.renderPdf('a');
  await assert.rejects(pool.renderPdf('b', { queueTimeout: 10 }), { code: 'EQUEUETIMEOUT' });
  await first;
});

test('AbortSignal cancels queued and running renders', async () => {
  const pool = poolWith(async () => fakeBrowser({ page: { setContent: never } }), { concurrency: 1 });
  const controller = new AbortController();
  const running = pool.renderPdf('a', { signal: controller.signal });
  const queued = pool.renderPdf('b', { signal: controller.signal });
  await sleep(5);
  controller.abort();
  await assert.rejects(running, { code: 'ABORT_ERR' });
  await assert.rejects(queued, { code: 'ABORT_ERR' });
  await assert.rejects(pool.renderPdf('c', { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(pool.stats().active, 0);
});

test('close() drains, then rejects new renders and launches nothing more', async () => {
  let launches = 0;
  const pool = poolWith(async () => {
    launches += 1;
    return fakeBrowser({ page: { pdf: async () => { await sleep(10); return Buffer.from('x'); } } });
  }, { concurrency: 1 });
  const renders = [pool.renderPdf('a'), pool.renderPdf('b')];
  await pool.close();
  assert.deepEqual((await Promise.allSettled(renders)).map((r) => r.status), ['fulfilled', 'fulfilled']);
  await assert.rejects(pool.renderPdf('c'), { code: 'ECLOSED' });
  assert.equal(launches, 1);
  assert.equal(pool.stats().closed, true);
});

test('close({ drain: false }) fails running and queued renders', async () => {
  const pool = poolWith(async () => fakeBrowser({ page: { pdf: async () => { await sleep(20); throw new Error('Target closed'); } } }), { concurrency: 1 });
  const results = Promise.allSettled([pool.renderPdf('a'), pool.renderPdf('b')]);
  await sleep(5);
  await pool.close({ drain: false });
  const [a, b] = await results;
  assert.equal(a.reason.code, 'ECLOSED');
  assert.equal(b.reason.code, 'ECLOSED');
});

test('retries re-runs a render after a crash, and crashes get a stable code', async () => {
  const browsers = [];
  const launch = async () => {
    const b = fakeBrowser({
      page: {
        pdf: async () => {
          if (browsers.length === 1) { b.crash(); throw new Error('Target closed'); }
          return Buffer.from('x');
        },
      },
    });
    browsers.push(b);
    return b;
  };
  const events = [];
  const retrying = poolWith(launch, { retries: 1, onEvent: (e) => events.push(e.type) });
  assert.ok(Buffer.isBuffer(await retrying.renderPdf('a')));
  assert.deepEqual(events, ['launch', 'crash', 'retry', 'launch']);
  const s = retrying.stats();
  assert.deepEqual([s.crashes, s.launches, s.completed, s.browser], [1, 2, 1, 'ready']);

  browsers.length = 0;
  const plain = poolWith(launch);
  await assert.rejects(plain.renderPdf('a'), { code: 'EBROWSERCRASHED' });
});

test('beforeRender, waitForSelector and waitForFunction run in order', async () => {
  const calls = [];
  const pool = poolWith(async () => fakeBrowser({
    page: {
      marker: true,
      setContent: async () => { calls.push('load'); },
      waitForSelector: async (s) => { calls.push(s); },
      waitForFunction: async (f) => { calls.push(f); },
      pdf: async () => { calls.push('pdf'); return Buffer.from('x'); },
    },
  }), { beforeRender: async (page) => { assert.ok(page.marker); calls.push('before'); } });
  await pool.renderPdf('x', { waitForSelector: '#ready', waitForFunction: 'window.done' });
  assert.deepEqual(calls, ['before', 'load', '#ready', 'window.done', 'pdf']);
});

test('requestFilter fails closed', async () => {
  const handlers = {};
  const page = {
    setRequestInterception: async () => {},
    on: (event, cb) => { handlers[event] = cb; },
  };
  const pool = poolWith(async () => fakeBrowser({ page }), {
    requestFilter: (url) => {
      if (url.includes('throw')) throw new Error('nope');
      return url.includes('ok');
    },
  });
  await pool.renderPdf('x');
  const send = async (url) => {
    let result = null;
    handlers.request({ url: () => url, continue: async () => { result = 'continue'; }, abort: async () => { result = 'abort'; } });
    await sleep(1);
    return result;
  };
  assert.equal(await send('https://ok.test'), 'continue');
  assert.equal(await send('https://no.test'), 'abort');
  assert.equal(await send('https://throw.test'), 'abort');
});

test('stream holds its slot until read', async () => {
  const pool = poolWith(async () => fakeBrowser({
    page: { createPDFStream: async () => Readable.toWeb(Readable.from([Buffer.from('%PDF')])) },
  }), { concurrency: 1 });
  const stream = await pool.renderPdfStream('x');
  assert.equal(pool.stats().active, 1);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '%PDF');
  await sleep(5);
  assert.equal(pool.stats().active, 0);
});
