import { chunk, fetchJson, Limiter } from '../lib/http';

// Documented limits: 60 req/min for profile & boost lists, 300 req/min for pair lookups.
const listLimiter = new Limiter(1100);
const pairLimiter = new Limiter(220);

const API = 'https://api.dexscreener.com';

export interface DsListItem {
  chainId: string;
  tokenAddress: string;
  description?: string;
  icon?: string;
  links?: { type?: string; label?: string; url: string }[];
  totalAmount?: number;
  amount?: number;
}

export interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>>;
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  /** usd = the whole pool; base / quote = token amounts on each side. */
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string; label?: string }[];
    socials?: { url: string; type: string }[];
  };
  boosts?: { active?: number };
}

async function list(path: string): Promise<DsListItem[]> {
  const rows = await fetchJson<DsListItem[]>(`${API}${path}`, { limiter: listLimiter, backoffMs: 60_000 });
  return Array.isArray(rows) ? rows.filter((r) => r.chainId === 'solana' && r.tokenAddress) : [];
}

export const dsLatestProfiles = () => list('/token-profiles/latest/v1');
export const dsLatestBoosts = () => list('/token-boosts/latest/v1');
export const dsTopBoosts = () => list('/token-boosts/top/v1');
export const dsTakeovers = () => list('/community-takeovers/latest/v1');

/** The most liquid Solana pair for each mint (DexScreener returns one per token, 30 tokens per call). */
export async function dsPairs(mints: string[]): Promise<Map<string, DsPair>> {
  const out = new Map<string, DsPair>();
  for (const part of chunk(mints, 30)) {
    const rows = await fetchJson<DsPair[]>(`${API}/tokens/v1/solana/${part.join(',')}`, {
      limiter: pairLimiter,
      backoffMs: 30_000,
    });
    if (!Array.isArray(rows)) continue;
    for (const p of rows) {
      const mint = p.baseToken?.address;
      if (!mint || p.chainId !== 'solana') continue;
      const prev = out.get(mint);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(mint, p);
    }
  }
  return out;
}
