/**
 * Memory under sustained load: total Chromium memory (all processes) sampled
 * every N renders, with and without maxRendersPerBrowser.
 *
 *   npm install --no-save puppeteer
 *   node bench/memory.js [renders=3000] [maxRendersPerBrowser=500]
 *
 * PUPPETEER_PATH=/abs/path/to/node_modules/puppeteer reuses an existing install.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPdfRenderPool } = require('../src');

const PUPPETEER = process.env.PUPPETEER_PATH || 'puppeteer';
const RENDERS = Number(process.argv[2]) || 3000;
const RECYCLE = Number(process.argv[3]) || 500;
const SAMPLE_EVERY = Math.max(1, Math.floor(RENDERS / 15));

// A heavier page than benchmark.js: big table, SVG chart, web-font-ish CSS.
const rows = Array.from({ length: 400 }, (_, i) =>
  `<tr><td>${i + 1}</td><td>Question ${i + 1} ${'lorem ipsum '.repeat(4)}</td><td>${(i * 7) % 4 ? 'Correct' : 'Wrong'}</td><td>${(i * 13) % 60}s</td></tr>`
).join('');
const bars = Array.from({ length: 200 }, (_, i) =>
  `<rect x="${i * 4}" y="${200 - ((i * 37) % 180)}" width="3" height="${(i * 37) % 180}" fill="hsl(${i},60%,50%)"/>`
).join('');
const html = (n) => `<!doctype html><html><head><style>
body{font-family:Georgia,serif;margin:24px}table{border-collapse:collapse;width:100%}
td{border:1px solid #ccc;padding:4px 8px;font-size:11px}</style></head>
<body><h1>Report #${n}</h1><svg width="800" height="200">${bars}</svg><table>${rows}</table></body></html>`;

// Sum resident memory of every process launched with our profile dir.
function chromiumMemoryMB(marker) {
  if (process.platform === 'win32') {
    const ps = `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object WorkingSetSize -Sum).Sum`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim();
    return (Number(out) || 0) / 1048576;
  }
  const out = execFileSync('ps', ['-eo', 'rss=,args=']).toString();
  return out.split('\n').filter((l) => l.includes(marker))
    .reduce((kb, l) => kb + (parseInt(l, 10) || 0), 0) / 1024;
}

async function run(label, maxRendersPerBrowser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prp-mem-'));
  const pool = createPdfRenderPool({
    puppeteerModule: PUPPETEER,
    concurrency: 2,
    maxRendersPerBrowser,
    launchOptions: { userDataDir: dir },
  });
  const samples = [];
  const t0 = Date.now();
  for (let i = 1; i <= RENDERS; i++) {
    await pool.renderPdf(html(i));
    if (i % SAMPLE_EVERY === 0) samples.push([i, chromiumMemoryMB(path.basename(dir))]);
  }
  await pool.closeBrowser();
  fs.rmSync(dir, { recursive: true, force: true });
  const mb = samples.map((s) => s[1]);
  console.log(`\n${label} — ${RENDERS} renders in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const [i, m] of samples) console.log(`  after ${String(i).padStart(6)}: ${m.toFixed(0).padStart(5)} MB`);
  console.log(`  first ${mb[0].toFixed(0)} MB, last ${mb[mb.length - 1].toFixed(0)} MB, peak ${Math.max(...mb).toFixed(0)} MB`);
}

(async () => {
  console.log(`Chromium memory, ${os.platform()} ${os.arch()}, node ${process.version}`);
  await run('No recycling', 0);
  await run(`maxRendersPerBrowser: ${RECYCLE}`, RECYCLE);
})().catch((e) => { console.error(e); process.exit(1); });
