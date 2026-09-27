/*
 * Gradient-boosted decision trees for yes/no outcomes (the same family of model as XGBoost
 * and LightGBM, written out here so it runs on the free server with no native dependencies).
 *
 * Each tree is small (depth 3) and corrects the mistakes of the trees before it. Inputs are
 * bucketed into at most 32 bins per feature, missing values get their own bin and learn which
 * way to go at each split. Training yields to the event loop every few milliseconds so the live
 * site stays responsive while a model trains.
 */

export interface GbdtParams {
  rounds: number;
  learningRate: number;
  maxDepth: number;
  /** Fewest training rows allowed in a leaf. */
  minLeaf: number;
  minHess: number;
  /** L2 regularisation on leaf values. */
  lambda: number;
  rowSample: number;
  colSample: number;
  maxBins: number;
  /** Stop when the validation loss hasn't improved for this many rounds. */
  patience: number;
  seed: number;
}

export const DEFAULT_PARAMS: GbdtParams = {
  rounds: 300,
  learningRate: 0.06,
  maxDepth: 3,
  minLeaf: 60,
  minHess: 1,
  lambda: 2,
  rowSample: 0.7,
  colSample: 0.8,
  maxBins: 32,
  patience: 30,
  seed: 7,
};

/** Flat node arrays. feat = -1 marks a leaf. Values are in log-odds. */
export interface Tree {
  feat: number[];
  /** Go left when x <= thr (raw feature value). */
  thr: number[];
  /** The same split in bin space (training only). */
  bin: number[];
  /** Where missing values go. */
  nanLeft: number[];
  left: number[];
  right: number[];
  /** Leaf output; for inner nodes, what the output would be if it stopped there (used to explain predictions). */
  value: number[];
  gain: number[];
}

export interface GbdtModel {
  base: number;
  numFeatures: number;
  trees: Tree[];
}

/** Runs work in short bursts with pauses between them so other requests keep being served. */
export class Pacer {
  private last = performance.now();
  constructor(
    private workMs = 20,
    private restMs = 15,
  ) {}
  async maybeYield() {
    if (performance.now() - this.last < this.workMs) return;
    await new Promise((r) => setTimeout(r, this.restMs));
    this.last = performance.now();
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// ---------------------------------------------------------------- binning

/** Quantile cut points per feature, from (a sample of) the training rows. */
function computeCuts(X: Float32Array, F: number, rows: Int32Array, maxBins: number, rand: () => number): number[][] {
  const take = Math.min(rows.length, 20_000);
  const sample = new Int32Array(take);
  if (take === rows.length) sample.set(rows);
  else for (let i = 0; i < take; i++) sample[i] = rows[Math.floor(rand() * rows.length)];
  const cuts: number[][] = [];
  const vals = new Float64Array(take);
  for (let f = 0; f < F; f++) {
    let m = 0;
    for (let i = 0; i < take; i++) {
      const v = X[sample[i] * F + f];
      if (!Number.isNaN(v)) vals[m++] = v;
    }
    const sorted = vals.subarray(0, m).sort();
    const c: number[] = [];
    for (let k = 1; k < maxBins; k++) {
      const v = sorted[Math.floor((k * m) / maxBins)];
      if (v === undefined) break;
      if (c.length === 0 || v > c[c.length - 1]) c.push(v);
    }
    // A cut at the maximum separates nothing.
    if (m > 0 && c.length && c[c.length - 1] >= sorted[m - 1]) c.pop();
    cuts.push(c);
  }
  return cuts;
}

/** Bin of a value: the first cut it is <= to (so bin <= s exactly when x <= cuts[s]). */
function binOf(cuts: number[], v: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v <= cuts[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function binRows(X: Float32Array, F: number, rows: Int32Array, cuts: number[][], nanBin: number, bins: Uint8Array, pacer: Pacer) {
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const base = r * F;
    for (let f = 0; f < F; f++) {
      const v = X[base + f];
      bins[base + f] = Number.isNaN(v) ? nanBin : binOf(cuts[f], v);
    }
    if ((k & 2047) === 0) await pacer.maybeYield();
  }
}

// ---------------------------------------------------------------- tree building

interface Hist {
  G: Float64Array;
  H: Float64Array;
  C: Float64Array;
}

interface Ctx {
  bins: Uint8Array;
  F: number;
  g: Float64Array;
  h: Float64Array;
  feats: number[];
  nb: number[]; // value bins per feature
  cuts: number[][];
  stride: number;
  nanBin: number;
  P: GbdtParams;
  pacer: Pacer;
}

async function buildHist(c: Ctx, rows: Int32Array): Promise<Hist> {
  const size = c.F * c.stride;
  const G = new Float64Array(size);
  const H = new Float64Array(size);
  const C = new Float64Array(size);
  const { bins, F, g, h, feats, stride } = c;
  const nf = feats.length;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const gr = g[r];
    const hr = h[r];
    const base = r * F;
    for (let j = 0; j < nf; j++) {
      const f = feats[j];
      const o = f * stride + bins[base + f];
      G[o] += gr;
      H[o] += hr;
      C[o] += 1;
    }
    if ((k & 4095) === 0) await c.pacer.maybeYield();
  }
  return { G, H, C };
}

function subtractHist(c: Ctx, parent: Hist, small: Hist): Hist {
  const G = new Float64Array(parent.G.length);
  const H = new Float64Array(parent.H.length);
  const C = new Float64Array(parent.C.length);
  for (const f of c.feats) {
    const o = f * c.stride;
    for (let b = 0; b < c.stride; b++) {
      G[o + b] = parent.G[o + b] - small.G[o + b];
      H[o + b] = parent.H[o + b] - small.H[o + b];
      C[o + b] = parent.C[o + b] - small.C[o + b];
    }
  }
  return { G, H, C };
}

interface Split {
  gain: number;
  f: number;
  s: number;
  nanLeft: number;
}

function bestSplit(c: Ctx, hist: Hist, G: number, H: number, C: number): Split | null {
  const { lambda, minLeaf, minHess } = c.P;
  const parent = (G * G) / (H + lambda);
  let best: Split | null = null;
  const consider = (f: number, s: number, nanLeft: number, gl: number, hl: number, cl: number) => {
    const gr = G - gl;
    const hr = H - hl;
    const cr = C - cl;
    if (cl < minLeaf || cr < minLeaf || hl < minHess || hr < minHess) return;
    const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parent;
    if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, f, s, nanLeft };
  };
  for (const f of c.feats) {
    const o = f * c.stride;
    const nbf = c.nb[f];
    const gN = hist.G[o + c.nanBin];
    const hN = hist.H[o + c.nanBin];
    const cN = hist.C[o + c.nanBin];
    let gl = 0;
    let hl = 0;
    let cl = 0;
    for (let s = 0; s < nbf; s++) {
      gl += hist.G[o + s];
      hl += hist.H[o + s];
      cl += hist.C[o + s];
      // Values in bins <= s go left; missing values go right. (s = last bin: "is it missing?")
      consider(f, s, 0, gl, hl, cl);
      if (cN > 0 && s < nbf - 1) consider(f, s, 1, gl + gN, hl + hN, cl + cN);
    }
  }
  return best;
}

async function buildTree(c: Ctx, rows: Int32Array): Promise<Tree> {
  const tree: Tree = { feat: [], thr: [], bin: [], nanLeft: [], left: [], right: [], value: [], gain: [] };
  const { lambda, learningRate, maxDepth, minLeaf } = c.P;
  const newNode = () => {
    tree.feat.push(-1);
    tree.thr.push(0);
    tree.bin.push(0);
    tree.nanLeft.push(0);
    tree.left.push(-1);
    tree.right.push(-1);
    tree.value.push(0);
    tree.gain.push(0);
    return tree.feat.length - 1;
  };
  const sums = (rs: Int32Array) => {
    let G = 0;
    let H = 0;
    for (let k = 0; k < rs.length; k++) {
      G += c.g[rs[k]];
      H += c.h[rs[k]];
    }
    return { G, H };
  };

  interface Pending {
    id: number;
    rows: Int32Array;
    G: number;
    H: number;
    depth: number;
    hist: Hist | null;
  }
  const root = sums(rows);
  const queue: Pending[] = [
    { id: newNode(), rows, G: root.G, H: root.H, depth: 0, hist: maxDepth > 0 ? await buildHist(c, rows) : null },
  ];

  while (queue.length) {
    const node = queue.shift()!;
    tree.value[node.id] = (-node.G / (node.H + lambda)) * learningRate;
    if (node.depth >= maxDepth || node.rows.length < 2 * minLeaf || !node.hist) continue;
    const split = bestSplit(c, node.hist, node.G, node.H, node.rows.length);
    if (!split) continue;

    const { f, s, nanLeft } = split;
    let nl = 0;
    for (let k = 0; k < node.rows.length; k++) {
      const b = c.bins[node.rows[k] * c.F + f];
      if (b === c.nanBin ? nanLeft === 1 : b <= s) nl++;
    }
    const L = new Int32Array(nl);
    const R = new Int32Array(node.rows.length - nl);
    let li = 0;
    let ri = 0;
    for (let k = 0; k < node.rows.length; k++) {
      const r = node.rows[k];
      const b = c.bins[r * c.F + f];
      if (b === c.nanBin ? nanLeft === 1 : b <= s) L[li++] = r;
      else R[ri++] = r;
    }

    tree.feat[node.id] = f;
    tree.bin[node.id] = s;
    tree.thr[node.id] = s < c.nb[f] - 1 ? c.cuts[f][s] : Number.MAX_VALUE;
    tree.nanLeft[node.id] = nanLeft;
    tree.gain[node.id] = split.gain;
    const leftId = newNode();
    const rightId = newNode();
    tree.left[node.id] = leftId;
    tree.right[node.id] = rightId;

    const depth = node.depth + 1;
    let hl: Hist | null = null;
    let hr: Hist | null = null;
    if (depth < maxDepth) {
      // Build the histogram of the smaller child and get the other by subtraction.
      if (L.length <= R.length) {
        hl = await buildHist(c, L);
        hr = subtractHist(c, node.hist, hl);
      } else {
        hr = await buildHist(c, R);
        hl = subtractHist(c, node.hist, hr);
      }
    }
    const sl = sums(L);
    const sr = sums(R);
    queue.push({ id: leftId, rows: L, G: sl.G, H: sl.H, depth, hist: hl });
    queue.push({ id: rightId, rows: R, G: sr.G, H: sr.H, depth, hist: hr });
    await c.pacer.maybeYield();
  }
  return tree;
}

function leafByBins(t: Tree, bins: Uint8Array, F: number, r: number, nanBin: number): number {
  let i = 0;
  while (t.feat[i] >= 0) {
    const b = bins[r * F + t.feat[i]];
    i = b === nanBin ? (t.nanLeft[i] ? t.left[i] : t.right[i]) : b <= t.bin[i] ? t.left[i] : t.right[i];
  }
  return t.value[i];
}

function logloss(pred: Float64Array, y: Float32Array, rows: Int32Array): number {
  let s = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const p = Math.min(1 - 1e-7, Math.max(1e-7, sigmoid(pred[r])));
    s -= y[r] ? Math.log(p) : Math.log(1 - p);
  }
  return rows.length ? s / rows.length : 0;
}

// ---------------------------------------------------------------- training

export interface FitResult {
  model: GbdtModel;
  rounds: number;
  validLoss: number | null;
  /** Probability for every row in `valid`, in the same order. */
  validProb: Float64Array | null;
}

/**
 * Fit on rows `train` of X (row-major, F features, NaN = missing) with 0/1 labels y.
 * With `valid`, stops early when the validation loss stops improving and keeps the best round.
 */
export async function fitGbdt(opts: {
  X: Float32Array;
  F: number;
  y: Float32Array;
  train: Int32Array;
  valid?: Int32Array;
  params?: Partial<GbdtParams>;
  pacer?: Pacer;
}): Promise<FitResult> {
  const P: GbdtParams = { ...DEFAULT_PARAMS, ...opts.params };
  if (P.maxBins > 255 || P.maxBins < 2) throw new Error('maxBins must be 2..255');
  const { X, F, y, train } = opts;
  const valid = opts.valid ?? new Int32Array(0);
  const pacer = opts.pacer ?? new Pacer();
  const rand = mulberry32(P.seed);
  const N = Math.floor(X.length / F);
  if (!train.length) throw new Error('no training rows');

  const cuts = computeCuts(X, F, train, P.maxBins, rand);
  const nanBin = P.maxBins;
  const bins = new Uint8Array(N * F);
  await binRows(X, F, train, cuts, nanBin, bins, pacer);
  await binRows(X, F, valid, cuts, nanBin, bins, pacer);

  let pos = 0;
  for (let k = 0; k < train.length; k++) pos += y[train[k]];
  const rate = Math.min(1 - 1e-4, Math.max(1e-4, pos / train.length));
  const base = Math.log(rate / (1 - rate));

  const pred = new Float64Array(N).fill(base);
  const g = new Float64Array(N);
  const h = new Float64Array(N);
  const allFeats = Array.from({ length: F }, (_, f) => f);
  const ctx: Ctx = {
    bins,
    F,
    g,
    h,
    feats: allFeats,
    nb: cuts.map((c) => c.length + 1),
    cuts,
    stride: P.maxBins + 1,
    nanBin,
    P,
    pacer,
  };

  const trees: Tree[] = [];
  let best = Infinity;
  let bestRounds = 0;
  for (let round = 0; round < P.rounds; round++) {
    for (let k = 0; k < train.length; k++) {
      const r = train[k];
      const p = sigmoid(pred[r]);
      g[r] = p - y[r];
      h[r] = Math.max(p * (1 - p), 1e-6);
    }
    let rows = train;
    if (P.rowSample < 1) {
      const picked: number[] = [];
      for (let k = 0; k < train.length; k++) if (rand() < P.rowSample) picked.push(train[k]);
      rows = Int32Array.from(picked);
    }
    const feats = allFeats.slice();
    for (let i = feats.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [feats[i], feats[j]] = [feats[j], feats[i]];
    }
    ctx.feats = feats.slice(0, Math.max(1, Math.ceil(P.colSample * F))).sort((a, b) => a - b);

    const tree = await buildTree(ctx, rows);
    trees.push(tree);
    for (let k = 0; k < train.length; k++) pred[train[k]] += leafByBins(tree, bins, F, train[k], nanBin);
    for (let k = 0; k < valid.length; k++) pred[valid[k]] += leafByBins(tree, bins, F, valid[k], nanBin);
    await pacer.maybeYield();

    if (valid.length) {
      const loss = logloss(pred, y, valid);
      if (loss < best - 1e-7) {
        best = loss;
        bestRounds = round + 1;
      } else if (round + 1 - bestRounds >= P.patience) break;
    } else bestRounds = round + 1;
  }

  const model: GbdtModel = { base, numFeatures: F, trees: trees.slice(0, bestRounds) };
  let validProb: Float64Array | null = null;
  if (valid.length) {
    // Recompute from the kept trees only (the loop above may have added a few past the best round).
    validProb = new Float64Array(valid.length);
    for (let k = 0; k < valid.length; k++) {
      let z = base;
      for (const t of model.trees) z += leafByBins(t, bins, F, valid[k], nanBin);
      validProb[k] = sigmoid(z);
    }
  }
  return { model, rounds: bestRounds, validLoss: valid.length ? best : null, validProb };
}

// ---------------------------------------------------------------- using a model

function walk(t: Tree, x: ArrayLike<number>, visit?: (node: number, next: number) => void): number {
  let i = 0;
  while (t.feat[i] >= 0) {
    const v = x[t.feat[i]];
    const next = Number.isNaN(v) ? (t.nanLeft[i] ? t.left[i] : t.right[i]) : v <= t.thr[i] ? t.left[i] : t.right[i];
    visit?.(i, next);
    i = next;
  }
  return i;
}

/** Probability of a "yes" for one row of raw features (use a Float32Array so values match training). */
export function predict(m: GbdtModel, x: ArrayLike<number>): number {
  let z = m.base;
  for (const t of m.trees) z += t.value[walk(t, x)];
  return sigmoid(z);
}

/** How much each feature pushed this prediction up or down (in log-odds). */
export function contributions(m: GbdtModel, x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(m.numFeatures);
  for (const t of m.trees) walk(t, x, (node, next) => (out[t.feat[node]] += t.value[next] - t.value[node]));
  return out;
}

/** Total split gain per feature: which inputs the model relies on most. */
export function importance(m: GbdtModel): Float64Array {
  const out = new Float64Array(m.numFeatures);
  for (const t of m.trees) t.feat.forEach((f, i) => f >= 0 && (out[f] += t.gain[i]));
  return out;
}

/** Area under the ROC curve: 0.5 = no better than chance, 1 = perfect ranking. Ties count half. */
export function auc(scores: ArrayLike<number>, labels: ArrayLike<number>): number {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let pos = 0;
  let rankSum = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      if (labels[idx[k]]) {
        pos++;
        rankSum += avgRank;
      }
    }
    i = j + 1;
  }
  const neg = n - pos;
  if (!pos || !neg) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
