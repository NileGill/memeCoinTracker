// Types shared by the server and the web client. Import with `import type` only.

export type Window = 'm5' | 'h1' | 'h6' | 'h24';

export type TokenSource =
  | 'trending' // Jupiter / GeckoTerminal trending
  | 'traded' // Jupiter top traded
  | 'organic' // Jupiter top organic score
  | 'boosted' // DexScreener paid boosts
  | 'profile' // DexScreener new token profile
  | 'cto' // DexScreener community takeover
  | 'newpool' // GeckoTerminal new pools with real liquidity
  | 'launch' // fresh launch that is getting traction
  | 'graduated' // migrated off the pump.fun bonding curve
  | 'trader' // bought or sold by a watched trader
  | 'watch' // on a visitor's watchlist
  | 'search'; // opened by the user

export type FlagSeverity = 'info' | 'warn' | 'danger';

export interface TokenFlag {
  code: string;
  label: string;
  severity: FlagSeverity;
}

export interface ScoreParts {
  momentum: number; // -1..1
  flow: number; // -1..1 net buy pressure
  acceleration: number; // -1..1 volume pace vs the last hour
  participation: number; // 0..1 traders and net buyers
  quality: number; // 0..1 liquidity, organic activity, audit
  penalty: number; // points subtracted
}

export interface TokenView {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  decimals: number | null;
  priceUsd: number | null;
  mcap: number | null;
  fdv: number | null;
  liquidity: number | null;
  holders: number | null;
  createdAt: number | null; // ms epoch
  launchpad: string | null;
  dexId: string | null;
  pairAddress: string | null;
  change: Record<Window, number | null>;
  volume: Record<Window, number | null>;
  buyVolume: { m5: number | null; h1: number | null };
  sellVolume: { m5: number | null; h1: number | null };
  txns: { m5: { buys: number; sells: number } | null; h1: { buys: number; sells: number } | null };
  traders5m: number | null;
  netBuyers5m: number | null;
  netBuyers1h: number | null;
  holderChange1h: number | null;
  organicScore: number | null;
  organicLabel: string | null;
  verified: boolean;
  audit: {
    mintDisabled: boolean | null;
    freezeDisabled: boolean | null;
    topHoldersPct: number | null;
    devPct: number | null;
  };
  boosts: number | null;
  links: { website?: string; twitter?: string; telegram?: string };
  sources: TokenSource[];
  score: number | null; // null = not eligible for setups
  scoreParts: ScoreParts | null;
  flags: TokenFlag[];
  firstSeen: number;
}

export interface LaunchItem {
  mint: string;
  time: number;
  launchpad: string;
  creator: string | null;
  initialBuySol: number | null;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  mcapUsd: number | null;
  volume5m: number | null;
  holders: number | null;
  buys5m: number | null;
  traction: boolean;
}

export interface MigrationItem {
  mint: string;
  time: number;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  mcapUsd: number | null;
  pool: string | null;
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  published: number;
  summary: string;
  image: string | null;
  meme: boolean;
  tickers: string[];
}

export interface TraderView {
  address: string;
  label: string;
  source: 'manual' | 'kolscan';
  addedAt: number;
  alerts: boolean;
  status: 'pending' | 'ok' | 'noisy' | 'error';
  statusMessage: string | null;
  lastPoll: number | null;
  lastTradeAt: number | null;
  today: { buys: number; sells: number; solIn: number; solOut: number };
}

export interface TraderTrade {
  id: string; // tx signature
  trader: string;
  traderLabel: string;
  side: 'buy' | 'sell';
  mint: string;
  symbol: string | null;
  tokenAmount: number;
  quoteAmount: number;
  quote: 'SOL' | 'USD';
  usdValue: number | null;
  time: number;
  backfill: boolean;
}

export interface KolEntry {
  rank: number;
  address: string;
  name: string;
  wins: number;
  losses: number;
  profitSol: number;
  profitUsd: number;
}

export interface SourceStatus {
  id: string;
  label: string;
  ok: boolean;
  lastOk: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export type ServerEvent =
  | { type: 'traderTrade'; trade: TraderTrade }
  | {
      type: 'convergence';
      mint: string;
      symbol: string | null;
      traders: string[]; // labels
      time: number;
    }
  | { type: 'migration'; item: MigrationItem };

export interface MarketPayload {
  tokens: TokenView[];
  solPrice: number | null;
  launchesLastHour: number;
  graduationsLastHour: number;
  /** When the server started; tokens it discovered in its first minutes are not "new". */
  startedAt: number;
  time: number;
}

/** Sent every few seconds after the snapshot: only tokens that changed, plus removals. */
export interface MarketDelta {
  tokens: TokenView[];
  removed: string[];
  solPrice: number | null;
  launchesLastHour: number;
  graduationsLastHour: number;
  startedAt: number;
  time: number;
}

export interface Snapshot {
  /** Name of the built web bundle; an open tab running an older bundle reloads itself. */
  version: string | null;
  market: MarketPayload;
  launches: LaunchItem[];
  migrations: MigrationItem[];
  news: NewsItem[];
  traders: TraderView[];
  traderTrades: TraderTrade[];
  leaderboard: KolEntry[];
  leaderboardUpdated: number | null;
  status: SourceStatus[];
}

// Jupiter Ultra proxy shapes (subset of the fields the UI uses)
export interface UltraOrder {
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpact?: number;
  priceImpactPct?: string;
  slippageBps?: number;
  feeBps?: number;
  inUsdValue?: number;
  outUsdValue?: number;
  swapType?: string;
  routePlan?: { percent: number; swapInfo: { label?: string } }[];
  transaction: string | null;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

export interface UltraExecuteResult {
  status: 'Success' | 'Failed';
  signature?: string;
  code?: number;
  error?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

export interface Holding {
  mint: string;
  amountRaw: string;
  uiAmount: number;
  decimals: number;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface HoldingsResponse {
  address: string;
  sol: number;
  solValueUsd: number | null;
  tokens: Holding[];
  time: number;
}

export interface TokenDetail {
  token: TokenView;
  security: {
    rugcheckScore: number | null; // normalised 0-100, lower is safer
    rugcheckRisks: { name: string; level: string; description: string }[];
    lpLockedPct: number | null;
    shieldWarnings: { type: string; message: string; severity: string }[];
  };
  watchedTraderTrades: TraderTrade[];
}
