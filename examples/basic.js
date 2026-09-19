// node examples/basic.js
// Requires: npm install puppeteer
'use strict';

const fs = require('node:fs');
const { createPdfRenderPool } = require('../src/index.js');

async function main() {
  const { renderPdf, closeBrowser } = createPdfRenderPool({ concurrency: 2 });

  const html = `
    <html>
      <body style="font-family: sans-serif;">
        <h1>Hello from pdf-render-pool</h1>
        <p>Rendered at ${new Date().toISOString()}</p>
      </body>
    </html>
  `;

  const pdf = await renderPdf(html, { format: 'A4' });
  fs.writeFileSync('output.pdf', pdf);
  console.log('Wrote output.pdf');

  await closeBrowser();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
