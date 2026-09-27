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
 * The question it answers: "if I bought this coin right now, would it hit +X% before -Y%
 * within the hour?" Data is split by time into three parts. The model learns on the oldest
 * 70%, the next 15% picks which target and confidence bar work best, and the newest 15%
 * (never used for any choice) is the honest test. It is only called proven, and only then
 * trusted by the bot, when trades in that test period made money after fees.
 */

const F = NUM_FEATURES;
const horizonSec = ML.horizonMs / 1000;
const FEATURE_LABELS = FEATURES.map((f) => f.label);

interface SavedModel {
  v: 1;
  schema: number;
  featureLabels: string[];
  gbdt: GbdtModel;
  info: MlModelInfo;
  /** Raw model probability the bot buys at. */
  threshold: number;
  /** Probability -> observed win rate and average return (from data the model didn't learn on). */
  calib: { p: number[]; win: number[]; ev: number[] };
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

/** Try confidence bars from "top 1%" to "top half" and keep the most profitable one with enough trades. */
function pickThreshold(d: Dataset, rows: Int32Array, outs: (Outcome | null)[], prob: ArrayLike<number>, minTrades: number) {
  const sorted = Array.from(prob).sort((a, b) => b - a);
  let best: { th: number; sim: Sim } | null = null;
  for (const frac of [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    const th = sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
    if (th === undefined) continue;
    const sim = simulate(d, rows, outs, (k) => prob[k] >= th);
    if (sim.trades < minTrades) continue;
    if (!best || sim.avgReturn > best.sim.avgReturn) best = { th, sim };
  }
  return best;
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

function calibrate(prob: number[], outs: Outcome[]) {
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
      win[win.length - 1] = (win[win.length - 1] * n0 + part.reduce((a, i) => a + outs[i].y, 0)) / tot;
      ev[ev.length - 1] = (ev[ev.length - 1] * n0 + part.reduce((a, i) => a + outs[i].ret, 0)) / tot;
      w[w.length - 1] = tot;
      continue;
    }
    p.push(part.reduce((a, i) => a + prob[i], 0) / part.length);
    win.push(part.reduce((a, i) => a + outs[i].y, 0) / part.length);
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
  const span = r.dataFrom ? Date.now() - r.dataFrom : 0;
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
    const tAt = (q: number) => d.t[order[Math.min(n - 1, Math.floor(q * n))]];
    const t70 = tAt(0.7);
    const t85 = tAt(0.85);
    // Leave a horizon-long gap between parts so no outcome overlaps the next part's snapshots.
    const part = (lo: number, hi: number) => Int32Array.from(Array.from(order).filter((i) => d.t[i] >= lo && d.t[i] < hi));
    const trainAll = part(-Infinity, t70 - ML.horizonMs);
    const tuneAll = part(t70, t85 - ML.horizonMs);
    const testAll = part(t85, Infinity);
    if (trainAll.length < 500 && !ML.fast) throw new Note('Not enough older data to learn from yet.');
    if (!tuneAll.length || !testAll.length) throw new Note('Not enough recent data to test on yet.');

    const minTrades = ML.proven.minTrades;
    const minLeaf = Math.max(10, Math.min(60, Math.floor(trainAll.length / 50)));
    type Cand = { target: Target; gbdt: GbdtModel; th: number; tune: Sim; tuneAuc: number };
    const cands: Cand[] = [];
    const y = new Float32Array(n);

    for (const target of ML.targets) {
      const keep = (rows: Int32Array) => {
        const r: number[] = [];
        const o: Outcome[] = [];
        for (const i of rows) {
          const oc = outcomeFor(d, i, target);
          if (!oc) continue;
          r.push(i);
          o.push(oc);
          y[i] = oc.y;
        }
        return { rows: Int32Array.from(r), outs: o };
      };
      const tr = keep(trainAll);
      const tu = keep(tuneAll);
      const pos = tr.outs.reduce((a, o) => a + o.y, 0);
      if (pos < 20 || tr.outs.length - pos < 20 || !tu.rows.length) continue;
      const fit = await fitGbdt({ X: d.X, F, y, train: tr.rows, valid: tu.rows, params: { minLeaf, rounds: 250, learningRate: 0.08, colSample: 0.6 }, pacer });
      const prob = fit.validProb!;
      const pick = pickThreshold(d, tu.rows, tu.outs, prob, Math.max(3, Math.round(minTrades * 0.6)));
      if (!pick) continue;
      cands.push({ target, gbdt: fit.model, th: pick.th, tune: pick.sim, tuneAuc: auc(prob, tu.outs.map((o) => o.y)) });
    }
    if (!cands.length) throw new Note('Too few coins hit any profit target yet to learn what winners look like.');
    cands.sort((a, b) => b.tune.avgReturn - a.tune.avgReturn);
    const best = cands[0];

    // ---- the honest test: the newest data, untouched by every choice above
    const testRows: number[] = [];
    const testOuts: Outcome[] = [];
    for (const i of testAll) {
      const oc = outcomeFor(d, i, best.target);
      if (!oc) continue;
      testRows.push(i);
      testOuts.push(oc);
    }
    const testIdx = Int32Array.from(testRows);
    const testProb = testRows.map((i) => predict(best.gbdt, d.X.subarray(i * F, (i + 1) * F)));
    const testAuc = auc(testProb, testOuts.map((o) => o.y));
    const test = simulate(d, testIdx, testOuts, (k) => testProb[k] >= best.th);
    const baseRate = testOuts.length ? testOuts.reduce((a, o) => a + o.y, 0) / testOuts.length : 0;

    // ---- the same periods traded on the plain MemeRadar score, for comparison
    const tuneRows: number[] = [];
    const tuneOuts: Outcome[] = [];
    for (const i of tuneAll) {
      const oc = outcomeFor(d, i, best.target);
      if (!oc) continue;
      tuneRows.push(i);
      tuneOuts.push(oc);
    }
    const tuneIdx = Int32Array.from(tuneRows);
    let baseline: MlModelInfo['baseline'] = null;
    let bestScore: { th: number; sim: Sim } | null = null;
    for (const th of [55, 60, 65, 70, 75, 80, 85]) {
      const sim = simulate(d, tuneIdx, tuneOuts, (k) => d.score[tuneRows[k]] >= th);
      if (sim.trades >= Math.max(3, Math.round(minTrades * 0.6)) && (!bestScore || sim.avgReturn > bestScore.sim.avgReturn))
        bestScore = { th, sim };
    }
    if (bestScore) {
      const th = bestScore.th;
      baseline = { ...cleanSim(simulate(d, testIdx, testOuts, (k) => d.score[testRows[k]] >= th)), threshold: th };
    }

    const problems: string[] = [];
    if (test.trades < minTrades) problems.push(`Only ${test.trades} test trades (needs ${minTrades}): not enough to judge.`);
    if (test.avgReturn < ML.proven.minAvgReturn)
      problems.push(`Test trades averaged ${round(test.avgReturn, 1)}% after fees (needs +${ML.proven.minAvgReturn}% or better).`);
    if (testAuc < ML.proven.minAuc) problems.push(`Its ranking of coins wasn't reliably better than chance (skill ${round(testAuc, 2)}; needs ${ML.proven.minAuc}).`);

    const imp = importance(best.gbdt);
    const impTotal = imp.reduce((a, v) => a + v, 0) || 1;
    const topFeatures = Array.from(imp)
      .map((v, f) => ({ label: FEATURE_LABELS[f], importance: round(v / impTotal, 3) }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    const calibRows = [...tuneRows, ...testRows];
    const calibOuts = [...tuneOuts, ...testOuts];
    const calibProb = calibRows.map((i) => predict(best.gbdt, d.X.subarray(i * F, (i + 1) * F)));
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
      testFrom: t85,
      testTo: d.t[order[n - 1]],
      auc: round(testAuc, 3),
      baseRate: round(baseRate, 3),
      test: cleanSim(test),
      baseline,
      proven: problems.length === 0,
      problems,
      topFeatures,
    };
    current = {
      v: 1,
      schema: ML.schema,
      featureLabels: FEATURE_LABELS,
      gbdt: best.gbdt,
      info,
      threshold: best.th,
      calib: calibrate(calibProb, calibOuts),
    };
    lastNote = null;
    console.log(
      `[ml] trained in ${((Date.now() - startedAt) / 1000).toFixed(1)}s on ${trainAll.length} rows: target +${best.target.tp}/-${best.target.sl}, ` +
        `test AUC ${info.auc}, ${test.trades} test trades averaging ${round(test.avgReturn, 2)}% -> ${info.proven ? 'PROVEN' : 'not proven'}`,
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

/** The model's read on a coin right now (null without a model). */
function signalFor(v: TokenView, p: number): AiSignal {
  const c = current!;
  const win = interp(c.calib.p, c.calib.win, p);
  const ev = interp(c.calib.p, c.calib.ev, p);
  const danger = v.flags.some((f) => f.severity === 'danger');
  return {
    win: round(Number.isFinite(win) ? win : p, 2),
    ev: Number.isFinite(ev) ? round(ev, 1) : null,
    pick: c.info.proven && p >= c.threshold && (v.liquidity ?? 0) >= ML.tradeMinLiquidity && !danger,
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
    v.ai = signalFor(v, predict(current.gbdt, x));
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

/** What the bot needs from the model: is it trustworthy, and what does it trade toward. */
export function modelForBot(): { proven: boolean; target: AiTarget; version: number } | null {
  if (!current) return null;
  return { proven: current.info.proven, target: current.info.target, version: current.info.version };
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
      saved?.v === 1 &&
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
