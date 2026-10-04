/**
 * Settings for the learning pipeline. ML_FAST=1 shrinks every timescale from hours to minutes
 * so the whole loop (record -> outcome -> train -> trade) can be exercised locally; fast-mode
 * data is tagged with its own schema id and model key so it never mixes with real data.
 */
const fast = process.env.ML_FAST === '1';
const scale = fast ? 0.1 : 1; // fast mode uses 10x smaller price moves so outcomes happen within minutes

export const ML = {
  fast,
  /**
   * Take a snapshot of each coin this often (and once as soon as it appears). These are also the
   * only moments the bot buys: the model is tested on snapshots, so it trades on snapshots.
   */
  sampleEveryMs: fast ? 30_000 : 10 * 60_000,
  /** How long after a snapshot its outcome is followed. Also the longest a trade is held. */
  horizonMs: fast ? 4 * 60_000 : 60 * 60_000,
  /** Finished snapshots are written to the database this often (and at shutdown). */
  flushEveryMs: fast ? 60_000 : 60 * 60_000,
  /** Retrain this often once there is enough data. */
  trainEveryMs: fast ? 4 * 60_000 : 4 * 3_600_000,
  /** Minimum finished snapshots, and hours they must span, before the first training. */
  minRows: fast ? 200 : 3_000,
  minSpanMs: fast ? 30 * 60_000 : 12 * 3_600_000,
  /**
   * Most recent snapshots kept in memory for training (about a week at ~45,000 a day). 300,000 rows
   * take ~140MB and train in minutes on the free server's 512MB / 0.1 CPU.
   */
  maxRows: 300_000,
  /** Days of stored snapshots loaded at startup / kept in the database. */
  loadDays: 10,
  retentionDays: 14,
  /** Never store more than this many (~200 bytes each), whatever their age: the free database holds 512MB. */
  maxStoredRows: 1_000_000,
  schema: fast ? 1001 : 1,
  modelKey: fast ? 'ml:model:fast' : 'ml:model',

  /** Coins below this liquidity aren't recorded: nothing could be traded there anyway. */
  minLiquidity: 5_000,
  /** The bot (and the backtest that judges it) never buys below this or with danger flags. */
  tradeMinLiquidity: 10_000,
  /**
   * ...nor a coin younger than this (minutes) or with a Jupiter organic score under this (0-100: the
   * share of its trading that comes from real wallets rather than bots). On 2026-10-03/04 a factory of
   * copycat coins (NVIDIA, SpaceX, Grok...) launched, self-graduated in the same second, pumped them
   * with bot trades and dumped them 80-100% within half an hour; every one scored 0.
   */
  tradeMinAgeMin: fast ? 10 : 60,
  tradeMinOrganic: 20,

  /** Profit levels (%) and loss levels (%) whose first-hit time is recorded for every snapshot. */
  tpLevels: [10, 20, 30, 50, 100].map((v) => v * scale),
  slLevels: [10, 15, 20, 30, 50].map((v) => v * scale),
  /**
   * Take-profit / stop-loss pairs the trainer tries; it keeps the one that tests best. Wider stops
   * get shaken out less (higher win rate); tighter ones cut losers sooner. Must be recorded levels.
   */
  targets: [
    { tp: 20, sl: 10 },
    { tp: 20, sl: 20 },
    { tp: 30, sl: 15 },
    { tp: 30, sl: 30 },
    { tp: 50, sl: 20 },
  ].map((t) => ({ tp: t.tp * scale, sl: t.sl * scale })),
  /** Target for the plain-score strategy the bot uses before the AI is proven. */
  scoreTarget: { tp: 30 * scale, sl: 15 * scale },
  /**
   * When two strategies make about the same money (within this many % per trade), prefer the one
   * that wins more often.
   */
  preferWinRateWithin: 0.5,

  /**
   * Assumed cost per buy or sell: 1% pool + router fee, plus ~0.5% slippage for a trade of 0.25% of
   * the pool (the bot's default size cap). Matches what the paper bot actually pays.
   */
  costPerSide: 0.015,
  /** What counts as "proven": enough test trades, a real edge after fees, and real skill at ranking. */
  proven: { minTrades: fast ? 5 : 25, minAvgReturn: 1, minAuc: 0.55 },
  /** After the bot sells a coin it waits this long before buying it again (the backtest does the same). */
  cooldownMs: fast ? 4 * 60_000 : 60 * 60_000,
  /**
   * Slippage limit: a buy is cancelled if the price has run up more than this (%) above the price the
   * coin was picked at by the time it lands, like a real swap with a slippage tolerance.
   */
  maxChasePct: 10 * scale,
  /**
   * The AI's live record: once its latest picks (followed exactly like test trades) number at least
   * `minTrades` and average below `floor` % after fees, the bot stops following it until they recover.
   */
  live: { window: 30, minTrades: fast ? 6 : 20, floor: -2 },
};

export type Target = { tp: number; sl: number };
