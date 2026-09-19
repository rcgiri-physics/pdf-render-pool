# pdf-render-pool

A persistent, concurrency-capped headless-Chromium HTML→PDF renderer built on
[Puppeteer](https://pptr.dev/).

Launching and tearing down a full Chromium for every PDF costs ~1-2 seconds
and ~150-300MB of RSS. `pdf-render-pool` keeps **one browser warm** and gives
each render its own page — roughly a 10x speedup per PDF with a fraction of
the memory churn, plus a concurrency cap so a burst of PDF requests queues
instead of OOMing your server.

## Guarantees

- **Concurrency-capped** — at most `concurrency` renders run at once (default 2); the rest queue FIFO.
- **Crash-safe** — if Chromium dies mid-run, the next render transparently relaunches it.
- **Page-isolated** — every render gets a fresh page, always closed, so one bad render can't leak pages into the shared browser.

## Install

```bash
npm install pdf-render-pool puppeteer
```

`puppeteer` is a peer dependency — bring your own (or `puppeteer-core` with an
explicit `executablePath`, see below) so this package doesn't force a
particular Chromium download strategy on you.

## Usage

```js
const { createPdfRenderPool } = require('pdf-render-pool');

// Create the pool ONCE per process and reuse it everywhere — it holds one
// persistent browser instance.
const { renderPdf, closeBrowser } = createPdfRenderPool();

const html = '<html><body><h1>Invoice #42</h1></body></html>';
const pdfBuffer = await renderPdf(html, { format: 'A4' });

// On graceful shutdown:
await closeBrowser();
```

`options` passed to `renderPdf(html, options)` are forwarded to Puppeteer's
[`page.pdf()`](https://pptr.dev/api/puppeteer.pdfoptions) (`format`, `margin`,
`landscape`, `printBackground`, …) plus a `timeout` (ms, default 30000)
applied to both the content load and PDF generation steps.

## Options

```js
createPdfRenderPool({
  concurrency: 4,               // default 2
  puppeteerModule: 'puppeteer', // or 'puppeteer-core'
  launchOptions: {               // merged over the sandbox-safe defaults
    executablePath: '/usr/bin/chromium',
  },
  onInfo: (msg) => console.log(msg),
  onWarn: (msg) => console.warn(msg),
});
```

Default launch flags (`--no-sandbox`, `--disable-setuid-sandbox`,
`--disable-dev-shm-usage`, `--disable-gpu`) target typical Linux
servers/containers where Chromium runs as non-root without a tiny `/dev/shm`.
Override or extend them via `launchOptions`.

## Why domcontentloaded, not networkidle0

Your HTML is expected to be self-contained (inline CSS). If a template embeds
a remote image and that host is slow or unreachable, waiting for
`networkidle0` would hang the whole render — and the shared concurrency slot
— until `timeout`. `pdf-render-pool` waits for `domcontentloaded` instead: a
dead remote image just renders blank rather than stalling the pool.

## Multiple pools

Need independent concurrency budgets for different kinds of PDFs (e.g.
certificates vs. large reports)? Create more than one pool — each gets its
own browser instance and its own queue:

```js
const certPool = createPdfRenderPool({ concurrency: 4 });
const reportPool = createPdfRenderPool({ concurrency: 1 });
```

## License

MIT
