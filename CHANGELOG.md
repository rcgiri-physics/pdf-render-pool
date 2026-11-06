# Changelog

## 0.3.0

### Breaking

- `renderPdfFromUrl` rejects HTTP status 400 and above with `EHTTPSTATUS`, where it used to print the error page. Use `allowHttpErrors: true` for the old behaviour.
- `renderPdfFromUrl` only accepts `http:` and `https:` URLs (`EBLOCKEDURL` otherwise). Use `allowFileUrls: true` to allow `file:`.
- Invalid options and input now throw (`concurrency: 'abc'`, `timeout: 0`, `renderPdf(undefined)`) instead of being silently adjusted.
- Puppeteer 22 or newer and Node 20 or newer are required. Older Puppeteer versions lacked `browser.connected`, which caused a new browser per render.
- Puppeteer `TimeoutError`s now also carry `code: 'ETIMEDOUT'`.

### Fixed

- `timeout` now holds at every step, including pages stuck in a script loop and cleanup that hangs.
- A browser that hangs while launching or stops opening pages is replaced, where before every later render failed.
- `closeBrowser()` no longer hangs on a stuck launch or browser.

### Added

- `close({ drain, timeout })` for shutdown, and `Symbol.asyncDispose`. Queued renders no longer start a new browser after shutdown.
- `sandbox`, `allowFileUrls`, `requestFilter` for handling untrusted content.
- `beforeRender`, `waitForSelector`, `waitForFunction`.
- `signal` (AbortSignal), `queueTimeout`, `launchTimeout`, `retries`.
- `renderPdfStream` and `renderPdfStreamFromUrl`.
- Error codes `ECLOSED`, `ELAUNCH`, `EBROWSERCRASHED`, `EQUEUETIMEOUT`, `ABORT_ERR`.
- `stats()` reports browser state and totals; `onEvent` reports lifecycle events.
- Separate ESM type declarations.
- Tests against real Chromium, run in CI on the oldest and newest supported Puppeteer.

## 0.2.2

- `maxRendersPerBrowser` recycling and a memory benchmark.

## 0.2.0

- Per-render isolation, URL input, idle shutdown, `maxQueue`, ESM entry point.
