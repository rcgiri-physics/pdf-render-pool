// ESM entry point — re-exports the CommonJS implementation so both module
// systems share one copy of the code.
import cjs from './index.js';

export const { createPdfRenderPool } = cjs;
export default cjs;
