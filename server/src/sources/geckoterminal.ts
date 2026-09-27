import { fetchJson, Limiter, num } from '../lib/http';

// Public API allows ~30 calls/min; we use a small fraction of that.
const limiter = new Limiter(2500);
const API = 'https://api.geckoterminal.com/api/v2/networks/solana';

interface GtPool {
  attributes: {
    address: string;
    name: string;
    pool_created_at?: string;
    reserve_in_usd?: string;
  };
  relationships: {
    base_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

export interface GtPoolSummary {
  mint: string;
  pool: string;
  dex: string;
  liquidity: number | null;
  createdAt: number | null;
}

async function pools(path: string): Promise<GtPoolSummary[]> {
  const res = await fetchJson<{ data?: GtPool[] }>(`${API}${path}`, {
    limiter,
    headers: { accept: 'application/json;version=20230302' },
    backoffMs: 60_000,
  });
  return (res.data ?? []).map((p) => ({
    mint: p.relationships.base_token.data.id.replace(/^solana_/, ''),
    pool: p.attributes.address,
    dex: p.relationships.dex.data.id,
    liquidity: num(p.attributes.reserve_in_usd),
    createdAt: p.attributes.pool_created_at ? Date.parse(p.attributes.pool_created_at) : null,
  }));
}

export const gtTrending = () => pools('/trending_pools?duration=5m');
export const gtNewPools = () => pools('/new_pools');
