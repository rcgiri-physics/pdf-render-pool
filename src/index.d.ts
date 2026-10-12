export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

export interface PdfRenderPoolOptions {
  concurrency?: number;
  maxQueue?: number;
  idleTimeout?: number;
  waitUntil?: WaitUntil | WaitUntil[];
  assetTimeout?: number;
  isolate?: boolean;
  puppeteerModule?: string;
  launchOptions?: Record<string, any>;
  onInfo?: (msg: string) => void;
  onWarn?: (msg: string) => void;
}

export interface PdfOptions {
  timeout?: number;
  waitUntil?: WaitUntil | WaitUntil[];
  assetTimeout?: number;
  [key: string]: any; // any puppeteer page.pdf() option
}

export interface PdfRenderPoolStats {
  active: number;
  queued: number;
}

export interface PdfRenderPool {
  renderPdf(html: string, options?: PdfOptions): Promise<Buffer>;
  renderPdfFromUrl(url: string | URL, options?: PdfOptions): Promise<Buffer>;
  closeBrowser(): Promise<void>;
  stats(): PdfRenderPoolStats;
}

export function createPdfRenderPool(options?: PdfRenderPoolOptions): PdfRenderPool;
