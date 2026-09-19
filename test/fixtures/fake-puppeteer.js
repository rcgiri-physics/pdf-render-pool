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
      pdf: async () => Buffer.from('%PDF-fake'),
      close: async () => {},
    }),
    once: (event, cb) => { listeners[event] = cb; },
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
