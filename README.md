# pdf-render-pool

[![npm](https://img.shields.io/npm/v/pdf-render-pool.svg)](https://www.npmjs.com/package/pdf-render-pool)
[![CI](https://github.com/rcgiri-physics/pdf-render-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/rcgiri-physics/pdf-render-pool/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pdf-render-pool.svg)](LICENSE)

A persistent, concurrency-capped headless-Chromium HTML→PDF renderer built on
[Puppeteer](https://pptr.dev/).

Launching and tearing down a full Chromium for every PDF costs ~1-2 seconds
and ~150-300MB of RSS. `pdf-render-pool` keeps **one browser warm** and gives
each render its own page, so a render only pays for opening a tab — plus a
concurrency cap so a burst of PDF requests queues instead of OOMing your
server.

## Guarantees

- **Concurrency-capped** — at most `concurrency` renders run at once (default 2); the rest queue FIFO.
- **Back-pressure** — optionally cap the queue (`maxQueue`) so overload fails fast with `EQUEUEFULL` instead of piling up.
- **Bounded** — every render has one `timeout` deadline covering browser launch, page creation, content load and PDF generation.
- **Crash-safe** — if Chromium dies mid-run, the next render transparently relaunches it.
- **Isolated** — every render runs in its own browser context (separate cookies, localStorage and cache), always closed afterwards, so renders can't leak pages or state into each other. Opt out with `isolate: false`.
- **Memory-friendly** — optionally close the browser when idle (`idleTimeout`); it relaunches on the next render.

## Install

```bash
npm install pdf-render-pool puppeteer
```

`puppeteer` is a peer dependency — bring your own version (or `puppeteer-core`
with an explicit `executablePath`, see below) so this package doesn't force a
particular Chromium download strategy on you. No other runtime dependencies.

## Usage

```js
const { createPdfRenderPool } = require('pdf-render-pool');
// or: import { createPdfRenderPool } from 'pdf-render-pool';

// Create the pool ONCE per process and reuse it everywhere — it holds one
// persistent browser instance.
const { renderPdf, renderPdfFromUrl, closeBrowser } = createPdfRenderPool();

// From an HTML string
const invoice = await renderPdf('<h1>Invoice #42</h1>', { format: 'A4' });

// From a URL
const page = await renderPdfFromUrl('https://example.com/report', {
  format: 'A4',
  waitUntil: 'networkidle0',
});

// On graceful shutdown:
await closeBrowser();
```

## API

### `createPdfRenderPool(options?)`

Returns `{ renderPdf, renderPdfFromUrl, closeBrowser, stats }`.

```js
createPdfRenderPool({
  concurrency: 4,                // max renders at once (default 2)
  maxQueue: 100,                 // max renders waiting for a slot (default Infinity)
  idleTimeout: 5 * 60_000,       // close Chromium after 5 min without renders (default 0 = never)
  waitUntil: 'domcontentloaded', // default load event for every render
  assetTimeout: 3000,            // ms images/fonts get before being cancelled (default 3000)
  isolate: true,                 // fresh browser context per render (default true)
  puppeteerModule: 'puppeteer',  // or 'puppeteer-core'
  launchOptions: {               // merged over the sandbox-safe defaults
    executablePath: '/usr/bin/chromium',
  },
  onInfo: (msg) => console.log(msg),
  onWarn: (msg) => console.warn(msg),
});
```

Default launch flags (`--no-sandbox`, `--disable-setuid-sandbox`,
`--disable-dev-shm-usage`, `--disable-gpu`) target typical Linux
servers/containers where Chromium runs as non-root with a tiny `/dev/shm`.
Override them via `launchOptions`.

### `renderPdf(html, options?)` → `Promise<Buffer>`
### `renderPdfFromUrl(url, options?)` → `Promise<Buffer>`

`options` are forwarded to Puppeteer's
[`page.pdf()`](https://pptr.dev/api/puppeteer.pdfoptions) (`format`, `margin`,
`landscape`, `printBackground` — defaults to `true` — …) plus:

| Option | Default | Description |
|---|---|---|
| `timeout` | `30000` | One deadline (ms) for the whole render, including a browser launch if one is needed. |
| `waitUntil` | pool's `waitUntil` | `'domcontentloaded'`, `'load'`, `'networkidle0'` or `'networkidle2'`. |
| `assetTimeout` | pool's `assetTimeout` | With `'domcontentloaded'`: ms to let images/fonts finish before cancelling them (see below). |

### `closeBrowser()` → `Promise<void>`

Closes the pool's browser. Safe to call when it was never launched; the next
render launches a new one. Intentional closes don't trigger the crash warning.

### `stats()` → `{ active, queued }`

Renders currently running and waiting — handy for health checks and metrics.

### Errors

| `err.code` | When |
|---|---|
| `ETIMEDOUT` | Browser launch or page creation exceeded the `timeout` deadline. (Load and PDF steps throw Puppeteer's own `TimeoutError`.) |
| `EQUEUEFULL` | `maxQueue` renders were already waiting. |

## Benchmarks

One-page A4 report (inline CSS, 30-row table), measured with
[`bench/benchmark.js`](bench/benchmark.js) on an Intel i7-6500U laptop
(2 cores / 4 threads, 8 GB RAM), Windows 10, Node 24, Puppeteer 25.3.

| Job | Mean | p50 | p95 |
|---|---|---|---|
| Launch Chromium + render + close, per PDF (no pool) | 1862 ms | 1862 ms | 2190 ms |
| Pool, first render (includes browser launch) | 1690 ms | | |
| **Pool, warm render** (`isolate: true`, default) | **657 ms** | 625 ms | 885 ms |
| **Pool, warm render** (`isolate: false`) | **465 ms** | 442 ms | 667 ms |

A warm render is **~2.8× faster** than launching Chromium per PDF (~4× without
isolation). Per-render isolation costs ~190 ms on this machine.

**Burst of 40 simultaneous renders:**

| `concurrency` | Wall time | PDFs/s |
|---|---|---|
| 1 | 28.3 s | 1.4 |
| 2 | 31.8 s | 1.3 |
| 4 | 24.8 s | 1.6 |

Rendering is CPU-bound, so on a 2-core machine extra concurrency barely helps.
Set `concurrency` to roughly the cores you can spare, and use `maxQueue` to cap
latency instead.

**Other behaviour:**

- **Back-pressure** (`concurrency: 2`, `maxQueue: 5`, 20 simultaneous requests):
  7 rendered, 13 rejected immediately with `EQUEUEFULL`.
- **Image host that never responds:** 3.5 s with defaults (3 s `assetTimeout`,
  then print without it); 1.0 s with `assetTimeout: 500`; `waitUntil:
  'networkidle0'` fails with `TimeoutError` at the `timeout`.

Numbers vary with hardware and OS (Chromium usually launches faster on Linux);
run the benchmark on your own machine:

```bash
npm install --no-save puppeteer
node bench/benchmark.js
```

## Why domcontentloaded by default

HTML templates are expected to be self-contained (inline CSS). If a template
embeds a remote image and that host is slow or unreachable, waiting for
`networkidle0` would hang the whole render — and the shared concurrency slot
— until `timeout`. With `domcontentloaded`, the pool gives images and fonts up to
`assetTimeout` (default 3000 ms) to finish, then cancels whatever is still
pending (`window.stop()`) and prints. A slow logo still makes it into the PDF;
a dead one renders blank after at most `assetTimeout` instead of stalling the
pool. (Without the cancel, Puppeteer's `page.pdf()` would keep waiting on it.)
If your content must be complete, set `waitUntil: 'load'` or
`'networkidle0'` and the render fails on `timeout` rather than printing
without it.

## Multiple pools

Need independent concurrency budgets for different kinds of PDFs (e.g.
certificates vs. large reports)? Create more than one pool — each gets its
own browser instance and its own queue:

```js
const certPool = createPdfRenderPool({ concurrency: 4 });
const reportPool = createPdfRenderPool({ concurrency: 1, maxQueue: 10 });
```

## Used in production

[mcqplex.com](https://mcqplex.com) uses `pdf-render-pool` to render exam
reports, student report cards and competition certificates. The package was
extracted from its PDF renderer.

## License

MIT
