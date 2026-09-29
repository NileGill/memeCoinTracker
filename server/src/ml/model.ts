import type { AiDriver, AiSignal, AiTarget, MlModelInfo, MlStatus, StrategyResult, TokenView } from '../../../shared/types';
import { setViewDecorator } from '../engine/market';
import { broadcast } from '../lib/bus';
import { kvGet, kvSet } from '../lib/cache';
import { ML, type Target } from './config';
import { FEATURES, featurize, makeObs, NUM_FEATURES } from './features';
import { auc, contributions, fitGbdt, importance, Pacer, predict, type GbdtModel } from './gbdt';
import { borrowDataset, obsContext, OUT_AT, OUT_W, recorderStatus, type Dataset } from './recorder';

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
 */

const F = NUM_FEATURES;
const horizonSec = ML.horizonMs / 1000;
const FEATURE_LABELS = FEATURES.map((f) => f.label);
/** The deepest recorded loss level (50%): hitting it counts as a crash. */
const CRASH_LEVEL = ML.slLevels.length - 1;

interface SavedModel {
  v: 3;
  schema: number;
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
let training = false;
let lastAttempt = 0;
/** Why the last attempt didn't produce a model (shown while collecting). */
let lastNote: string | null = null;

// ---------------------------------------------------------------- outcomes for a target

interface Outcome {
  y: number;
  ret: number; // % after costs
  exitSec: number;
}

const netReturn = (grossPct: number) => ((1 + grossPct / 100) * (1 - ML.costPerSide)) / (1 + ML.costPerSide) * 100 - 100;

/** What a bot trade with this target would have done from snapshot `i` (null = unusable row). */
function outcomeFor(d: Dataset, i: number, t: Target): Outcome | null {
  const o = i * OUT_W;
  if (d.out[o + OUT_AT.gap]) return null;
  const ti = ML.tpLevels.indexOf(t.tp);
  const si = ML.slLevels.indexOf(t.sl);
  const tpT = d.out[o + OUT_AT.tp + ti];
  const slT = d.out[o + OUT_AT.sl + si];
  // Same tick counts as the stop (conservative).
  if (tpT >= 0 && (slT < 0 || tpT < slT)) return { y: 1, ret: netReturn(t.tp), exitSec: tpT };
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
 * isn't already holding or cooling down on, hold until the target, stop or time limit.
 */
function simulate(d: Dataset, rows: Int32Array, outs: (Outcome | null)[], signal: (k: number) => boolean): Sim {
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
    busyUntil.set(m, d.t[i] + oc.exitSec * 1000 + ML.cooldownMs);
    trades++;
    sum += oc.ret;
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
  if (!items.length) return null;
  const top = Math.max(...items.map((x) => sim(x).avgReturn));
  const close = items.filter((x) => sim(x).avgReturn >= top - ML.preferWinRateWithin);
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

/** Bins by probability: how many trades made money (after fees) and their average return. */
function calibrate(prob: number[], outs: Outcome[]): Calib {
  const idx = prob.map((_, i) => i).sort((a, b) => prob[a] - prob[b]);
  const size = Math.max(40, Math.floor(idx.length / 10));
  const p: number[] = [];
  const win: number[] = [];
  const ev: number[] = [];
  const w: number[] = [];
  for (let s = 0; s < idx.length; s += size) {
    const part = idx.slice(s, s + size);
    if (part.length < size / 2 && p.length) {
      // Fold a small tail into the previous bin.
      const n0 = w[w.length - 1];
      const n1 = part.length;
      const tot = n0 + n1;
      p[p.length - 1] = (p[p.length - 1] * n0 + part.reduce((a, i) => a + prob[i], 0)) / tot;
      win[win.length - 1] = (win[win.length - 1] * n0 + part.reduce((a, i) => a + (outs[i].ret > 0 ? 1 : 0), 0)) / tot;
      ev[ev.length - 1] = (ev[ev.length - 1] * n0 + part.reduce((a, i) => a + outs[i].ret, 0)) / tot;
      w[w.length - 1] = tot;
      continue;
    }
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
      if (pos < 20 || tr.outs.length - pos < 20 || !tu.rows.length) continue;
      const fit = await fitGbdt({ X: d.X, F, y, train: tr.rows, valid: tu.rows, params, pacer });
      const risk = crashUsable ? Array.from(tu.rows, (i) => crashProb[i]) : null;
      const rule = pickRule(d, tu.rows, tu.outs, fit.validProb!, risk, tuneMinTrades);
      if (rule) cands.push({ target, gbdt: fit.model, rule });
    }
    const best = chooseBest(cands, (c) => c.rule.sim);
    if (!best) throw new Note('Too few coins hit any profit target yet to learn what winners look like.');

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

    const problems: string[] = [];
    if (test.avgReturn < ML.proven.minAvgReturn)
      problems.push(`Test trades averaged ${round(test.avgReturn, 1)}% after fees (needs +${ML.proven.minAvgReturn}% or better).`);
    if (test.trades < minTrades) problems.push(`Only ${test.trades} test trades (needs ${minTrades}): not enough to judge.`);
    if (testAuc < ML.proven.minAuc) problems.push(`Its ranking of coins wasn't reliably better than chance (skill ${round(testAuc, 2)}; needs ${ML.proven.minAuc}).`);

    const imp = importance(best.gbdt);
    const impTotal = imp.reduce((a, v) => a + v, 0) || 1;
    const topFeatures = Array.from(imp)
      .map((v, f) => ({ label: FEATURE_LABELS[f], importance: round(v / impTotal, 3) }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    const calibRows = [...tuneRows, ...testRows];
    const calibOuts = [...tuneOuts, ...testOuts];
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
      v: 3,
      schema: ML.schema,
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
      lastNote = 'Training failed; it will try again later.';
      console.error('[ml] training failed:', e);
    }
    console.log(`[ml] no new model: ${lastNote}`);
  } finally {
    release();
    training = false;
    broadcastStatus();
  }
}

class Note extends Error {}

// ---------------------------------------------------------------- live predictions

/** The models' read on a coin right now: win model probability `p`, crash chance `risk`. */
function signalFor(v: TokenView, p: number, risk: number | null): AiSignal {
  const c = current!;
  const danger = v.flags.some((f) => f.severity === 'danger');
  const safeEnough = c.riskMax == null || (risk != null && risk <= c.riskMax);
  const table = safeEnough || !c.calib.risky ? c.calib.safe : c.calib.risky;
  const win = interp(table.p, table.win, p);
  const ev = interp(table.p, table.ev, p);
  return {
    win: round(Number.isFinite(win) ? win : p, 2),
    ev: Number.isFinite(ev) ? round(ev, 1) : null,
    risk: risk == null ? null : round(risk, 2),
    pick: c.info.proven && p >= c.threshold && safeEnough && (v.liquidity ?? 0) >= ML.tradeMinLiquidity && !danger,
  };
}

setViewDecorator((views) => {
  if (!current) return;
  const ctx = obsContext();
  const x = new Float32Array(F);
  for (const v of views) {
    const obs = makeObs(v, ctx);
    if (!obs) continue;
    featurize(obs, x);
    v.ai = signalFor(v, predict(current.gbdt, x), current.crash ? predict(current.crash, x) : null);
  }
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

/**
 * What the bot needs from the models: is the AI trustworthy, what does it trade toward, and the
 * crash-chance cap to apply to score trades before then (null = none).
 */
export function modelForBot(): { proven: boolean; target: AiTarget; version: number; scoreRiskMax: number | null } | null {
  if (!current) return null;
  return {
    proven: current.info.proven,
    target: current.info.target,
    version: current.info.version,
    scoreRiskMax: current.crash ? current.scoreRiskMax : null,
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
  } else if (info.proven) {
    state = 'ready';
    message = `Proven on the most recent data it never trained on: ${info.test.trades} test trades averaged ${info.test.avgReturn > 0 ? '+' : ''}${info.test.avgReturn}% after fees.`;
  } else {
    state = 'unproven';
    const every = ML.trainEveryMs >= 3_600_000 ? `${ML.trainEveryMs / 3_600_000} hours` : `${ML.trainEveryMs / 60_000} minutes`;
    message = `Trained, but not good enough to trade on yet. ${info.problems[0] ?? ''} It retrains every ${every} as data grows.`;
  }
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
      saved?.v === 3 &&
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
  setInterval(() => {
    if (training) return;
    const now = Date.now();
    const due = !current || now - current.info.version >= ML.trainEveryMs;
    // After a failed attempt, wait half a cycle before trying again.
    if (due && now - lastAttempt >= ML.trainEveryMs / 2 && readyToTrain().ok) void train();
    else broadcastStatus();
  }, ML.fast ? 15_000 : 60_000).unref();
}
