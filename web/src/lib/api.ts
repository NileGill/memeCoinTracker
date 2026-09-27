import type { HoldingsResponse, TokenDetail, UltraExecuteResult, UltraOrder } from '../../../shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const d = data as { error?: string; errorMessage?: string } | null;
    throw new Error(d?.errorMessage || d?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export interface SearchResult {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  mcap: number | null;
  liquidity: number | null;
  verified: boolean;
}

export const api = {
  token: (mint: string) => request<TokenDetail>(`/api/token/${mint}`),
  search: (q: string) => request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
  watch: (mint: string) => request(`/api/watchlist`, { method: 'POST', body: JSON.stringify({ mint }) }),
  unwatch: (mint: string) => request(`/api/watchlist/${mint}`, { method: 'DELETE' }),
  addTrader: (address: string, label: string, source: 'manual' | 'kolscan' = 'manual') =>
    request(`/api/traders`, { method: 'POST', body: JSON.stringify({ address, label, source }) }),
  updateTrader: (address: string, patch: { label?: string; alerts?: boolean }) =>
    request(`/api/traders/${address}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeTrader: (address: string) => request(`/api/traders/${address}`, { method: 'DELETE' }),
  holdings: (address: string) => request<HoldingsResponse>(`/api/holdings/${address}`),
  order: (p: { inputMint: string; outputMint: string; amount: string; taker?: string }) => {
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount });
    if (p.taker) q.set('taker', p.taker);
    return request<UltraOrder>(`/api/swap/order?${q}`);
  },
  execute: (signedTransaction: string, requestId: string) =>
    request<UltraExecuteResult>(`/api/swap/execute`, {
      method: 'POST',
      body: JSON.stringify({ signedTransaction, requestId }),
    }),
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
