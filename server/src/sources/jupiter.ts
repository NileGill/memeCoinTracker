import { config } from '../config';
import { chunk, fetchJson, fetchJsonRaw, Limiter } from '../lib/http';

// Jupiter's free tier is rate limited per IP. Background polling uses its own
// limiter; trades use a separate one so a swap never waits behind data refreshes.
const dataLimiter = new Limiter(1300);
const tradeLimiter = new Limiter(250);

const headers = (): Record<string, string> => (config.jupiterKey ? { 'x-api-key': config.jupiterKey } : {});

interface JupStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  launchpad?: string;
  holderCount?: number;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  stats5m?: JupStats;
  stats1h?: JupStats;
  stats6h?: JupStats;
  stats24h?: JupStats;
  firstPool?: { id?: string; createdAt?: string };
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
  };
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  createdAt?: string;
  graduatedPool?: string;
  graduatedAt?: string;
  twitter?: string;
  website?: string;
  telegram?: string;
}

const base = () => config.jupiterBase;

/** Full token records for up to 100 mints per request. */
export async function jupTokens(mints: string[], lane: 'data' | 'trade' = 'data'): Promise<JupToken[]> {
  const out: JupToken[] = [];
  const limiter = lane === 'trade' ? tradeLimiter : dataLimiter;
  for (const part of chunk(mints, 100)) {
    const url = `${base()}/tokens/v2/search?query=${part.join(',')}`;
    const rows = await fetchJson<JupToken[]>(url, { limiter, headers: headers(), backoffMs: 30_000 });
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

/** Free-text search by name, symbol or mint (used by the UI search box). */
export async function jupSearch(query: string): Promise<JupToken[]> {
  const url = `${base()}/tokens/v2/search?query=${encodeURIComponent(query)}`;
  const rows = await fetchJson<JupToken[]>(url, { limiter: tradeLimiter, headers: headers() });
  return Array.isArray(rows) ? rows : [];
}

export type JupList = 'toptrending' | 'toptraded' | 'toporganicscore';

export async function jupList(list: JupList, interval: '5m' | '1h' | '6h' | '24h', limit = 50): Promise<JupToken[]> {
  const url = `${base()}/tokens/v2/${list}/${interval}?limit=${limit}`;
  const rows = await fetchJson<JupToken[]>(url, { limiter: dataLimiter, headers: headers(), backoffMs: 30_000 });
  return Array.isArray(rows) ? rows : [];
}

export async function jupRecent(): Promise<JupToken[]> {
  const rows = await fetchJson<JupToken[]>(`${base()}/tokens/v2/recent`, {
    limiter: dataLimiter,
    headers: headers(),
    backoffMs: 30_000,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function jupPrices(mints: string[]): Promise<Record<string, number>> {
  const url = `${base()}/price/v3?ids=${mints.join(',')}`;
  const data = await fetchJson<Record<string, { usdPrice?: number } | null>>(url, {
    limiter: dataLimiter,
    headers: headers(),
    backoffMs: 30_000,
  });
  const out: Record<string, number> = {};
  for (const [mint, v] of Object.entries(data ?? {})) {
    if (v && typeof v.usdPrice === 'number') out[mint] = v.usdPrice;
  }
  return out;
}

export async function jupShield(mint: string) {
  const url = `${base()}/ultra/v1/shield?mints=${mint}`;
  const data = await fetchJson<{ warnings?: Record<string, { type: string; message: string; severity: string }[]> }>(
    url,
    { limiter: tradeLimiter, headers: headers() },
  );
  return data.warnings?.[mint] ?? [];
}

// ---- Ultra swap API (proxied so an API key, if configured, stays on the server) ----

export function ultraOrder(params: { inputMint: string; outputMint: string; amount: string; taker?: string }) {
  const q = new URLSearchParams({ inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount });
  if (params.taker) q.set('taker', params.taker);
  return fetchJsonRaw(`${base()}/ultra/v1/order?${q}`, { limiter: tradeLimiter, headers: headers(), timeoutMs: 15_000 });
}

export function ultraExecute(signedTransaction: string, requestId: string) {
  return fetchJsonRaw(`${base()}/ultra/v1/execute`, {
    method: 'POST',
    body: { signedTransaction, requestId },
    limiter: tradeLimiter,
    headers: headers(),
    timeoutMs: 60_000,
  });
}

export interface UltraHoldings {
  amount?: string;
  uiAmount?: number;
  tokens?: Record<string, { account: string; amount: string; uiAmount: number; decimals: number; isFrozen?: boolean }[]>;
}

export async function ultraHoldings(address: string): Promise<UltraHoldings> {
  return fetchJson<UltraHoldings>(`${base()}/ultra/v1/holdings/${address}`, {
    limiter: tradeLimiter,
    headers: headers(),
  });
}
