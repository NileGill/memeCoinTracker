import type { AiDriver, AiTarget, MlLiveRecord, MlModelInfo, MlStatus, StrategyResult, TokenView } from '../../../shared/types';
import { setViewDecorator } from '../engine/market';
import { broadcast } from '../lib/bus';
import { kvGet, kvSet } from '../lib/cache';
import { ML, type Target } from './config';
import { FEATURES, featurize, hasDanger, makeObs, NUM_FEATURES, type Obs } from './features';
import { auc, contributions, fitGbdt, importance, Pacer, predict, type GbdtModel } from './gbdt';
import { borrowDataset, obsContext, OUT_AT, OUT_W, recorderStatus, setSnapshotJudge, type Dataset } from './recorder';

/*
 * Training and using the model.
 *
 * Two models answer two questions about a coin right now:
 *   1. "If I bought it, would it hit +X% before -Y% within the hour?"  (the win model)
 *   2. "Will it crash 50%+ (or its price vanish) within the hour?"      (the crash model)
 * The first alone can't tell a -15% stop from a -100% rug, and rugs gap straight through any
 * stop, so the bot only buys coins the first model likes AND the second doesn't flag.
 *
 * Data is split by time into three parts. The models learn on the oldest 70%, the next 15%
 * picks the target, the confidence bar and the crash cutoff, and the newest 15% (never used for
 * any choice) is the honest test. The AI is only called proven, and only then followed by the
 * bot, when trades in that test period made money after fees.
 *
 * The bot trades exactly the way the test does: it decides at the same 10-minute snapshots, sets
 * its target and stop from the price the coin was picked at, and cancels a buy whose price ran
 * away before it landed. Every pick is also followed to the end like a test trade (its live
 * record), and the bot stops following an AI whose recent live picks lose money.
 */

const F = NUM_FEATURES;
const horizonSec = ML.horizonMs / 1000;
const FEATURE_LABELS = FEATURES.map((f) => f.label);
/** The deepest recorded loss level (50%): hitting it counts as a crash. */
const CRASH_LEVEL = ML.slLevels.length - 1;

/** Saved-model format. Version 4 models (tested before the bot traded exactly like the test) still load, then retrain at once. */
const MODEL_V = 5;

interface SavedModel {
  v: 4 | 5;
  schema: number;
  /** Cost per side the test charged; a model tested at a different cost is retrained. */
  cost: number;
  featureLabels: string[];
  gbdt: GbdtModel;
  crash: GbdtModel | null;
  info: MlModelInfo;
  /** Raw win-model probability the bot buys at. */
  threshold: number;
  /** Crash chance above which the AI bot skips a coin (null = no cap). */
  riskMax: number | null;
  /** The same cap for the score strategy used before the AI is proven (null = no cap). */
  scoreRiskMax: number | null;
  /**
   * Probability -> share of trades that made money, and their average return, from data the
   * model didn't learn on. Separate tables for coins under the crash cap and coins over it.
   */
  calib: { safe: Calib; risky: Calib | null };
}

interface Calib {
  p: number[];
  win: number[];
  ev: number[];
}

let current: SavedModel | null = null;
/** The saved model (if any) has been looked up, so `current` means what it says. */
let loadedSaved = false;
export const modelLoaded = () => loadedSaved;

/** After this long without a successful retrain, a proven model stops being followed (it learned on old data). */
const STALE_AFTER_MS = 3 * ML.trainEveryMs;
const stale = (info: MlModelInfo) => Date.now() - info.version > STALE_AFTER_MS;
/** Proven, and recent enough to act on. */
const trusted = (info: MlModelInfo) => info.proven && !stale(info);
let training = false;
let lastAttempt = 0;
/** Why the last attempt didn't produce a model (shown while collecting). */
let lastNote: string | null = null;
/** How the most recent attempt went, shown even when an older model is still in use. */
let lastResult: MlStatus['lastAttempt'] = null;

// ---------------------------------------------------------------- outcomes for a target

interface Outcome {
  y: number;
  ret: number; // % after costs
  exitSec: number;
}

/** % result after costs of buying at `entryPct` and selling at `exitPct` (both measured from the snapshot price). */
const netFrom = (exitPct: number, entryPct: number) =>
  (((1 + exitPct / 100) / (1 + entryPct / 100)) * (1 - ML.costPerSide)) / (1 + ML.costPerSide) * 100 - 100;

/** A buy that lands after the coin already fell this far (it rugged between the signal and the fill). */
const COLLAPSED_PCT = -90;

/**
 * What a bot trade with this target would have done from snapshot `i` (null = unusable row).
 * The buy lands at the next reading after the snapshot, not at the snapshot price. Like the bot,
 * the target and stop are levels from the snapshot price (the price the coin was picked at).
 */
function outcomeFor(d: Dataset, i: number, t: Target): Outcome | null {
  const o = i * OUT_W;
  if (d.out[o + OUT_AT.gap]) return null;
  const e1 = d.out[o + OUT_AT.e1];
  const entry = Number.isNaN(e1) ? 0 : e1;
  const ti = ML.tpLevels.indexOf(t.tp);
  const si = ML.slLevels.indexOf(t.sl);
  const tpT = d.out[o + OUT_AT.tp + ti];
  const slT = d.out[o + OUT_AT.sl + si];
  // The coin collapsed before the buy landed: like the paper bot, buying into an emptied pool gets
  // ~nothing back. (Measuring from a price near zero once divided by zero and broke training.)
  if (entry <= COLLAPSED_PCT) return { y: 0, ret: -100, exitSec: slT >= 0 ? slT : horizonSec };
  // The bot's target and stop are the same levels from the picked price, so the result is that
  // sale price against what the buy paid. It can't lose more than everything.
  const netReturn = (grossFromSnapshot: number) => Math.max(-100, netFrom(grossFromSnapshot, entry));
  // Same tick counts as the stop (conservative). A target sale fills at the next reading after the
  // target is reached (capped at the target), so brief spikes don't count as full wins.
  if (tpT >= 0 && (slT < 0 || tpT < slT)) {
    const next = d.out[o + OUT_AT.tpn + ti];
    return { y: 1, ret: netReturn(Number.isNaN(next) ? t.tp : Math.min(t.tp, next)), exitSec: tpT };
  }
  if (slT >= 0) {
    const r = d.out[o + OUT_AT.slr + si];
    return { y: 0, ret: netReturn(Number.isNaN(r) ? -t.sl : r), exitSec: slT };
  }
  const end = d.out[o + OUT_AT.rq + 2];
  if (Number.isNaN(end)) return null;
  return { y: 0, ret: netReturn(end), exitSec: horizonSec };
}

/** 1 if the coin fell 50%+ at some point in the hour or its price feed died, 0 if not, null if unusable. */
function crashFor(d: Dataset, i: number): number | null {
  const o = i * OUT_W;
  if (d.out[o + OUT_AT.gap]) return null;
  return d.out[o + OUT_AT.gone] || d.out[o + OUT_AT.sl + CRASH_LEVEL] >= 0 ? 1 : 0;
}

// ---------------------------------------------------------------- backtest

interface Sim extends StrategyResult {
  sum: number;
}

/**
 * Replay the bot over `rows` (time order): buy whenever `signal` fires on a tradeable coin it
 * isn't already holding or cooling down on, hold until the target, stop or time limit. A buy whose
 * price ran up past the slippage limit before it landed doesn't happen (and doesn't block the coin).
 * `log` collects each trade's return, in order.
 */
function simulate(d: Dataset, rows: Int32Array, outs: (Outcome | null)[], signal: (k: number) => boolean, log?: number[]): Sim {
  const busyUntil = new Map<number, number>();
  let trades = 0;
  let wins = 0;
  let sum = 0;
  let gw = 0;
  let gl = 0;
  for (let k = 0; k < rows.length; k++) {
    const i = rows[k];
    const oc = outs[k];
    if (!oc || !signal(k)) continue;
    if (!(d.liq[i] >= ML.tradeMinLiquidity) || d.danger[i]) continue;
    const m = d.mint[i];
    if ((busyUntil.get(m) ?? 0) > d.t[i]) continue;
    if (d.out[i * OUT_W + OUT_AT.e1] > ML.maxChasePct) continue;
    busyUntil.set(m, d.t[i] + oc.exitSec * 1000 + ML.cooldownMs);
    trades++;
    sum += oc.ret;
    log?.push(oc.ret);
    if (oc.ret > 0) {
      wins++;
      gw += oc.ret;
    } else gl -= oc.ret;
  }
  return {
    trades,
    winRate: trades ? wins / trades : 0,
    avgReturn: trades ? sum / trades : 0,
    totalReturn: sum,
    profitFactor: gl > 0 ? gw / gl : null,
    sum,
  };
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const cleanSim = (s: Sim): StrategyResult => ({
  trades: s.trades,
  winRate: round(s.winRate, 3),
  avgReturn: round(s.avgReturn),
  totalReturn: round(s.totalReturn, 1),
  profitFactor: s.profitFactor == null ? null : round(s.profitFactor),
});

/**
 * The most profitable option; among options within a whisker of it, the one that wins most
 * often (then the one with more trades).
 */
function chooseBest<T>(items: T[], sim: (t: T) => Sim): T | null {
  // A result that isn't a number can never be best (one used to make every option lose silently).
  const usable = items.filter((x) => Number.isFinite(sim(x).avgReturn));
  if (!usable.length) return null;
  const top = Math.max(...usable.map((x) => sim(x).avgReturn));
  const close = usable.filter((x) => sim(x).avgReturn >= top - ML.preferWinRateWithin);
  close.sort((a, b) => sim(b).winRate - sim(a).winRate || sim(b).trades - sim(a).trades);
  return close[0];
}

interface Rule {
  /** Buy when the signal is at least this. */
  th: number;
  /** ...and the crash chance is at most this (null = no cap). */
  risk: number | null;
  sim: Sim;
}

/**
 * Choose how picky to be on the tuning data: a bar for the signal (by default from "top 1%" to
 * "top half"), and optionally a crash-risk cap that skips the riskiest 10-70% of coins.
 */
function pickRule(
  d: Dataset,
  rows: Int32Array,
  outs: (Outcome | null)[],
  signal: ArrayLike<number>,
  risk: ArrayLike<number> | null,
  minTrades: number,
  bars?: number[],
): Rule | null {
  let ths = bars;
  if (!ths) {
    const desc = Array.from(signal)
      .filter((v) => !Number.isNaN(v))
      .sort((a, b) => b - a);
    ths = [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5]
      .map((f) => desc[Math.min(desc.length - 1, Math.floor(f * desc.length))])
      .filter((v) => v !== undefined);
  }
  const caps: (number | null)[] = [null];
  if (risk) {
    const asc = Array.from(risk)
      .filter((v) => !Number.isNaN(v))
      .sort((a, b) => a - b);
    for (const keep of [0.9, 0.8, 0.7, 0.5, 0.3]) if (asc.length) caps.push(asc[Math.min(asc.length - 1, Math.floor(keep * asc.length))]);
  }
  const found: Rule[] = [];
  for (const th of ths)
    for (const cap of caps) {
      const sim = simulate(d, rows, outs, (k) => signal[k] >= th && (cap == null || risk![k] <= cap));
      if (sim.trades >= minTrades) found.push({ th, risk: cap, sim });
    }
  return chooseBest(found, (r) => r.sim);
}

// ---------------------------------------------------------------- calibration

/** Pool-adjacent-violators: make values non-decreasing (weighted). */
function isotonic(vals: number[], weights: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  vals.forEach((v, i) => {
    blocks.push({ v, w: weights[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  });
  return blocks.flatMap((b) => Array(b.n).fill(b.v));
}

/**
 * Bins by probability: how many trades made money (after fees) and their average return. Bins get
 * finer toward the top (the last are the top 5%, 2% and 1%), where the bot's picks are; a single
 * top-10% bin used to give every pick the average of far weaker coins.
 */
function calibrate(prob: number[], outs: Outcome[]): Calib {
  const idx = prob.map((_, i) => i).sort((a, b) => prob[a] - prob[b]);
  const n = idx.length;
  const MIN = 40;
  const parts: number[][] = [];
  let from = 0;
  for (const edge of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 1]) {
    const to = Math.round(edge * n);
    // Too few rows for a bin of its own: it joins the next one.
    if (to - from < MIN && edge < 1) continue;
    if (to > from) parts.push(idx.slice(from, to));
    from = to;
  }
  // A last bin too small to say much is folded into the one before it.
  if (parts.length > 1 && parts[parts.length - 1].length < MIN) parts[parts.length - 2].push(...parts.pop()!);
  const p: number[] = [];
  const win: number[] = [];
  const ev: number[] = [];
  const w: number[] = [];
  for (const part of parts) {
    p.push(part.reduce((a, i) => a + prob[i], 0) / part.length);
    win.push(part.reduce((a, i) => a + (outs[i].ret > 0 ? 1 : 0), 0) / part.length);
    ev.push(part.reduce((a, i) => a + outs[i].ret, 0) / part.length);
    w.push(part.length);
  }
  return { p: p.map((v) => round(v, 4)), win: isotonic(win, w).map((v) => round(v, 3)), ev: isotonic(ev, w).map((v) => round(v, 2)) };
}

function interp(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return ys[i - 1] + f * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

// ---------------------------------------------------------------- training

function readyToTrain(): { ok: boolean; why: string } {
  const r = recorderStatus();
  if (!r.loaded) return { ok: false, why: 'Loading saved data…' };
  // Time covered by snapshots (not wall time: the server may have been down in between).
  const span = r.dataFrom != null && r.dataTo != null ? r.dataTo - r.dataFrom : 0;
  if (r.samples < ML.minRows)
    return { ok: false, why: `Needs ${ML.minRows.toLocaleString('en-US')} finished snapshots to start learning (has ${r.samples.toLocaleString('en-US')}).` };
  if (span < ML.minSpanMs) {
    const hours = ML.minSpanMs / 3_600_000;
    return { ok: false, why: `Needs at least ${hours >= 1 ? `${hours} hours` : `${Math.round(hours * 60)} minutes`} of history so it can be tested on a later period.` };
  }
  return { ok: true, why: '' };
}

async function train() {
  training = true;
  lastAttempt = Date.now();
  broadcastStatus();
  const startedAt = Date.now();
  // Short bursts with longer rests: the free server has a tenth of a CPU core and the live site comes first.
  const pacer = new Pacer(15, 25);
  const { data: d, release } = borrowDataset();
  try {
    const n = d.n;
    const order = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => d.t[a] - d.t[b]);
    // Split by time, not by row count, so each part really covers its share of the history.
    const tFirst = d.t[order[0]];
    const tLast = d.t[order[n - 1]];
    const span = tLast - tFirst;
    const tuneStart = tLast - 0.3 * span;
    const testStart = tLast - 0.15 * span;
    // Leave a horizon-long gap between parts so no outcome overlaps the next part's snapshots.
    const part = (lo: number, hi: number) => Int32Array.from(Array.from(order).filter((i) => d.t[i] >= lo && d.t[i] < hi));
    const trainAll = part(-Infinity, tuneStart - ML.horizonMs);
    const tuneAll = part(tuneStart, testStart - ML.horizonMs);
    const testAll = part(testStart, Infinity);
    const minPart = ML.fast ? 20 : 100;
    if (trainAll.length < minPart * 5) throw new Note('Not enough older data to learn from yet.');
    if (tuneAll.length < minPart || testAll.length < minPart) throw new Note('Not enough recent data to test on yet.');

    const minTrades = ML.proven.minTrades;
    const tuneMinTrades = Math.max(3, Math.round(minTrades * 0.6));
    const minLeaf = Math.max(10, Math.min(60, Math.floor(trainAll.length / 50)));
    const params = { minLeaf, rounds: 250, learningRate: 0.08, colSample: 0.6 };
    const y = new Float32Array(n);
    const rowX = (i: number) => d.X.subarray(i * F, (i + 1) * F);

    // ---- the crash model: which coins fall 50%+ (or vanish) within the hour
    let crashModel: GbdtModel | null = null;
    const crashProb = new Float64Array(n).fill(NaN);
    let crashTuneAuc = 0;
    let crashTestAuc = 0;
    let crashRate = 0;
    {
      const labelled = (rows: Int32Array) =>
        Int32Array.from(
          Array.from(rows).filter((i) => {
            const c = crashFor(d, i);
            if (c === null) return false;
            y[i] = c;
            return true;
          }),
        );
      const tr = labelled(trainAll);
      const tu = labelled(tuneAll);
      const pos = tr.reduce((a, i) => a + y[i], 0);
      if (pos >= 20 && tr.length - pos >= 20 && tu.length) {
        const fit = await fitGbdt({ X: d.X, F, y, train: tr, valid: tu, params, pacer });
        crashModel = fit.model;
        tu.forEach((i, k) => (crashProb[i] = fit.validProb![k]));
        crashTuneAuc = auc(fit.validProb!, Array.from(tu, (i) => y[i]));
        const te = labelled(testAll);
        const teProb = Array.from(te, (i) => (crashProb[i] = predict(fit.model, rowX(i))));
        crashTestAuc = auc(teProb, Array.from(te, (i) => y[i]));
        crashRate = te.length ? te.reduce((a, i) => a + y[i], 0) / te.length : 0;
        for (const i of testAll) if (Number.isNaN(crashProb[i])) crashProb[i] = predict(fit.model, rowX(i));
      }
    }
    // Only let the crash model veto trades if it showed real skill on data it didn't learn from.
    const crashUsable = crashModel !== null && crashTuneAuc >= 0.55;

    // ---- the win model, once per target; the tuning data picks the bar and the crash cutoff
    type Cand = { target: Target; gbdt: GbdtModel; rule: Rule };
    const cands: Cand[] = [];
    // What each target had to work with, reported if none of them yields a model.
    const unusable = (rows: Int32Array) => (rows.length ? Math.round((100 * rows.reduce((a, i) => a + (d.out[i * OUT_W + OUT_AT.gap] ? 1 : 0), 0)) / rows.length) : 0);
    const why: string[] = [`learn ${trainAll.length} (${unusable(trainAll)}% with price holes), tune ${tuneAll.length} (${unusable(tuneAll)}% with holes)`];
    const withOutcomes = (rows: Int32Array, target: Target) => {
      const r: number[] = [];
      const o: Outcome[] = [];
      for (const i of rows) {
        const oc = outcomeFor(d, i, target);
        if (!oc) continue;
        r.push(i);
        o.push(oc);
      }
      return { rows: Int32Array.from(r), outs: o };
    };
    for (const target of ML.targets) {
      const tr = withOutcomes(trainAll, target);
      const tu = withOutcomes(tuneAll, target);
      tr.rows.forEach((i, k) => (y[i] = tr.outs[k].y));
      tu.rows.forEach((i, k) => (y[i] = tu.outs[k].y));
      const pos = tr.outs.reduce((a, o) => a + o.y, 0);
      const name = `+${target.tp}/-${target.sl}`;
      if (pos < 20 || tr.outs.length - pos < 20 || !tu.rows.length) {
        why.push(`${name}: ${pos} winners of ${tr.outs.length}, ${tu.rows.length} to tune on`);
        continue;
      }
      const fit = await fitGbdt({ X: d.X, F, y, train: tr.rows, valid: tu.rows, params, pacer });
      const risk = crashUsable ? Array.from(tu.rows, (i) => crashProb[i]) : null;
      const rule = pickRule(d, tu.rows, tu.outs, fit.validProb!, risk, tuneMinTrades);
      if (rule) cands.push({ target, gbdt: fit.model, rule });
      else {
        const pr = Array.from(fit.validProb!);
        const ok = pr.filter((v) => Number.isFinite(v)).sort((x, z) => x - z);
        const q = (f: number) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor(f * ok.length))].toFixed(4) : '-');
        const median = ok.length ? ok[Math.floor(ok.length / 2)] : NaN;
        why.push(
          `${name}: no bar gave ${tuneMinTrades}+ tuning trades (all coins: ${simulate(d, tu.rows, tu.outs, () => true).trades}, ` +
            `top half: ${simulate(d, tu.rows, tu.outs, (k) => fit.validProb![k] >= median).trades}; ${fit.model.trees.length} trees, base ${fit.model.base.toFixed(3)}, ` +
            `${pr.length - ok.length} of ${pr.length} scores not numbers, scores min ${q(0)} median ${q(0.5)} p99 ${q(0.99)} max ${q(1)})`,
        );
      }
    }
    const best = chooseBest(cands, (c) => c.rule.sim);
    if (!best) throw new Note('Too few coins hit any profit target yet to learn what winners look like.', why.join('; '));

    // ---- the honest test: the newest data, untouched by every choice above
    const test0 = withOutcomes(testAll, best.target);
    const testRows = Array.from(test0.rows);
    const testOuts = test0.outs;
    const testIdx = test0.rows;
    const testProb = testRows.map((i) => predict(best.gbdt, rowX(i)));
    const testRisk = testRows.map((i) => crashProb[i]);
    const testAuc = auc(testProb, testOuts.map((o) => o.y));
    const rule = best.rule;
    const test = simulate(d, testIdx, testOuts, (k) => testProb[k] >= rule.th && (rule.risk == null || testRisk[k] <= rule.risk));
    const baseRate = testOuts.length ? testOuts.reduce((a, o) => a + o.y, 0) / testOuts.length : 0;

    // ---- the same periods traded on the MemeRadar score, alone and with the crash filter
    const tune0 = withOutcomes(tuneAll, best.target);
    const tuneRows = Array.from(tune0.rows);
    const tuneOuts = tune0.outs;
    const scoreBars = [55, 60, 65, 70, 75, 80, 85];
    const tuneScore = tuneRows.map((i) => d.score[i]);
    const testScore = testRows.map((i) => d.score[i]);
    const plain = pickRule(d, tune0.rows, tuneOuts, tuneScore, null, tuneMinTrades, scoreBars);
    const baseline: MlModelInfo['baseline'] = plain
      ? { ...cleanSim(simulate(d, testIdx, testOuts, (k) => testScore[k] >= plain.th)), threshold: plain.th }
      : null;
    const filtered = crashUsable
      ? pickRule(d, tune0.rows, tuneOuts, tuneScore, tuneRows.map((i) => crashProb[i]), tuneMinTrades, scoreBars)
      : null;
    let scoreRiskMax = filtered?.risk ?? null;
    const scoreFiltered: MlModelInfo['scoreFiltered'] =
      filtered && filtered.risk != null
        ? {
            ...cleanSim(simulate(d, testIdx, testOuts, (k) => testScore[k] >= filtered.th && testRisk[k] <= filtered.risk!)),
            threshold: filtered.th,
          }
        : null;

    // The score strategy (used before the AI is proven) only gets the crash filter if it didn't make results worse.
    if (scoreFiltered && baseline && scoreFiltered.avgReturn < baseline.avgReturn) scoreRiskMax = null;

    // Only trust the test once most of its target sales were measured with the sell delay.
    const tpIdx = ML.tpLevels.indexOf(best.target.tp);
    const measured = testRows.filter(
      (i, k) => !Number.isNaN(d.out[i * OUT_W + OUT_AT.e1]) && (testOuts[k].y !== 1 || !Number.isNaN(d.out[i * OUT_W + OUT_AT.tpn + tpIdx])),
    ).length;
    const coverage = testRows.length ? measured / testRows.length : 1;

    const problems: string[] = [];
    if (coverage < 0.8)
      problems.push(
        `Most of its test period was recorded before buy and sell delays were measured (${Math.round(coverage * 100)}% measured), so its results are likely too rosy. Waiting for newer data.`,
      );
    // Written so that a result that isn't a number fails the check instead of passing it.
    if (!(test.avgReturn >= ML.proven.minAvgReturn))
      problems.push(`Test trades averaged ${round(test.avgReturn, 1)}% after fees (needs +${ML.proven.minAvgReturn}% or better).`);
    if (test.trades < minTrades) problems.push(`Only ${test.trades} test trades (needs ${minTrades}): not enough to judge.`);
    if (!(testAuc >= ML.proven.minAuc)) problems.push(`Its ranking of coins wasn't reliably better than chance (skill ${round(testAuc, 2)}; needs ${ML.proven.minAuc}).`);

    const imp = importance(best.gbdt);
    const impTotal = imp.reduce((a, v) => a + v, 0) || 1;
    const topFeatures = Array.from(imp)
      .map((v, f) => ({ label: FEATURE_LABELS[f], importance: round(v / impTotal, 3) }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    // Only snapshots a bot could have bought (enough liquidity, no danger flags, the buy within the
    // slippage limit), so a coin's numbers describe trades the bot would actually make.
    const canTrade = (i: number) => d.liq[i] >= ML.tradeMinLiquidity && !d.danger[i] && !(d.out[i * OUT_W + OUT_AT.e1] > ML.maxChasePct);
    const calibAll = [...tuneRows, ...testRows];
    const calibAllOuts = [...tuneOuts, ...testOuts];
    const calibKeep = calibAll.map((i, k) => (canTrade(i) ? k : -1)).filter((k) => k >= 0);
    const calibRows = calibKeep.map((k) => calibAll[k]);
    const calibOuts = calibKeep.map((k) => calibAllOuts[k]);
    const calibProb = calibRows.map((i) => predict(best.gbdt, rowX(i)));
    // Rate coins against similar coins on the same side of the crash cap, so a pick's numbers match the test.
    const isSafe = (i: number) => rule.risk == null || crashProb[i] <= rule.risk;
    const split = (safe: boolean) => {
      const idx = calibRows.map((i, k) => (isSafe(i) === safe ? k : -1)).filter((k) => k >= 0);
      return { prob: idx.map((k) => calibProb[k]), outs: idx.map((k) => calibOuts[k]) };
    };
    const safeSet = split(true);
    const riskySet = rule.risk == null ? null : split(false);
    const mints = new Set<number>();
    for (let i = 0; i < n; i++) mints.add(d.mint[i]);

    const info: MlModelInfo = {
      version: Date.now(),
      target: { tp: best.target.tp, sl: best.target.sl, holdMin: Math.round(ML.horizonMs / 60_000) },
      trainRows: trainAll.length,
      tuneRows: tuneAll.length,
      testRows: testAll.length,
      tokens: mints.size,
      dataFrom: d.t[order[0]],
      dataTo: d.t[order[n - 1]],
      testFrom: testStart,
      testTo: d.t[order[n - 1]],
      auc: round(testAuc, 3),
      baseRate: round(baseRate, 3),
      test: cleanSim(test),
      baseline,
      scoreFiltered,
      crash: crashModel ? { auc: round(crashTestAuc, 3), rate: round(crashRate, 3), maxRisk: rule.risk == null ? null : round(rule.risk, 3) } : null,
      proven: problems.length === 0,
      problems,
      topFeatures,
    };
    current = {
      v: MODEL_V,
      schema: ML.schema,
      cost: ML.costPerSide,
      featureLabels: FEATURE_LABELS,
      gbdt: best.gbdt,
      crash: crashUsable ? crashModel : null,
      info,
      threshold: rule.th,
      riskMax: rule.risk,
      scoreRiskMax,
      calib: {
        safe: calibrate(safeSet.prob, safeSet.outs),
        risky: riskySet && riskySet.prob.length ? calibrate(riskySet.prob, riskySet.outs) : null,
      },
    };
    lastNote = null;
    lastResult = { at: startedAt, seconds: Math.round((Date.now() - startedAt) / 1000), ok: true, note: null };
    console.log(
      `[ml] trained in ${((Date.now() - startedAt) / 1000).toFixed(1)}s on ${trainAll.length} rows: target +${best.target.tp}/-${best.target.sl}` +
        `, crash model skill ${round(crashTestAuc, 2)}${rule.risk != null ? ` (cap ${round(rule.risk, 2)})` : ' (no cap)'}` +
        `, test AUC ${info.auc}, ${test.trades} test trades winning ${Math.round(test.winRate * 100)}% averaging ${round(test.avgReturn, 2)}%` +
        ` -> ${info.proven ? 'PROVEN' : 'not proven'}`,
    );
    await kvSet(ML.modelKey, current).catch((e) => console.error('[ml] saving model failed:', e instanceof Error ? e.message : e));
  } catch (e) {
    if (e instanceof Note) lastNote = e.message;
    else {
      // Say what broke (and where), so a failure that repeats can be diagnosed from the status alone.
      const where =
        e instanceof Error
          ? (e.stack ?? '')
              .split('\n')
              .slice(1, 3)
              .map((l) => l.trim().replace(/\(.*[\\/]/, '('))
              .join(' ')
          : '';
      lastNote = `Training failed (${e instanceof Error ? e.message : String(e)}${where ? ` ${where}` : ''}); it will try again later.`;
      console.error('[ml] training failed:', e);
    }
    lastResult = { at: startedAt, seconds: Math.round((Date.now() - startedAt) / 1000), ok: false, note: lastNote };
    if (e instanceof Note && e.detail) {
      lastResult.detail = e.detail;
      console.log(`[ml] details: ${e.detail}`);
    }
    console.log(`[ml] no new model: ${lastNote}`);
  } finally {
    release();
    training = false;
    broadcastStatus();
  }
}

/** An expected reason not to produce a model (not a bug); `detail` goes to the health check. */
class Note extends Error {
  constructor(
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- live predictions

/** Win chance and average result of coins rated like this in testing, and whether it's under the crash cap. */
function rate(p: number, risk: number | null) {
  const c = current!;
  const safeEnough = c.riskMax == null || (risk != null && risk <= c.riskMax);
  const table = safeEnough || !c.calib.risky ? c.calib.safe : c.calib.risky;
  const win = interp(table.p, table.win, p);
  const ev = interp(table.p, table.ev, p);
  return { win: round(Number.isFinite(win) ? win : p, 2), ev: Number.isFinite(ev) ? round(ev, 1) : null, safeEnough };
}

/**
 * A coin snapshot the bot can act on, the moment it's taken. The bot only buys at these: they're
 * the moments the model was tested on, and the target and stop are set from `price`.
 */
export interface SnapshotSignal {
  seq: number;
  at: number;
  mint: string;
  /** The price the snapshot was taken at, and when that price reading arrived. */
  price: number;
  freshAt: number;
  /** The AI picks it (and the bot is following the AI). */
  pick: boolean;
  /** For ordering several picks at once: the AI's test results for coins rated like this. */
  rank: number;
  target: AiTarget | null;
  /** The MemeRadar score, and whether the crash model allows a score trade. */
  score: number | null;
  scoreSafe: boolean;
}

const signals: SnapshotSignal[] = [];
let signalSeq = 0;
/** Each coin's latest snapshot decision (the "pick" badge shows it until the next snapshot is due). */
const decisions = new Map<string, { at: number; pick: boolean }>();

/** Snapshots taken after `seq` (only the last minute's are kept), oldest first. */
export function snapshotSignalsSince(seq: number): SnapshotSignal[] {
  return signals.filter((s) => s.seq > seq);
}

setSnapshotJudge((obs: Obs, freshAt: number) => {
  const now = obs.t;
  while (signals.length && (now - signals[0].at > 60_000 || signals.length > 5_000)) signals.shift();
  const c = current;
  let aiPick = false;
  let rank = 0;
  let risk: number | null = null;
  let recorded: number | null = null;
  if (c) {
    const x = new Float32Array(F);
    featurize(obs, x);
    const p = predict(c.gbdt, x);
    risk = c.crash ? predict(c.crash, x) : null;
    const r = rate(p, risk);
    rank = (r.ev ?? 0) * 100 + r.win;
    // The rule the test traded on: the bar, the crash cap, enough liquidity, no danger flags.
    const picked = p >= c.threshold && r.safeEnough && (obs.liq ?? 0) >= ML.tradeMinLiquidity && !hasDanger(obs);
    if (trusted(c.info)) {
      recorded = picked ? ML.targets.findIndex((t) => t.tp === c.info.target.tp && t.sl === c.info.target.sl) : -1;
      aiPick = picked && following();
    }
  }
  const scoreRiskMax = c?.crash ? c.scoreRiskMax : null;
  signals.push({
    seq: ++signalSeq,
    at: now,
    mint: obs.mint,
    price: obs.price,
    freshAt,
    pick: aiPick,
    rank,
    target: c ? c.info.target : null,
    score: obs.score,
    scoreSafe: scoreRiskMax == null || (risk != null && risk <= scoreRiskMax),
  });
  decisions.set(obs.mint, { at: now, pick: aiPick });
  return recorded;
});

setViewDecorator((views) => {
  if (!current) return;
  const ctx = obsContext();
  const x = new Float32Array(F);
  const now = Date.now();
  for (const v of views) {
    const obs = makeObs(v, ctx);
    if (!obs) continue;
    featurize(obs, x);
    const risk = current.crash ? predict(current.crash, x) : null;
    const r = rate(predict(current.gbdt, x), risk);
    const d = decisions.get(v.mint);
    v.ai = {
      win: r.win,
      ev: r.ev,
      risk: risk == null ? null : round(risk, 2),
      pick: Boolean(d && d.pick && now - d.at <= ML.sampleEveryMs + 30_000),
    };
  }
  for (const [mint, d] of decisions) if (now - d.at > 3 * ML.sampleEveryMs) decisions.delete(mint);
});

/** The strongest reasons behind a coin's rating, for the coin page. */
export function explain(v: TokenView): AiDriver[] | null {
  if (!current) return null;
  const obs = makeObs(v, obsContext());
  if (!obs) return null;
  const x = new Float32Array(F);
  featurize(obs, x);
  const c = contributions(current.gbdt, x);
  return Array.from(c)
    .map((impact, f) => ({ label: FEATURE_LABELS[f], impact: round(impact, 3) }))
    .filter((d) => Math.abs(d.impact) >= 0.005)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 8);
}

// ---------------------------------------------------------------- live record

/**
 * The AI's picks since this was added, each followed to the end exactly like a test trade (same
 * outcome rules, one trade per coin at a time, slippage limit). A pick's result is known an hour
 * after it's made, so this trails by an hour.
 */
let live: MlLiveRecord | null = null;

function computeLive() {
  const { data: d, release } = borrowDataset();
  try {
    const rows: number[] = [];
    for (let i = 0; i < d.n; i++) if (d.out[i * OUT_W + OUT_AT.pick] >= 0) rows.push(i);
    rows.sort((a, b) => d.t[a] - d.t[b]);
    const outs = rows.map((i) => {
      const t = ML.targets[d.out[i * OUT_W + OUT_AT.pick]];
      return t ? outcomeFor(d, i, t) : null;
    });
    const all: number[] = [];
    const sim = simulate(d, Int32Array.from(rows), outs, () => true, all);
    const since = Date.now() - 86_400_000 - ML.horizonMs;
    const dayRows = rows.map((i, k) => k).filter((k) => d.t[rows[k]] >= since);
    const day: number[] = [];
    simulate(d, Int32Array.from(dayRows, (k) => rows[k]), dayRows.map((k) => outs[k]), () => true, day);
    const summary = (r: number[]) => ({
      trades: r.length,
      winRate: r.length ? round(r.filter((v) => v > 0).length / r.length, 3) : 0,
      avgReturn: r.length ? round(r.reduce((a, v) => a + v, 0) / r.length) : 0,
    });
    const recent = summary(all.slice(-ML.live.window));
    live = {
      from: rows.length ? d.t[rows[0]] : null,
      ...summary(all),
      totalReturn: round(sim.totalReturn, 1),
      last24h: summary(day),
      recent,
      losing: recent.trades >= ML.live.minTrades && recent.avgReturn < ML.live.floor,
    };
  } finally {
    release();
  }
}

export const liveRecord = () => live;

/** Why the bot isn't following the AI right now (null when it is). */
export function notFollowingReason(): string | null {
  if (!current) return 'the AI model is still collecting data';
  if (!current.info.proven) return "the AI model hasn't passed its latest test";
  if (stale(current.info)) return "the AI model hasn't retrained recently enough to trust";
  if (live?.losing) return "the AI's recent live picks have been losing money";
  return null;
}

/** Proven, recent, and its recent live picks aren't losing money: the bot follows it. */
function following(): boolean {
  return Boolean(current && trusted(current.info) && !live?.losing);
}

/**
 * What the bot needs from the models: is it following the AI, what does it trade toward, the
 * crash-chance cap for score trades (null = none), and how the score strategy did in the latest
 * test (null = no test yet).
 */
export function modelForBot(): {
  proven: boolean;
  target: AiTarget;
  version: number;
  scoreRiskMax: number | null;
  score: StrategyResult | null;
} | null {
  if (!current) return null;
  const i = current.info;
  const scoreRiskMax = current.crash ? current.scoreRiskMax : null;
  return {
    proven: following(),
    target: i.target,
    version: i.version,
    scoreRiskMax,
    score: scoreRiskMax != null ? (i.scoreFiltered ?? i.baseline) : i.baseline,
  };
}

// ---------------------------------------------------------------- status

export function mlStatus(): MlStatus {
  const r = recorderStatus();
  const info = current?.info ?? null;
  const ready = readyToTrain();
  let state: MlStatus['state'];
  let message: string;
  if (training) {
    state = 'training';
    message = 'Training a new model on the latest data…';
  } else if (!info) {
    state = 'collecting';
    message = `Learning from live data: ${r.samples.toLocaleString('en-US')} coin snapshots with known outcomes, ${r.pending.toLocaleString('en-US')} still being followed. ${lastNote ?? ready.why}`.trim();
  } else if (info.proven && stale(info)) {
    state = 'unproven';
    const hours = Math.round((Date.now() - info.version) / 3_600_000);
    message = `Passed its test, but it was trained ${hours} hours ago and hasn't retrained since, so the bot isn't following it until a retrain works.`;
  } else if (info.proven && live?.losing) {
    state = 'unproven';
    message =
      `Passed its test, but its last ${live.recent.trades} live picks averaged ${live.recent.avgReturn}% after fees, so the bot has stopped ` +
      `following it until they recover (picks are still followed and counted meanwhile).`;
  } else if (info.proven) {
    state = 'ready';
    message = `Proven on the most recent data it never trained on: ${info.test.trades} test trades averaged ${info.test.avgReturn > 0 ? '+' : ''}${info.test.avgReturn}% after fees.`;
  } else {
    state = 'unproven';
    const every = ML.trainEveryMs >= 3_600_000 ? `${ML.trainEveryMs / 3_600_000} hours` : `${ML.trainEveryMs / 60_000} minutes`;
    message = `Trained, but not good enough to trade on yet. ${info.problems[0] ?? ''} It retrains every ${every} as data grows.`;
  }
  // An older model is still in use because the latest retrain didn't work: say so.
  if (!training && info && lastResult && !lastResult.ok && lastResult.at > info.version)
    message += ` The latest retrain didn't produce a new model: ${lastResult.note}`;
  // Retrain a full cycle after the last model; after a failed attempt, retry half a cycle later.
  const next = Math.max(info ? info.version + ML.trainEveryMs : 0, lastAttempt ? lastAttempt + ML.trainEveryMs / 2 : 0) || Date.now();
  return {
    state,
    message,
    samples: r.samples,
    pending: r.pending,
    stored: r.stored,
    dataFrom: r.dataFrom,
    trainedAt: info?.version ?? null,
    nextTrainingAt: training || !ready.ok ? null : next,
    model: info,
    following: following(),
    lastAttempt: lastResult,
    live,
  };
}

let lastBroadcast = '';
function broadcastStatus() {
  const s = mlStatus();
  const key = JSON.stringify(s);
  if (key === lastBroadcast) return;
  lastBroadcast = key;
  broadcast('ml', s);
}

// ---------------------------------------------------------------- start

export async function startModel() {
  try {
    const saved = await kvGet<SavedModel>(ML.modelKey);
    if (
      (saved?.v === 4 || saved?.v === MODEL_V) &&
      saved.cost === ML.costPerSide &&
      saved.schema === ML.schema &&
      JSON.stringify(saved.featureLabels) === JSON.stringify(FEATURE_LABELS) &&
      saved.gbdt?.trees?.length
    ) {
      current = saved;
      console.log(`[ml] loaded model from ${new Date(saved.info.version).toISOString()} (${saved.info.proven ? 'proven' : 'not proven'})`);
    }
  } catch (e) {
    console.warn('[ml] could not load the saved model:', e instanceof Error ? e.message : e);
  }
  loadedSaved = true;
  setInterval(() => {
    try {
      computeLive();
    } catch (e) {
      console.error('[ml] live record failed:', e);
    }
    if (training) return broadcastStatus();
    const now = Date.now();
    const due = !current || current.v !== MODEL_V || now - current.info.version >= ML.trainEveryMs;
    // After a failed attempt, wait half a cycle before trying again.
    if (due && now - lastAttempt >= ML.trainEveryMs / 2 && readyToTrain().ok) void train();
    else broadcastStatus();
  }, ML.fast ? 15_000 : 60_000).unref();
}
