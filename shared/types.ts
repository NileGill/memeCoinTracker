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
  /** The trained model's read on this coin; null until a model exists. */
  ai: AiSignal | null;
}

// ---- AI model

export interface AiTarget {
  /** Take profit, % above the entry price. */
  tp: number;
  /** Stop loss, % below the entry price. */
  sl: number;
  /** Sell after this many minutes if neither was hit. */
  holdMin: number;
}

export interface AiSignal {
  /** How often trades in coins rated like this made money after fees in testing, 0-1. */
  win: number;
  /** Average result of those test trades after fees, in % (null when too few to say). */
  ev: number | null;
  /** Chance it crashes 50%+ (or its price vanishes) within the hour, 0-1 (null without a crash model). */
  risk: number | null;
  /**
   * Picked at its latest 10-minute check, which is when the bot buys. Only ever true while the bot
   * is following the AI.
   */
  pick: boolean;
}

export interface AiDriver {
  label: string;
  /** Push on the model's score: positive helps, negative hurts. */
  impact: number;
}

export interface StrategyResult {
  trades: number;
  winRate: number; // 0-1
  avgReturn: number; // % per trade after fees
  totalReturn: number; // sum of per-trade % returns
  profitFactor: number | null;
}

export interface MlModelInfo {
  version: number; // when it was trained (ms epoch)
  target: AiTarget;
  /** Rows used to learn / to tune / to test. */
  trainRows: number;
  tuneRows: number;
  testRows: number;
  tokens: number;
  dataFrom: number;
  dataTo: number;
  /** Test period, which the model never saw while learning. */
  testFrom: number;
  testTo: number;
  /** 0.5 = coin flip, 1 = perfect ranking. */
  auc: number;
  /** Share of all test snapshots that hit the target (what random picks would get). */
  baseRate: number;
  /** Trades the bot would have taken in the test period. */
  test: StrategyResult;
  /** The same test period traded on the plain MemeRadar score, for comparison. */
  baseline: (StrategyResult & { threshold: number }) | null;
  /** The score plus the crash filter (what the bot trades before the AI is proven). */
  scoreFiltered: (StrategyResult & { threshold: number }) | null;
  /** The second model, which spots coins about to crash 50%+ (rugs, dumps). */
  crash: {
    /** Ranking skill on the test period (0.5 = coin flip). */
    auc: number;
    /** Share of test snapshots that crashed. */
    rate: number;
    /** Crash chance above which the AI bot skips a coin (null = no filter needed). */
    maxRisk: number | null;
  } | null;
  proven: boolean;
  /** Plain-English reasons when not proven. */
  problems: string[];
  topFeatures: { label: string; importance: number }[];
  /**
   * Every exit the trainer tried (target, stop, hold), with the rule the tuning period chose for it and
   * how that rule did in the test. For seeing what works; the choice never looks at these test results.
   * Missing in models trained before 2026-10-08.
   */
  options?: { tp: number; sl: number; holdMin: number; tune: StrategyResult; test: StrategyResult; chosen: boolean }[];
}

export interface MlStatus {
  state: 'collecting' | 'training' | 'ready' | 'unproven';
  message: string;
  /** Finished coin snapshots available to learn from (outcome known). */
  samples: number;
  /** Snapshots still waiting for their outcome. */
  pending: number;
  /** Snapshots saved in total since recording started, including older ones kept in storage. */
  stored: number | null;
  dataFrom: number | null;
  trainedAt: number | null;
  nextTrainingAt: number | null;
  model: MlModelInfo | null;
  /** The bot follows the AI right now: proven, and retrained recently enough to trust. */
  following: boolean;
  /** The most recent training attempt (null before the first one since the server started). */
  lastAttempt: { at: number; seconds: number; ok: boolean; note: string | null; detail?: string } | null;
  /** How the AI's actual picks have done since they started being recorded (null until computed). */
  live: MlLiveRecord | null;
}

export interface MlLiveSummary {
  trades: number;
  winRate: number;
  /** % per trade after fees. */
  avgReturn: number;
}

/**
 * The AI's live picks, each followed exactly like a test trade (results arrive an hour after the
 * pick). `recent` is the latest picks; when they're `losing`, the bot stops following the AI.
 */
export interface MlLiveRecord extends MlLiveSummary {
  from: number | null;
  totalReturn: number;
  last24h: MlLiveSummary;
  recent: MlLiveSummary;
  losing: boolean;
  /** The last 24 hours, oldest first. */
  hours: MlLiveHour[];
}

/** One hour of the AI's activity. */
export interface MlLiveHour {
  /** Start of the hour. */
  at: number;
  /** Coins checked (10-minute snapshots). */
  snapshots: number;
  /** Of those, taken while a proven, up-to-date AI was in use (0 = the bot wasn't following any AI). */
  followed: number;
  /** Coins the AI picked; of those, with $20K+ liquidity, and whose price ran past the slippage limit before a buy could land. */
  picks: number;
  deep: number;
  ran: number;
  /** The live record had paused the bot by the end of the hour. */
  paused: boolean;
  /** Every snapshot from this hour has finished its hour of following (later hours are still filling in). */
  complete: boolean;
  /** The AI's decisions were being recorded by then (false for hours before that started). */
  tracked: boolean;
}

// ---- Paper trading bot

export interface PaperSettings {
  /** Share of equity per trade, %. */
  sizePct: number;
  maxOpen: number;
  /** 'auto': use the model once proven, the score until then. 'model': only the proven model. */
  mode: 'auto' | 'model';
  scoreMin: number;
  minLiquidity: number;
  /** Never put more than this much SOL into one trade. */
  maxTradeSol: number;
  /** Never buy more than this % of a coin's pool liquidity (keeps slippage small). */
  maxPoolPct: number;
  paused: boolean;
}

export type PaperStrategy = 'model' | 'score';

export interface PaperPosition {
  id: string;
  mint: string;
  symbol: string;
  icon: string | null;
  openedAt: number;
  /** Price the buy filled at. */
  entryPrice: number;
  /**
   * Price when the coin was picked: the target and stop are measured from this, as in the AI's test.
   * Missing on positions opened before this existed (they use entryPrice).
   */
  refPrice?: number;
  qty: number;
  costSol: number;
  target: AiTarget;
  closeBy: number;
  strategy: PaperStrategy;
  /** Model win chance or MemeRadar score at entry. */
  signal: number;
  lastPrice: number;
  lastPriceAt: number;
  /** Pool liquidity (USD) when bought, and the latest reading. */
  entryLiquidity?: number;
  lastLiquidity?: number;
  /** The price reading at which the target was seen; the sale fills at the next reading. */
  tpSeenAt?: number;
  /** Buy placed but not filled yet: it fills at the next fresh price reading after `entrySeenAt`. */
  pending?: boolean;
  entrySeenAt?: number;
}

/** 'faded': the price reached the target but had fallen back by the time the sale landed. */
export type PaperExit = 'tp' | 'faded' | 'sl' | 'time' | 'manual' | 'gone' | 'reset';

export interface PaperTrade {
  id: string;
  mint: string;
  symbol: string;
  icon: string | null;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  reason: PaperExit;
  strategy: PaperStrategy;
  signal: number;
  entryLiquidity?: number;
  exitLiquidity?: number;
  /** The take-profit the trade aimed for (% above the buy price). */
  targetPct?: number;
  /** The price when the coin was picked, which the target and stop were measured from. */
  refPrice?: number;
}

export interface PaperBucket {
  trades: number;
  wins: number;
  pnlSol: number;
}

export interface PaperStats {
  closed: number;
  wins: number;
  winRate: number | null;
  pnlSol: number;
  pnlPct: number;
  avgTradePct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  feesSol: number;
}

export interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface PaperAccountView {
  createdAt: number;
  startBalance: number;
  cash: number;
  equity: number;
  settings: PaperSettings;
  positions: PaperPosition[];
  trades: PaperTrade[];
  stats: PaperStats;
  curve: [number, number][];
  /** The most profitable and the worst trades ever (not just recent ones). */
  bestTrades: PaperTrade[];
  worstTrades: PaperTrade[];
  /** Results split by why trades closed, and by strategy. */
  byReason: Partial<Record<PaperExit, PaperBucket>>;
  byStrategy: Partial<Record<PaperStrategy, PaperBucket>>;
  /** True when these results came from the old, too-generous fill model (before realistic slippage). */
  legacyFills: boolean;
  /** What the bot is doing right now, in plain English. */
  activity: string;
  readiness: ReadinessCheck[];
  updatedAt: number;
}

export type BotEvent =
  | { type: 'open'; position: PaperPosition }
  | { type: 'close'; trade: PaperTrade };

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
  ml: MlStatus;
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
  /** Why the model rates this coin the way it does (null without a model). */
  aiDrivers: AiDriver[] | null;
}

// ---- Accounts

export interface AuthUser {
  email: string;
  createdAt: number;
  /** Public address of a wallet the user proved they own (never a key). */
  wallet: string | null;
}

export interface SavedSwap {
  signature: string;
  time: number;
  side: 'buy' | 'sell';
  mint: string;
  symbol: string;
  inAmount: number;
  outAmount: number;
}

/** Everything synced to an account. */
export interface AccountData {
  settings?: Record<string, unknown>;
  watchlist?: string[];
  myTraders?: { address: string; label: string }[];
  swaps?: SavedSwap[];
}

export interface MeResponse {
  enabled: boolean;
  user: AuthUser | null;
  data?: AccountData;
  error?: string;
}
