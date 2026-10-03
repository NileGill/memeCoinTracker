import { gunzipSync, gzipSync } from 'node:zlib';
import { db } from '../auth/db';
import { allEntries, entryInfo, getSolPrice, marketCounts, registerHold } from '../engine/market';
import { ML } from './config';
import { decodeObs, encodeObs, featurize, hasDanger, lockedPool, makeObs, NUM_FEATURES, OBS_FIELDS, type Obs, type ObsContext, type TapeStats } from './features';

/*
 * The model's training data, collected by MemeRadar itself. No free source offers the full
 * history of a memecoin's buyers, sellers, liquidity and holders, so every tracked coin is
 * snapshotted when it appears and every 10 minutes after, and each snapshot's price is then
 * followed for an hour to record what actually happened: which profit and loss levels it hit
 * first, and when. Coins that rug are followed to the end, so losses aren't quietly dropped.
 *
 * Price alone misses one common rug: when the creator pulls the pool's liquidity, the price just
 * freezes (no one can trade), and an hour later it looked like a small win. So the pool's depth is
 * followed too, and a pool that empties counts as a total loss.
 */

const TICK_MS = 5_000;
const horizonSec = ML.horizonMs / 1000;
/** Outcome checkpoints, as fractions of the horizon (15, 30 and 60 minutes). */
const CHECKPOINTS = [0.25, 0.5, 1];
/** A coin whose price feed stopped for this long, while the feeds work for other coins, is treated as rugged. */
const GONE_AFTER_MS = 10 * 60_000;
const GONE_RETURN = -90;
/**
 * A pool whose depth falls under this share of what it was at the snapshot has been emptied: its
 * liquidity was pulled. (Even a 90% price crash leaves about a third of a pool's depth.) It must
 * stay that low this long, so a one-off bad reading doesn't count.
 */
export const PULLED_SHARE = 0.1;
export const PULLED_AFTER_MS = 30_000;

// ---------------------------------------------------------------- live price tape

const TAPE_MS = 12 * 60_000;
const TAPE_STEP = 15_000;
/** Per coin, every ~15s: time, price, liquidity, holders (NaN when unknown). */
const tape = new Map<string, { t: number[]; p: number[]; l: number[]; h: number[] }>();
const solTape: { t: number; p: number }[] = [];
let breadth: number | null = null;
let feedsHealthy = true;

function recordTape(now: number) {
  const seen = new Set<string>();
  let fresh = 0;
  let total = 0;
  let up = 0;
  let known = 0;
  for (const info of allEntries()) {
    const v = info.view;
    seen.add(v.mint);
    // Feed health counts listed coins only: background-followed ones are often dead on purpose.
    if (!info.hidden) {
      total++;
      if (now - info.freshAt < 120_000) fresh++;
      if (v.change.m5 != null) {
        known++;
        if (v.change.m5 > 0) up++;
      }
    }
    const price = v.priceUsd;
    if (price == null || !(price > 0) || now - info.freshAt > 90_000) continue;
    let tp = tape.get(v.mint);
    if (!tp) tape.set(v.mint, (tp = { t: [], p: [], l: [], h: [] }));
    if (!tp.t.length || now - tp.t[tp.t.length - 1] >= TAPE_STEP) {
      tp.t.push(now);
      tp.p.push(price);
      tp.l.push(v.liquidity ?? NaN);
      tp.h.push(v.holders ?? NaN);
    }
    while (tp.t.length && tp.t[0] < now - TAPE_MS) {
      tp.t.shift();
      tp.p.shift();
      tp.l.shift();
      tp.h.shift();
    }
  }
  for (const mint of tape.keys()) if (!seen.has(mint)) tape.delete(mint);
  breadth = known >= 20 ? up / known : null;
  feedsHealthy = total === 0 || fresh / total >= 0.5;

  const sol = getSolPrice();
  if (sol && (!solTape.length || now - solTape[solTape.length - 1].t >= 60_000)) solTape.push({ t: now, p: sol });
  while (solTape.length && solTape[0].t < now - 70 * 60_000) solTape.shift();
}

/** % move from `minutes` ago to the current price, from the tape (null without enough history). */
function tapeReturn(mint: string, minutes: number): number | null {
  const tp = tape.get(mint);
  const now = Date.now();
  const price = entryInfo(mint)?.view.priceUsd;
  if (!tp || !tp.t.length || price == null || !(price > 0)) return null;
  const target = now - minutes * 60_000;
  if (tp.t[0] > target + TAPE_STEP) return null;
  let i = 0;
  while (i + 1 < tp.t.length && tp.t[i + 1] <= target) i++;
  return (price / tp.p[i] - 1) * 100;
}

/** Index of the last tape point at or before `target`, or -1 when the tape doesn't reach back that far. */
function pointAt(t: number[], target: number): number {
  if (!t.length || t[0] > target + TAPE_STEP) return -1;
  let i = 0;
  while (i + 1 < t.length && t[i + 1] <= target) i++;
  return i;
}

const pctChange = (now: number | null | undefined, then: number) =>
  now == null || !Number.isFinite(now) || !Number.isFinite(then) || !(then > 0) ? null : (now / then - 1) * 100;

const NO_STATS: TapeStats = { l3: null, l10: null, h10: null, vol10: null, dd10: null };

/** Liquidity and holder trends, choppiness and drop from the recent high, from the live tape. */
function tapeStats(mint: string): TapeStats {
  const tp = tape.get(mint);
  const view = entryInfo(mint)?.view;
  if (!tp || !view || tp.t.length < 2) return NO_STATS;
  const now = Date.now();
  const i3 = pointAt(tp.t, now - 3 * 60_000);
  const i10 = pointAt(tp.t, now - 10 * 60_000);
  let vol10: number | null = null;
  let dd10: number | null = null;
  if (i10 >= 0) {
    const rets: number[] = [];
    let hi = 0;
    for (let k = i10; k < tp.p.length; k++) {
      hi = Math.max(hi, tp.p[k]);
      if (k > i10) rets.push(Math.log(tp.p[k] / tp.p[k - 1]));
    }
    if (rets.length >= 5) {
      const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
      vol10 = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * 100;
    }
    const price = view.priceUsd;
    if (price != null && price > 0 && hi > 0) dd10 = (Math.max(hi, price) - price) / Math.max(hi, price) * 100;
  }
  return {
    l3: i3 >= 0 ? pctChange(view.liquidity, tp.l[i3]) : null,
    l10: i10 >= 0 ? pctChange(view.liquidity, tp.l[i10]) : null,
    h10: i10 >= 0 ? pctChange(view.holders, tp.h[i10]) : null,
    vol10,
    dd10,
  };
}

function solChange1h(): number | null {
  const sol = getSolPrice();
  if (!sol || !solTape.length || Date.now() - solTape[0].t < 55 * 60_000) return null;
  return (sol / solTape[0].p - 1) * 100;
}

/** Everything a snapshot needs besides the coin itself. Shared with live predictions so both see the same inputs. */
export function obsContext(): ObsContext {
  const { launches1h, grads1h } = marketCounts();
  return { now: Date.now(), tapeReturn, tapeStats, sol1h: solChange1h(), launches1h, grads1h, breadth };
}

// ---------------------------------------------------------------- snapshots and outcomes

export interface Outcome {
  /** Seconds until the price first reached each ML.tpLevels gain (-1 = never within the horizon). */
  tp: number[];
  /**
   * The % move at the next fresh price reading after each gain level was first reached: what a
   * real sell, sent when the target is seen, would get once it lands. A brief spike reads much
   * lower here. Missing in snapshots recorded before this was added.
   */
  tpn?: (number | null)[];
  /**
   * The % move at the next fresh reading after the snapshot: where a buy sent at the snapshot
   * would land. Missing in snapshots recorded before this was added.
   */
  e1?: number | null;
  /** Seconds until it first fell by each ML.slLevels loss (-1 = never). */
  sl: number[];
  /** The actual % move seen when each loss level was first crossed (gaps make it worse than the level). */
  slr: (number | null)[];
  /** % move at 25%, 50% and 100% of the horizon. */
  rq: (number | null)[];
  hi: number;
  lo: number;
  /** Seconds of the horizon covered by fresh prices. */
  last: number;
  /** 1 = the price feed died (treated as a rug). */
  gone: number;
  /** 1 = our own data had a hole (outage): excluded from training. */
  gap: number;
  /**
   * 1 = the pool's liquidity was pulled (also counted as `gone`, with the loss levels hit at -100%).
   * Missing in snapshots recorded before this was added: for those, a price frozen through the
   * second half hour stands in for it (see model.ts).
   */
  pulled?: number;
  /**
   * What the AI decided at this snapshot, while it was proven and up to date: the index in ML.targets
   * it picked the coin for, or -1 if it passed (null: no such AI at the time). Its live record is
   * built from these. Missing in snapshots recorded before this was added.
   */
  pick?: number | null;
}

const OUT_FIELDS = ['tp', 'tpn', 'e1', 'sl', 'slr', 'rq', 'hi', 'lo', 'last', 'gone', 'gap', 'pick', 'pulled'] as const;

interface Open {
  obs: Obs;
  t0: number;
  out: Outcome;
  lastR: number;
  staleSince: number | null;
  /** The price reading (freshAt) at which each gain level was first reached. */
  tpSeenAt: number[];
  /** The price reading the snapshot was taken from. */
  seenAt: number;
  /** Pool depth at the snapshot (same measure as later readings), and since when it has looked emptied. */
  depth0: number | null;
  emptySince: number | null;
}

const open: Open[] = [];

/**
 * Called for every new snapshot (by the model, which decides on the spot whether the bot buys it).
 * Returns what to record as the snapshot's `pick`.
 */
type Judge = (obs: Obs, freshAt: number) => number | null;
let judge: Judge | null = null;
export function setSnapshotJudge(fn: Judge) {
  judge = fn;
}
const openPerMint = new Map<string, number>();
const lastSampled = new Map<string, number>();
const finished: { obs: Obs; out: Outcome }[] = [];

// Keep following coins that have snapshots still waiting for their outcome.
registerHold((mint) => openPerMint.has(mint), false);

const r2 = (v: number) => Math.round(v * 100) / 100;

function sample(now: number) {
  const ctx = obsContext();
  for (const info of allEntries()) {
    if (info.hidden) continue;
    const v = info.view;
    if (!(v.priceUsd! > 0) || (v.liquidity ?? 0) < ML.minLiquidity || now - info.freshAt > 60_000) continue;
    const last = lastSampled.get(v.mint);
    if (last !== undefined && now - last < ML.sampleEveryMs) continue;
    if (open.length >= 20_000) return; // safety valve
    const obs = makeObs(v, ctx);
    if (!obs) continue;
    lastSampled.set(v.mint, now);
    let pick: number | null = null;
    try {
      pick = judge ? judge(obs, info.freshAt) : null;
    } catch (e) {
      console.error('[ml] judging a snapshot failed:', e);
    }
    open.push({
      obs,
      t0: now,
      lastR: 0,
      staleSince: null,
      depth0: info.liquidityLow,
      emptySince: null,
      tpSeenAt: ML.tpLevels.map(() => 0),
      seenAt: info.freshAt,
      out: {
        e1: null,
        tp: ML.tpLevels.map(() => -1),
        tpn: ML.tpLevels.map(() => null),
        sl: ML.slLevels.map(() => -1),
        slr: ML.slLevels.map(() => null),
        rq: CHECKPOINTS.map(() => null),
        hi: 0,
        lo: 0,
        last: 0,
        gone: 0,
        gap: 0,
        pick,
        pulled: 0,
      },
    });
    openPerMint.set(v.mint, (openPerMint.get(v.mint) ?? 0) + 1);
  }
  for (const [mint, t] of lastSampled) if (now - t > ML.sampleEveryMs * 4) lastSampled.delete(mint);
}

/** The pool has been far shallower than at the snapshot for a while: its liquidity was pulled. */
function emptied(o: Open, depth: number | null, now: number): boolean {
  if (depth == null || o.depth0 == null || !(o.depth0 > 0) || depth >= o.depth0 * PULLED_SHARE) {
    o.emptySince = null;
    return false;
  }
  o.emptySince ??= now;
  return now - o.emptySince >= PULLED_AFTER_MS;
}

function follow(now: number) {
  for (let i = open.length - 1; i >= 0; i--) {
    const o = open[i];
    const elapsed = now - o.t0;
    const sec = Math.min(elapsed, ML.horizonMs) / 1000;
    const info = entryInfo(o.obs.mint);
    const price = info?.view.priceUsd;
    let done = elapsed >= ML.horizonMs;

    if (!info) {
      // Only possible if the coin was dropped despite the hold: we can't know what happened.
      o.out.gap = 1;
      done = true;
    } else if (price != null && price > 0 && now - info.freshAt < 120_000 && emptied(o, info.liquidityLow, now)) {
      // The pool's liquidity was pulled: nothing can be sold from here on, whatever the price says.
      o.out.pulled = 1;
      o.out.gone = 1;
      o.lastR = -100;
      o.out.lo = -100;
      o.out.last = sec;
      ML.slLevels.forEach((_, k) => {
        if (o.out.sl[k] < 0) {
          o.out.sl[k] = sec;
          o.out.slr[k] = -100;
        }
      });
      done = true;
    } else if (price != null && price > 0 && now - info.freshAt < 120_000) {
      o.staleSince = null;
      const r = (price / o.obs.price - 1) * 100;
      o.lastR = r;
      if (o.out.e1 == null && info.freshAt > o.seenAt) o.out.e1 = r2(r);
      o.out.hi = Math.max(o.out.hi, r);
      o.out.lo = Math.min(o.out.lo, r);
      o.out.last = sec;
      ML.tpLevels.forEach((lvl, k) => {
        const tpn = o.out.tpn!;
        // A newer reading after the level was reached: where a sell sent at that moment would land.
        if (o.out.tp[k] >= 0 && tpn[k] == null && info.freshAt > o.tpSeenAt[k]) tpn[k] = r2(r);
        if (o.out.tp[k] < 0 && r >= lvl) {
          o.out.tp[k] = sec;
          o.tpSeenAt[k] = info.freshAt;
        }
      });
      ML.slLevels.forEach((lvl, k) => {
        if (o.out.sl[k] < 0 && r <= -lvl) {
          o.out.sl[k] = sec;
          o.out.slr[k] = r2(r);
        }
      });
      CHECKPOINTS.forEach((q, k) => {
        if (o.out.rq[k] == null && elapsed >= q * ML.horizonMs) o.out.rq[k] = r2(r);
      });
    } else {
      o.staleSince ??= now;
      if (now - o.staleSince >= GONE_AFTER_MS) {
        if (feedsHealthy) {
          // Its price feed died while everything else kept updating: count it as a rug.
          o.out.gone = 1;
          o.lastR = GONE_RETURN;
          o.out.lo = Math.min(o.out.lo, GONE_RETURN);
          ML.slLevels.forEach((_, k) => {
            if (o.out.sl[k] < 0) {
              o.out.sl[k] = sec;
              o.out.slr[k] = GONE_RETURN;
            }
          });
        } else o.out.gap = 1;
        done = true;
      }
    }

    if (!done) continue;
    if (!o.out.gone && !o.out.gap && o.out.last < horizonSec * 0.9) o.out.gap = 1; // prices went missing near the end
    o.out.rq = o.out.rq.map((v) => v ?? r2(o.lastR));
    o.out.e1 ??= r2(o.lastR);
    // Reached a level but no newer reading came before the end: the last price is all we know.
    o.out.tpn = o.out.tpn!.map((v, k) => (v == null && o.out.tp[k] >= 0 ? r2(o.lastR) : v));
    o.out.hi = r2(o.out.hi);
    o.out.lo = r2(o.out.lo);
    open.splice(i, 1);
    const left = (openPerMint.get(o.obs.mint) ?? 1) - 1;
    if (left <= 0) openPerMint.delete(o.obs.mint);
    else openPerMint.set(o.obs.mint, left);
    finished.push({ obs: o.obs, out: o.out });
    addRow(o.obs, o.out);
  }
}

// ---------------------------------------------------------------- in-memory training set

/** Values stored per row for outcomes: tp, sl, slr, rq, hi, lo, last, gone, gap, tpn, e1, pick, pulled. */
const NT = ML.tpLevels.length;
const NS = ML.slLevels.length;
const NQ = CHECKPOINTS.length;
const BASE_W = NT + 2 * NS + NQ;
export const OUT_W = BASE_W + 5 + NT + 3;
export const OUT_AT = {
  tp: 0,
  sl: NT,
  slr: NT + NS,
  rq: NT + 2 * NS,
  hi: BASE_W,
  lo: BASE_W + 1,
  last: BASE_W + 2,
  gone: BASE_W + 3,
  gap: BASE_W + 4,
  tpn: BASE_W + 5,
  e1: BASE_W + 5 + NT,
  /** NaN when no AI was being followed (or recorded before this existed). */
  pick: BASE_W + 5 + NT + 1,
  /** 1 = liquidity pulled, 0 = not, NaN = recorded before pulls were tracked. */
  pulled: BASE_W + 5 + NT + 2,
};

const F = NUM_FEATURES;
const CAP = Math.ceil(ML.maxRows * 1.1);

export interface Dataset {
  n: number;
  F: number;
  t: Float64Array;
  mint: Int32Array;
  X: Float32Array;
  out: Float32Array;
  liq: Float32Array;
  danger: Uint8Array;
  /** 1 = launched on pump.fun, so its liquidity can't be pulled: the only coins the bot trades. */
  locked: Uint8Array;
  score: Float32Array;
}

const data: Dataset = {
  n: 0,
  F,
  t: new Float64Array(CAP),
  mint: new Int32Array(CAP),
  X: new Float32Array(CAP * F),
  out: new Float32Array(CAP * OUT_W),
  liq: new Float32Array(CAP),
  danger: new Uint8Array(CAP),
  locked: new Uint8Array(CAP),
  score: new Float32Array(CAP),
};
const mintIds = new Map<string, number>();
/** While the data is being loaded or a model is training, new rows wait here. */
let busy = 0;
const waiting: { obs: Obs; out: Outcome }[] = [];
/** Earliest and latest snapshot time in `data` (kept up to date so status checks don't scan every row). */
let tMin = Infinity;
let tMax = -Infinity;

function recomputeRange() {
  tMin = Infinity;
  tMax = -Infinity;
  for (let k = 0; k < data.n; k++) {
    if (data.t[k] < tMin) tMin = data.t[k];
    if (data.t[k] > tMax) tMax = data.t[k];
  }
}

function writeRow(obs: Obs, out: Outcome) {
  if (data.n >= CAP) {
    // Drop the oldest 10% (rows are appended in time order).
    const drop = Math.ceil(ML.maxRows * 0.1);
    const keep = data.n - drop;
    data.t.copyWithin(0, drop, data.n);
    data.mint.copyWithin(0, drop, data.n);
    data.X.copyWithin(0, drop * F, data.n * F);
    data.out.copyWithin(0, drop * OUT_W, data.n * OUT_W);
    data.liq.copyWithin(0, drop, data.n);
    data.danger.copyWithin(0, drop, data.n);
    data.locked.copyWithin(0, drop, data.n);
    data.score.copyWithin(0, drop, data.n);
    data.n = keep;
    recomputeRange();
  }
  const i = data.n++;
  data.t[i] = obs.t;
  if (obs.t < tMin) tMin = obs.t;
  if (obs.t > tMax) tMax = obs.t;
  let id = mintIds.get(obs.mint);
  if (id === undefined) mintIds.set(obs.mint, (id = mintIds.size));
  data.mint[i] = id;
  featurize(obs, data.X, i * F);
  const o = i * OUT_W;
  out.tp.forEach((v, k) => (data.out[o + OUT_AT.tp + k] = v));
  for (let k = 0; k < NT; k++) data.out[o + OUT_AT.tpn + k] = out.tpn?.[k] ?? NaN;
  data.out[o + OUT_AT.e1] = out.e1 ?? NaN;
  data.out[o + OUT_AT.pick] = out.pick ?? NaN;
  data.out[o + OUT_AT.pulled] = out.pulled ?? NaN;
  out.sl.forEach((v, k) => (data.out[o + OUT_AT.sl + k] = v));
  out.slr.forEach((v, k) => (data.out[o + OUT_AT.slr + k] = v ?? NaN));
  out.rq.forEach((v, k) => (data.out[o + OUT_AT.rq + k] = v ?? NaN));
  data.out[o + OUT_AT.hi] = out.hi;
  data.out[o + OUT_AT.lo] = out.lo;
  data.out[o + OUT_AT.last] = out.last;
  data.out[o + OUT_AT.gone] = out.gone;
  data.out[o + OUT_AT.gap] = out.gap;
  data.liq[i] = obs.liq ?? NaN;
  data.danger[i] = hasDanger(obs) ? 1 : 0;
  data.locked[i] = lockedPool(obs.mint) ? 1 : 0;
  data.score[i] = obs.score ?? NaN;
}

function addRow(obs: Obs, out: Outcome) {
  if (busy > 0) waiting.push({ obs, out });
  else writeRow(obs, out);
}

/**
 * Exclusive use of the training data (no rows are added or moved until `release` is called).
 * Rows are in rough time order; `t` holds each snapshot's time.
 */
export function borrowDataset(): { data: Dataset; release: () => void } {
  busy++;
  let released = false;
  return {
    data,
    release: () => {
      if (released) return;
      released = true;
      busy--;
      if (busy === 0) for (const w of waiting.splice(0)) writeRow(w.obs, w.out);
    },
  };
}

// ---------------------------------------------------------------- database

let tableReady = false;
let loaded = false;
let stored: number | null = null;
let lastRetention = 0;

async function ensureTable() {
  if (!db || tableReady) return;
  await db.query(`
    create table if not exists ml_batches (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      schema int not null,
      n int not null,
      t_min bigint not null,
      t_max bigint not null,
      data bytea not null
    );
    create index if not exists ml_batches_schema_created_idx on ml_batches (schema, created_at);
  `);
  tableReady = true;
}

/** Load recent stored snapshots into memory (newest first until the cap, then applied oldest first). */
async function loadHistory() {
  if (!db) {
    loaded = true; // nothing stored to load (no database): start learning from live data right away
    return;
  }
  busy++;
  const started = Date.now();
  try {
    await ensureTable();
    const { rows: meta } = await db.query<{ id: string; n: number }>(
      `select id, n from ml_batches where schema = $1 and created_at > now() - make_interval(days => $2) order by id desc`,
      [ML.schema, ML.loadDays],
    );
    const pick: string[] = [];
    let total = 0;
    for (const m of meta) {
      if (total >= ML.maxRows) break;
      pick.push(m.id);
      total += m.n;
    }
    pick.reverse();
    let rowsLoaded = 0;
    for (let i = 0; i < pick.length; i += 6) {
      const { rows } = await db.query<{ data: Buffer }>(`select data from ml_batches where id = any($1::bigint[]) order by id`, [
        pick.slice(i, i + 6),
      ]);
      for (const r of rows) {
        const batch = JSON.parse(gunzipSync(r.data).toString('utf8')) as { fields: string[]; out: string[]; rows: unknown[][] };
        const nf = batch.fields.length;
        for (const row of batch.rows) {
          const obs = decodeObs(batch.fields, row.slice(0, nf));
          const outVals: Record<string, unknown> = {};
          batch.out.forEach((k, j) => (outVals[k] = row[nf + j]));
          const out = outVals as unknown as Outcome;
          if (!Array.isArray(out.tp) || !Array.isArray(out.sl) || typeof obs.t !== 'number' || !(obs.price > 0)) continue;
          writeRow(obs, out);
          rowsLoaded++;
        }
        await new Promise((res) => setTimeout(res, 10)); // stay responsive while loading
      }
    }
    await refreshStoredCount();
    console.log(`[ml] loaded ${rowsLoaded} stored snapshots in ${Date.now() - started}ms`);
  } catch (e) {
    console.error('[ml] loading stored snapshots failed:', e instanceof Error ? e.message : e);
  } finally {
    loaded = true;
    busy--;
    if (busy === 0) for (const w of waiting.splice(0)) writeRow(w.obs, w.out);
  }
}

async function refreshStoredCount() {
  if (!db) return;
  const { rows } = await db.query<{ total: string | null }>(`select sum(n) as total from ml_batches where schema = $1`, [ML.schema]);
  stored = Number(rows[0]?.total ?? 0);
}

/** Write finished snapshots to the database (hourly and at shutdown). */
export async function flushSnapshots() {
  if (!finished.length) return;
  if (!db) {
    finished.length = 0; // nowhere to keep them; they're still in memory for training
    return;
  }
  const batch = finished.splice(0, finished.length);
  try {
    await ensureTable();
    const rows = batch.map(({ obs, out }) => [...encodeObs(obs), ...OUT_FIELDS.map((k) => out[k])]);
    const data = gzipSync(JSON.stringify({ fields: OBS_FIELDS, out: OUT_FIELDS, rows }));
    const tMin = batch.reduce((m, b) => Math.min(m, b.obs.t), Infinity);
    const tMax = batch.reduce((m, b) => Math.max(m, b.obs.t), 0);
    await db.query(`insert into ml_batches (schema, n, t_min, t_max, data) values ($1, $2, $3, $4, $5)`, [
      ML.schema,
      batch.length,
      tMin,
      tMax,
      data,
    ]);
    stored = (stored ?? 0) + batch.length;
    if (Date.now() - lastRetention > 24 * 3_600_000) {
      lastRetention = Date.now();
      await db.query(`delete from ml_batches where created_at < now() - make_interval(days => $1)`, [ML.retentionDays]);
      // The free database is small: beyond this many snapshots, drop the oldest batches too.
      await db.query(
        `delete from ml_batches where id in (
           select id from (select id, sum(n) over (order by id desc) as upto from ml_batches where schema = $1) s where upto > $2
         )`,
        [ML.schema, ML.maxStoredRows],
      );
      await refreshStoredCount();
    }
  } catch (e) {
    // Keep them for the next attempt (bounded, in case the database is gone for a long time).
    finished.unshift(...batch.slice(-20_000));
    console.error('[ml] saving snapshots failed:', e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------- status & start

export function recorderStatus() {
  const has = data.n > 0;
  if (has && !(tMin <= tMax)) recomputeRange(); // rows were written some other way (tests)
  return { samples: data.n + waiting.length, pending: open.length, stored, dataFrom: has ? tMin : null, dataTo: has ? tMax : null, loaded };
}

let started = false;
export function startRecorder() {
  if (started) return;
  started = true;
  setInterval(() => {
    const now = Date.now();
    try {
      recordTape(now);
      follow(now);
      sample(now);
    } catch (e) {
      console.error('[ml] recorder tick failed:', e);
    }
  }, TICK_MS).unref();
  // Load stored history in the background, then start the hourly saves.
  void loadHistory().then(() => {
    setInterval(() => void flushSnapshots(), ML.flushEveryMs).unref();
  });
}

/**
 * Snapshots with holes in their price data (unusable), a dead feed or pulled liquidity (rugs), and,
 * among those recorded before pulls were tracked, a price frozen through the second half hour (taken
 * as a pull), recent vs older.
 */
export function dataQuality() {
  const day = Date.now() - 86_400_000;
  const blank = () => ({ rows: 0, holes: 0, gone: 0, pulled: 0, frozen: 0 });
  const q = { last24h: blank(), older: blank() };
  for (let i = 0; i < data.n; i++) {
    const b = data.t[i] >= day ? q.last24h : q.older;
    const o = i * OUT_W;
    b.rows++;
    if (data.out[o + OUT_AT.gap]) b.holes++;
    if (data.out[o + OUT_AT.gone]) b.gone++;
    if (data.out[o + OUT_AT.pulled] === 1) b.pulled++;
    if (frozenOld(data, i)) b.frozen++;
  }
  return q;
}

/**
 * A snapshot recorded before pulled liquidity was tracked, whose price was exactly the same at 30 and
 * 60 minutes: no one traded for half an hour, the mark of a pool whose liquidity was pulled (all ten
 * zero-liquidity exits found on 2026-10-03 looked like this). Counted as a pull.
 */
export function frozenOld(d: Dataset, i: number): boolean {
  const o = i * OUT_W;
  if (!Number.isNaN(d.out[o + OUT_AT.pulled]) || d.out[o + OUT_AT.gap] || d.out[o + OUT_AT.gone]) return false;
  const half = d.out[o + OUT_AT.rq + 1];
  const end = d.out[o + OUT_AT.rq + 2];
  return Number.isFinite(half) && half === end;
}

/** False while most price feeds are down (an outage, not a rug). */
export const feedsOk = () => feedsHealthy;
