/**
 * Settings for the learning pipeline. ML_FAST=1 shrinks every timescale from hours to minutes
 * so the whole loop (record -> outcome -> train -> trade) can be exercised locally; fast-mode
 * data is tagged with its own schema id and model key so it never mixes with real data.
 */
const fast = process.env.ML_FAST === '1';
const scale = fast ? 0.1 : 1; // fast mode uses 10x smaller price moves so outcomes happen within minutes

export const ML = {
  fast,
  /** Take a snapshot of each coin this often (and once as soon as it appears). */
  sampleEveryMs: fast ? 30_000 : 15 * 60_000,
  /** How long after a snapshot its outcome is followed. Also the longest a trade is held. */
  horizonMs: fast ? 4 * 60_000 : 60 * 60_000,
  /** Finished snapshots are written to the database this often (and at shutdown). */
  flushEveryMs: fast ? 60_000 : 60 * 60_000,
  /** Retrain this often once there is enough data. */
  trainEveryMs: fast ? 4 * 60_000 : 4 * 3_600_000,
  /** Minimum finished snapshots, and hours they must span, before the first training. */
  minRows: fast ? 200 : 3_000,
  minSpanMs: fast ? 30 * 60_000 : 12 * 3_600_000,
  /** Most recent snapshots kept in memory for training. */
  maxRows: 100_000,
  /** Days of stored snapshots loaded at startup / kept in the database. */
  loadDays: 7,
  retentionDays: 14,
  schema: fast ? 1001 : 1,
  modelKey: fast ? 'ml:model:fast' : 'ml:model',

  /** Coins below this liquidity aren't recorded: nothing could be traded there anyway. */
  minLiquidity: 5_000,
  /** The bot (and the backtest that judges it) never buys below this or with danger flags. */
  tradeMinLiquidity: 10_000,

  /** Profit levels (%) and loss levels (%) whose first-hit time is recorded for every snapshot. */
  tpLevels: [10, 20, 30, 50, 100].map((v) => v * scale),
  slLevels: [10, 15, 20, 30, 50].map((v) => v * scale),
  /** Take-profit / stop-loss pairs the trainer tries; it keeps the one that tests best. */
  targets: [
    { tp: 20, sl: 10 },
    { tp: 30, sl: 15 },
    { tp: 50, sl: 20 },
  ].map((t) => ({ tp: t.tp * scale, sl: t.sl * scale })),

  /** Assumed cost per buy or sell: pool fee + router fee + slippage on a small order. */
  costPerSide: 0.0125,
  /** What counts as "proven": enough test trades, a real edge after fees, and real skill at ranking. */
  proven: { minTrades: fast ? 5 : 25, minAvgReturn: 1, minAuc: 0.55 },
  /** After the bot sells a coin it waits this long before buying it again (the backtest does the same). */
  cooldownMs: fast ? 4 * 60_000 : 60 * 60_000,
};

export type Target = { tp: number; sl: number };
