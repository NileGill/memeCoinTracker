import { config } from '../config';

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spaces requests out so a host never sees more than one call per `intervalMs`.
 * `backoff()` pushes every queued caller back after a 429.
 */
export class Limiter {
  private next = 0;
  constructor(private intervalMs: number) {}

  async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.intervalMs;
    if (slot > now) await sleep(slot - now);
  }

  backoff(ms: number) {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  limiter?: Limiter;
  /** Default backoff applied to the limiter on 429 when no Retry-After header is sent. */
  backoffMs?: number;
}

async function request(url: string, opts: FetchOptions): Promise<Response> {
  if (opts.limiter) await opts.limiter.take();
  const headers: Record<string, string> = {
    'user-agent': config.userAgent,
    accept: 'application/json, text/plain, */*',
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
  });
  if (res.status === 429 && opts.limiter) {
    const retry = Number(res.headers.get('retry-after'));
    opts.limiter.backoff(Number.isFinite(retry) && retry > 0 ? retry * 1000 : (opts.backoffMs ?? 15_000));
  }
  return res;
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(res.status, url, `invalid JSON: ${text.slice(0, 80)}`);
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await request(url, { ...opts, headers: { accept: 'text/html,application/xml,*/*', ...opts.headers } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, '');
  return text;
}

/** Like fetchJson but returns status + parsed body without throwing on 4xx (used by the trade proxy). */
export async function fetchJsonRaw(url: string, opts: FetchOptions = {}): Promise<{ status: number; data: unknown }> {
  const res = await request(url, opts);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) || `HTTP ${res.status}` };
  }
  return { status: res.status, data };
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return 'request timed out';
    return e.message;
  }
  return String(e);
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
