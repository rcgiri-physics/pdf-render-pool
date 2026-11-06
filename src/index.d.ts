import type { Readable } from 'node:stream';
import type { HTTPRequest, Page, PDFOptions } from 'puppeteer';

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

export type ErrorCode =
  | 'ETIMEDOUT'
  | 'EQUEUEFULL'
  | 'EQUEUETIMEOUT'
  | 'ECLOSED'
  | 'ELAUNCH'
  | 'EBROWSERCRASHED'
  | 'EBLOCKEDURL'
  | 'EHTTPSTATUS'
  | 'ABORT_ERR';

/** Return true to allow a request. Anything else, or a throw, blocks it. */
export type RequestFilter = (url: string, request: HTTPRequest) => boolean | Promise<boolean>;

export interface PoolEvent {
  type: 'launch' | 'crash' | 'recycle' | 'retry' | 'idle-close';
  attempt?: number;
}

export interface PdfRenderPoolOptions {
  /** Max renders at once. Default 2. */
  concurrency?: number;
  /** Max renders waiting for a slot; beyond this, EQUEUEFULL. Default Infinity. */
  maxQueue?: number;
  /** Max ms to wait for a slot; beyond this, EQUEUETIMEOUT. Default Infinity. */
  queueTimeout?: number;
  /** Close the browser after this many idle ms. 0 = keep it open. Default 0. */
  idleTimeout?: number;
  /** Recycle Chromium after this many renders. 0 = never. Default 0. */
  maxRendersPerBrowser?: number;
  /** Abandon a browser launch after this many ms. Default 30000. */
  launchTimeout?: number;
  /** Times to retry a render after a browser crash. Default 0. */
  retries?: number;
  waitUntil?: WaitUntil | WaitUntil[];
  assetTimeout?: number;
  /** Fresh browser context per render. Default true. */
  isolate?: boolean;
  /** Keep Chromium's sandbox on. Default false. See "Security" in the README. */
  sandbox?: boolean;
  /** Allow file: URLs in renderPdfFromUrl. Default false. */
  allowFileUrls?: boolean;
  /** Print pages with HTTP status >= 400 instead of rejecting. Default false. */
  allowHttpErrors?: boolean;
  requestFilter?: RequestFilter;
  /** Runs on each new page before content loads. */
  beforeRender?: (page: Page) => void | Promise<void>;
  puppeteerModule?: string;
  launchOptions?: Record<string, any>;
  onInfo?: (msg: string) => void;
  onWarn?: (msg: string) => void;
  onEvent?: (event: PoolEvent) => void;
}

export interface PdfOptions extends Omit<PDFOptions, 'timeout'> {
  /** One deadline (ms) for the render, from when it gets a slot. Default 30000. */
  timeout?: number;
  queueTimeout?: number;
  retries?: number;
  waitUntil?: WaitUntil | WaitUntil[];
  assetTimeout?: number;
  allowHttpErrors?: boolean;
  requestFilter?: RequestFilter;
  beforeRender?: (page: Page) => void | Promise<void>;
  /** Wait for this selector after loading, before printing. */
  waitForSelector?: string;
  /** Wait for this page function or expression to be truthy before printing. */
  waitForFunction?: string | (() => unknown);
  /** Cancels the render, queued or running; rejects with ABORT_ERR. */
  signal?: AbortSignal;
}

export interface PdfRenderPoolStats {
  active: number;
  queued: number;
  browser: 'none' | 'launching' | 'ready';
  closed: boolean;
  completed: number;
  failed: number;
  launches: number;
  crashes: number;
  recycles: number;
}

export interface CloseOptions {
  /** Let running and queued renders finish first. Default true. */
  drain?: boolean;
  /** Max ms to drain. Default Infinity. */
  timeout?: number;
}

export interface PdfRenderPool {
  renderPdf(html: string, options?: PdfOptions): Promise<Buffer>;
  renderPdfFromUrl(url: string | URL, options?: PdfOptions): Promise<Buffer>;
  renderPdfStream(html: string, options?: PdfOptions): Promise<Readable>;
  renderPdfStreamFromUrl(url: string | URL, options?: PdfOptions): Promise<Readable>;
  /** Close the current browser now. The pool stays usable. */
  closeBrowser(): Promise<void>;
  /** Shut the pool down for good. */
  close(options?: CloseOptions): Promise<void>;
  stats(): PdfRenderPoolStats;
  [Symbol.asyncDispose](): Promise<void>;
}

export function createPdfRenderPool(options?: PdfRenderPoolOptions): PdfRenderPool;
