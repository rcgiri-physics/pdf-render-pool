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

[Project page](https://rcgiri-physics.github.io/pdf-render-pool/) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Guarantees

- **Concurrency-capped** — at most `concurrency` renders run at once (default 2); the rest queue FIFO.
- **Back-pressure** — optionally cap the queue (`maxQueue`) so overload fails fast with `EQUEUEFULL` instead of piling up.
- **Bounded** — once a render has a slot, one `timeout` deadline covers browser launch, page creation, content load and PDF generation, even if the page is stuck in a script loop. Time spent queued is limited separately by `queueTimeout`.
- **Self-healing** — a browser that crashes, hangs while launching or stops opening pages is replaced. Renders running on a crashed browser fail with `EBROWSERCRASHED` unless you set `retries`.
- **Isolated** — every render runs in its own browser context (separate cookies, localStorage and cache), always closed afterwards, so renders can't leak pages or state into each other. Opt out with `isolate: false`.
- **Memory-friendly** — optionally close the browser when idle (`idleTimeout`), or recycle it after N renders (`maxRendersPerBrowser`) without interrupting renders in flight.

## Install

```bash
npm install pdf-render-pool puppeteer
```

Requires Node 20+ and Puppeteer 22+. Upgrading from 0.2? See the [changelog](CHANGELOG.md).

`puppeteer` is a peer dependency — bring your own version (or `puppeteer-core`
with an explicit `executablePath`, see below) so this package doesn't force a
particular Chromium download strategy on you. No other runtime dependencies.

## Usage

```js
const { createPdfRenderPool } = require('pdf-render-pool');
// or: import { createPdfRenderPool } from 'pdf-render-pool';

// Create the pool ONCE per process and reuse it everywhere — it holds one
// persistent browser instance.
const { renderPdf, renderPdfFromUrl, close } = createPdfRenderPool();

// From an HTML string
const invoice = await renderPdf('<h1>Invoice #42</h1>', { format: 'A4' });

// From a URL
const page = await renderPdfFromUrl('https://example.com/report', {
  format: 'A4',
  waitUntil: 'networkidle0',
});

// On graceful shutdown (finishes running and queued renders first):
await close();
```

## API

### `createPdfRenderPool(options?)`

Returns `{ renderPdf, renderPdfFromUrl, renderPdfStream, renderPdfStreamFromUrl, closeBrowser, close, stats }`. Invalid options throw a `RangeError`.

```js
createPdfRenderPool({
  concurrency: 4,                // max renders at once (default 2)
  maxQueue: 100,                 // max renders waiting for a slot (default Infinity)
  queueTimeout: 10_000,          // max ms to wait for a slot (default Infinity)
  idleTimeout: 5 * 60_000,       // close Chromium after 5 min without renders (default 0 = never)
  maxRendersPerBrowser: 500,     // recycle Chromium after 500 renders (default 0 = never)
  launchTimeout: 30_000,         // abandon a browser launch after this long (default 30000)
  retries: 1,                    // retry a render after a browser crash (default 0)
  waitUntil: 'domcontentloaded', // default load event for every render
  assetTimeout: 3000,            // ms images/fonts get before being cancelled (default 3000)
  isolate: true,                 // fresh browser context per render (default true)
  sandbox: false,                // keep Chromium's sandbox on (default false, see Security)
  allowFileUrls: false,          // allow file: URLs in renderPdfFromUrl (default false)
  allowHttpErrors: false,        // print pages with status >= 400 (default false)
  requestFilter: (url) => true,  // allow or block each request the page makes
  beforeRender: async (page) => {}, // runs on each page before content loads
  puppeteerModule: 'puppeteer',  // or 'puppeteer-core'
  launchOptions: {               // merged over the sandbox-safe defaults
    executablePath: '/usr/bin/chromium',
  },
  onInfo: (msg) => console.log(msg),
  onWarn: (msg) => console.warn(msg),
  onEvent: (event) => {},        // { type: 'launch' | 'crash' | 'recycle' | 'retry' | 'idle-close' }
});
```

Default launch flags (`--no-sandbox`, `--disable-setuid-sandbox`,
`--disable-dev-shm-usage`, `--disable-gpu`) target typical Linux
servers/containers where Chromium runs with a tiny `/dev/shm`. Override them via
`launchOptions`, and read [Security](#security) about the sandbox flags.

`maxRendersPerBrowser` caps how many renders one Chromium serves. Once it is
reached, new renders go to a freshly launched browser and the old one closes
after its in-flight renders finish, so recycling never interrupts a render.

### `renderPdf(html, options?)` → `Promise<Buffer>`
### `renderPdfFromUrl(url, options?)` → `Promise<Buffer>`

`options` are forwarded to Puppeteer's
[`page.pdf()`](https://pptr.dev/api/puppeteer.pdfoptions) (`format`, `margin`,
`landscape`, `printBackground` — defaults to `true` — …) plus:

| Option | Default | Description |
|---|---|---|
| `timeout` | `30000` | One deadline (ms) for the render, from when it gets a slot, including a browser launch and any retries. |
| `queueTimeout` | pool's `queueTimeout` | Max ms to wait for a slot. |
| `signal` | | `AbortSignal` that cancels the render, queued or running. |
| `retries` | pool's `retries` | Retries after a browser crash, within the same `timeout`. |
| `beforeRender` | pool's `beforeRender` | `async (page) => {}` before content loads: cookies, auth headers, viewport, `emulateMediaType`. |
| `waitForSelector` | | Wait for this selector after loading, before printing. |
| `waitForFunction` | | Wait for this page expression to be truthy before printing. |
| `requestFilter` | pool's `requestFilter` | `(url, request) => boolean`. Anything but a truthy answer blocks the request. |
| `allowHttpErrors` | pool's `allowHttpErrors` | URL renders only: print pages with status 400 or above instead of rejecting. |
| `waitUntil` | pool's `waitUntil` | `'domcontentloaded'`, `'load'`, `'networkidle0'` or `'networkidle2'`. |
| `assetTimeout` | pool's `assetTimeout` | With `'domcontentloaded'`: ms to let images/fonts finish before cancelling them (see below). |

### `renderPdfStream(html, options?)` → `Promise<Readable>`
### `renderPdfStreamFromUrl(url, options?)` → `Promise<Readable>`

For large PDFs. The render keeps its slot until the stream is read or destroyed,
and `timeout` still applies, so read it promptly.

### `close({ drain = true, timeout = Infinity }?)` → `Promise<void>`

Use this at process shutdown. New renders reject with `ECLOSED`, running and
queued renders finish (for at most `timeout` ms), then the browser closes. With
`drain: false` they fail with `ECLOSED` straight away. The pool can't be reused.
Also available as `await using pool = createPdfRenderPool()`.

### `closeBrowser()` → `Promise<void>`

Closes the current browser now, failing renders that are using it. The pool stays
usable: queued and later renders launch a new browser. Safe to call when none was
launched.

### `stats()`

Returns `{ active, queued, browser, closed, completed, failed, launches, crashes, recycles }`,
where `browser` is `'none'`, `'launching'` or `'ready'`. Handy for health checks and metrics.

### Errors

| `err.code` | When |
|---|---|
| `ETIMEDOUT` | The render exceeded `timeout`, or a launch exceeded `launchTimeout`. |
| `EQUEUEFULL` | `maxQueue` renders were already waiting. |
| `EQUEUETIMEOUT` | The render waited longer than `queueTimeout` for a slot. |
| `EHTTPSTATUS` | The URL responded with status 400 or above. See `err.status`. |
| `EBLOCKEDURL` | The URL's protocol isn't allowed. |
| `EBROWSERCRASHED` | Chromium died during the render. See `err.cause`. |
| `ELAUNCH` | Chromium failed to start. |
| `ECLOSED` | The pool or browser was closed. |
| `ABORT_ERR` | The render's `signal` was aborted. |

## Security

Rendered HTML runs in a real browser on your server. **If a user can influence the
HTML or URL, even through a name on a certificate, treat it as untrusted:**

- **Internal network access (SSRF).** Pages can request anything your server can
  reach, such as localhost services or cloud metadata endpoints. Escape user values
  in templates and use `requestFilter` to allow only the hosts you expect. A filter
  that checks hostnames doesn't stop DNS rebinding, so also restrict outbound
  traffic at the network level if the risk matters to you.
- **The sandbox is off by default.** `--no-sandbox` lets Chromium start on typical
  servers and containers, but a browser exploit would then reach your whole user
  account. Set `sandbox: true` where your system supports it, and run in a container
  as a non-root user.
- **Local files.** `renderPdfFromUrl` refuses `file:` URLs unless you set
  `allowFileUrls`.
- **Scripts.** If you don't need them, turn them off:
  `beforeRender: (page) => page.setJavaScriptEnabled(false)`.

## Deploying

Call `close()` on shutdown:

```js
process.on('SIGTERM', async () => {
  server.close();
  await pool.close({ timeout: 10_000 });
  process.exit(0);
});
```

In Express, stop rendering when the client leaves, and return 503 under overload:

```js
app.get('/report.pdf', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const pdf = await pool.renderPdf(reportHtml(), { format: 'A4', signal: controller.signal });
    res.type('application/pdf').send(pdf);
  } catch (err) {
    if (err.code === 'ABORT_ERR') return;
    res.sendStatus(err.code === 'EQUEUEFULL' || err.code === 'EQUEUETIMEOUT' ? 503 : 500);
  }
});
```

Slim Linux images usually lack Chromium's libraries and fonts. On Debian or Ubuntu,
install `fonts-noto` and `fonts-noto-color-emoji` or the PDF may show empty boxes,
and see Puppeteer's [Docker guide](https://pptr.dev/guides/docker) for the libraries.

## When to use something else

- **[Gotenberg](https://github.com/gotenberg/gotenberg)** if you want a separate
  Docker service, or need Office conversion, merging or PDF/A.
- **[puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)** for
  crawling or general browser jobs rather than just PDFs.
- **[browserless](https://github.com/browserless/browserless)** for hosted or shared
  browsers used from many services.

This package fits when you want PDFs from inside a Node process with no extra service.

## Benchmarks

These were measured on v0.2.x and have not been rerun on 0.3.0.

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

### Memory under sustained load

[`bench/memory.js`](bench/memory.js): 3,000 renders of a heavy page (400-row
table + SVG chart), concurrency 2, total memory of all Chromium processes
(same laptop, Windows):

| | Start | After 3,000 renders | Peak |
|---|---|---|---|
| One warm browser, no recycling | 367 MB | 375 MB | 377 MB |
| `maxRendersPerBrowser: 500` | 360 MB | back to baseline at each recycle | 371 MB |

Closing each render's isolated context frees almost everything it used, so a
warm browser stays nearly flat. `maxRendersPerBrowser` is a safety valve for
pages that do grow Chromium's memory; every render succeeded across recycles.

```bash
node bench/memory.js [renders=3000] [maxRendersPerBrowser=500]
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
To wait for something specific, such as a chart, use `waitForSelector` or
`waitForFunction`. If your content must be complete, set `waitUntil: 'load'` or
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

## Upgrading from 0.2

- Node 20+ and Puppeteer 22+ are required.
- `renderPdfFromUrl` rejects status 400 and above with `EHTTPSTATUS`. Set `allowHttpErrors: true` to print those pages.
- `file:` URLs need `allowFileUrls: true`, and other non-HTTP URLs are refused.
- Invalid options and input now throw, including `timeout: 0`.
- Replace `closeBrowser()` with `close()` in shutdown code.
- Puppeteer's timeout errors now also have `code: 'ETIMEDOUT'`.

## Development

```bash
npm ci
npm test
npm run test:integration
```

`npm test` uses a fake browser; `test:integration` uses real Chromium.

To release, update the version and changelog, then push a `vX.Y.Z` tag. The release workflow publishes to npm using the `NPM_TOKEN` repository secret.

## Used in production

[mcqplex.com](https://mcqplex.com) uses `pdf-render-pool` to render exam
reports, student report cards and competition certificates. The package was
extracted from its PDF renderer.

## License

MIT
