export interface PdfRenderPoolOptions {
  concurrency?: number;
  puppeteerModule?: string;
  launchOptions?: Record<string, any>;
  onInfo?: (msg: string) => void;
  onWarn?: (msg: string) => void;
}

export interface PdfOptions {
  timeout?: number;
  [key: string]: any; // any puppeteer page.pdf() option
}

export interface PdfRenderPool {
  renderPdf(html: string, options?: PdfOptions): Promise<Buffer>;
  closeBrowser(): Promise<void>;
}

export function createPdfRenderPool(options?: PdfRenderPoolOptions): PdfRenderPool;
