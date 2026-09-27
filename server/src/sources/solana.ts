import { config, SOL_MINT, USDC_MINT, USDT_MINT } from '../config';
import { fetchJson, Limiter } from '../lib/http';

// The public RPC allows ~10 calls per 10s per method. A private RPC (SOLANA_RPC_URL) can go much faster.
const spacing = config.customRpc ? 120 : 1150;
const limiters: Record<string, Limiter> = {
  getSignaturesForAddress: new Limiter(spacing),
  getTransaction: new Limiter(spacing),
};

let rpcId = 0;

async function rpc<T>(method: keyof typeof limiters, params: unknown[]): Promise<T> {
  const res = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(config.rpcUrl, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: ++rpcId, method, params },
    limiter: limiters[method],
    backoffMs: 12_000,
    timeoutMs: 20_000,
  });
  if (res.error) {
    if (res.error.code === 429 || /rate|too many/i.test(res.error.message)) limiters[method].backoff(12_000);
    throw new Error(`RPC ${method}: ${res.error.message}`);
  }
  return res.result as T;
}

export interface SigInfo {
  signature: string;
  err: unknown;
  blockTime: number | null;
}

export function getSignatures(address: string, opts: { limit: number; until?: string }) {
  const cfg: Record<string, unknown> = { limit: opts.limit, commitment: 'confirmed' };
  if (opts.until) cfg.until = opts.until;
  return rpc<SigInfo[]>('getSignaturesForAddress', [address, cfg]);
}

interface TokenBal {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString?: string };
}

export interface ParsedTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
  } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}

export function getTransaction(signature: string) {
  return rpc<ParsedTx | null>('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
  ]);
}

export interface SwapResult {
  side: 'buy' | 'sell';
  mint: string;
  tokenAmount: number;
  quoteAmount: number;
  quote: 'SOL' | 'USD';
}

const STABLES = new Set([USDC_MINT, USDT_MINT]);

/**
 * Reduce a transaction to "wallet bought/sold X of token for Y SOL/USD" using balance deltas.
 * Works across every DEX and aggregator because it only looks at what the wallet gained and lost.
 * Returns null for anything that isn't a single-token swap (transfers, airdrops, multi-token txs).
 */
export function parseSwap(tx: ParsedTx | null, wallet: string): SwapResult | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(wallet);

  let sol = 0;
  if (idx >= 0) {
    sol = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
    if (idx === 0) sol += tx.meta.fee / 1e9; // don't count the network fee as trade size
  }

  const deltas = new Map<string, number>();
  const add = (b: TokenBal, sign: 1 | -1) => {
    if (b.owner !== wallet) return;
    const ui = Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0);
    if (!Number.isFinite(ui)) return;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + sign * ui);
  };
  for (const b of tx.meta.preTokenBalances ?? []) add(b, -1);
  for (const b of tx.meta.postTokenBalances ?? []) add(b, 1);

  // Wrapped SOL counts as SOL.
  sol += deltas.get(SOL_MINT) ?? 0;
  deltas.delete(SOL_MINT);
  let usd = 0;
  for (const s of STABLES) {
    usd += deltas.get(s) ?? 0;
    deltas.delete(s);
  }

  const moved = [...deltas.entries()].filter(([, v]) => Math.abs(v) > 0);
  if (moved.length !== 1) return null;
  const [mint, amount] = moved[0];

  // Decide whether the trade was priced in SOL or a stablecoin.
  let quoteDelta = sol;
  let quote: 'SOL' | 'USD' = 'SOL';
  if (Math.abs(usd) > 0.5 && Math.abs(sol) < 0.02) {
    quoteDelta = usd;
    quote = 'USD';
  }

  if (amount > 0 && quoteDelta < 0) return { side: 'buy', mint, tokenAmount: amount, quoteAmount: -quoteDelta, quote };
  if (amount < 0 && quoteDelta > 0) return { side: 'sell', mint, tokenAmount: -amount, quoteAmount: quoteDelta, quote };
  return null;
}
