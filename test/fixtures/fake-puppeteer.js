'use strict';

// A minimal fake of the puppeteer API surface createPdfRenderPool touches,
// so tests can exercise pooling/concurrency/relaunch logic without a real
// Chromium download.
let launchCount = 0;

function makeBrowser() {
  const listeners = {};
  return {
    connected: true,
    newPage: async () => ({
      setContent: async () => {},
      evaluate: async () => {},
      pdf: async () => Buffer.from('%PDF-fake'),
      close: async () => {},
    }),
    once: (event, cb) => { listeners[event] = cb; },
    createBrowserContext: async function () { this.contextsCreated = (this.contextsCreated || 0) + 1; const ctx = { newPage: this.newPage, close: async () => { ctx.closed = true; } }; (this.contexts = this.contexts || []).push(ctx); return ctx; },
    close: async () => {},
    _emitDisconnected: () => listeners.disconnected && listeners.disconnected(),
  };
}

module.exports = {
  launch: async () => {
    launchCount += 1;
    return makeBrowser();
  },
  get launchCount() {
    return launchCount;
  },
  resetLaunchCount() {
    launchCount = 0;
  },
};
