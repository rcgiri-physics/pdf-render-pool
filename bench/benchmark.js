/**
 * Benchmark: pdf-render-pool vs launching Chromium per PDF.
 *
 *   npm install --no-save puppeteer
 *   node bench/benchmark.js
 *
 * PUPPETEER_PATH=/abs/path/to/node_modules/puppeteer reuses an existing install.
 */
const http = require('http');
const os = require('os');
const { createPdfRenderPool } = require('../src');

const PUPPETEER = process.env.PUPPETEER_PATH || 'puppeteer';
const puppeteer = require(PUPPETEER);
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

// A realistic one-page report: inline CSS, a table, ~2 KB of text.
const rows = Array.from({ length: 30 }, (_, i) =>
  `<tr><td>${i + 1}</td><td>Question ${i + 1}</td><td>${(i * 7) % 4 ? 'Correct' : 'Wrong'}</td><td>${(i * 13) % 60}s</td></tr>`
).join('');
const HTML = `<!doctype html><html><head><style>
body{font-family:sans-serif;margin:24px}h1{color:#234}table{border-collapse:collapse;width:100%}
td{border:1px solid #ccc;padding:4px 8px;font-size:12px}</style></head>
<body><h1>Exam report</h1><table>${rows}</table></body></html>`;

const now = () => Number(process.hrtime.bigint()) / 1e6;
function summary(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: mean.toFixed(0), p50: pct(50).toFixed(0), p95: pct(95).toFixed(0), max: s[s.length - 1].toFixed(0) };
}
async function timed(fn) { const t = now(); await fn(); return now() - t; }

async function baselinePerRender(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await timed(async () => {
      const b = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
      const p = await b.newPage();
      await p.setContent(HTML, { waitUntil: 'domcontentloaded' });
      await p.pdf({ format: 'A4', printBackground: true });
      await b.close();
    }));
  }
  return out;
}

async function sequential(pool, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await timed(() => pool.renderPdf(HTML, { format: 'A4' })));
  return out;
}

async function burst(concurrency, total) {
  const pool = createPdfRenderPool({ concurrency, puppeteerModule: PUPPETEER });
  await pool.renderPdf(HTML); // warm up
  const lat = [];
  const wall = await timed(() => Promise.all(Array.from({ length: total }, () =>
    timed(() => pool.renderPdf(HTML, { format: 'A4' })).then((ms) => lat.push(ms)))));
  await pool.closeBrowser();
  return { concurrency, total, wallMs: wall.toFixed(0), pdfPerSec: (total / (wall / 1000)).toFixed(1), ...summary(lat) };
}

// Server whose image never answers — a dead school-logo host.
function deadAssetServer() {
  return new Promise((resolve) => {
    const srv = http.createServer(() => { /* never respond */ });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const results = { env: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0].model, cores: os.cpus().length, ramGB: (os.totalmem() / 2 ** 30).toFixed(1), puppeteer: require(`${PUPPETEER}/package.json`).version } };
  console.log(results.env);

  console.log('\n1. Baseline: launch + render + close per PDF');
  await baselinePerRender(1); // let OS caches settle
  results.baseline = summary(await baselinePerRender(10));
  console.log(results.baseline);

  console.log('\n2. Pool: cold first render (includes browser launch)');
  const pool = createPdfRenderPool({ puppeteerModule: PUPPETEER });
  results.cold = (await timed(() => pool.renderPdf(HTML, { format: 'A4' }))).toFixed(0);
  console.log(`${results.cold} ms`);

  console.log('\n3. Pool: warm sequential renders (isolate: true)');
  results.warmIsolated = summary(await sequential(pool, 50));
  console.log(results.warmIsolated);
  await pool.closeBrowser();

  console.log('\n4. Pool: warm sequential renders (isolate: false)');
  const shared = createPdfRenderPool({ isolate: false, puppeteerModule: PUPPETEER });
  await shared.renderPdf(HTML);
  results.warmShared = summary(await sequential(shared, 50));
  console.log(results.warmShared);
  await shared.closeBrowser();

  console.log('\n5. Burst of 40 simultaneous requests');
  results.burst = [];
  for (const c of [1, 2, 4]) { const r = await burst(c, 40); results.burst.push(r); console.log(r); }

  console.log('\n6. Back-pressure: maxQueue 5, 20 simultaneous requests');
  const bp = createPdfRenderPool({ concurrency: 2, maxQueue: 5, puppeteerModule: PUPPETEER });
  await bp.renderPdf(HTML);
  const settled = await Promise.allSettled(Array.from({ length: 20 }, () => bp.renderPdf(HTML)));
  results.backpressure = { ok: settled.filter((s) => s.status === 'fulfilled').length, rejected: settled.filter((s) => s.reason && s.reason.code === 'EQUEUEFULL').length };
  console.log(results.backpressure);
  await bp.closeBrowser();

  console.log('\n7. Dead image host (never responds)');
  const srv = await deadAssetServer();
  const deadHtml = HTML.replace('<h1>', `<img src="http://127.0.0.1:${srv.address().port}/logo.png" width="40"><h1>`);
  const dp = createPdfRenderPool({ puppeteerModule: PUPPETEER });
  await dp.renderPdf(HTML);
  results.deadAsset = {};
  results.deadAsset.domcontentloaded = (await timed(() => dp.renderPdf(deadHtml))).toFixed(0);
  results.deadAsset.assetTimeout500 = (await timed(() => dp.renderPdf(deadHtml, { assetTimeout: 500 }))).toFixed(0);
  const t = now();
  const nidle = await dp.renderPdf(deadHtml, { waitUntil: 'networkidle0', timeout: 10000 }).then(() => 'ok', (e) => e.name);
  results.deadAsset.networkidle0 = `${(now() - t).toFixed(0)} (${nidle})`;
  console.log(results.deadAsset);
  await dp.closeBrowser();
  srv.close(); srv.closeAllConnections?.();

  console.log('\n8. Relaunch after the browser goes away (idle close / crash path)');
  const cp = createPdfRenderPool({ puppeteerModule: PUPPETEER, onWarn: () => {} });
  await cp.renderPdf(HTML);
  await cp.closeBrowser();
  results.relaunch = (await timed(() => cp.renderPdf(HTML, { format: 'A4' }))).toFixed(0);
  console.log(`${results.relaunch} ms`);
  await cp.closeBrowser();

  console.log('\nJSON:\n' + JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
