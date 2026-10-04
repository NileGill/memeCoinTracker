import type {
  AiTarget,
  BotEvent,
  PaperAccountView,
  PaperBucket,
  PaperExit,
  PaperPosition,
  PaperSettings,
  PaperStats,
  PaperStrategy,
  PaperTrade,
  ReadinessCheck,
  TokenView,
} from '../../../shared/types';
import { db } from '../auth/db';
import { entryInfo, followInBackground, getSolPrice, registerHold } from '../engine/market';
import { connectedUsers, sendToUser } from '../lib/bus';
import { ML } from '../ml/config';
import { modelForBot, modelLoaded, notFollowingReason, snapshotSignalsSince, type SnapshotSignal } from '../ml/model';
import { jupPrices } from '../sources/jupiter';
import { lpSafety } from '../sources/rugcheck';
import { feedsOk, PULLED_AFTER_MS, PULLED_SHARE } from '../ml/recorder';

/*
 * Paper trading: a bot per account that trades fake SOL on the live market, 24/7 on the
 * server, so the strategy's real-world results can be judged before any real money is used.
 *
 * Fills are modelled on how memecoin pools actually trade, and err on the pessimistic side:
 *  - Slippage uses constant-product pool math: buying or selling a large amount relative to a
 *    pool's liquidity gets a much worse price, and you can never take out more than the pool
 *    holds. (The first version capped slippage at 50%, which let big positions "sell" into
 *    near-empty pools and produced absurd profits.)
 *  - Pool depth is measured from the pool's actual SOL (or dollar) reserve, checked against
 *    DexScreener and Jupiter; coins where the sources disagree wildly are skipped.
 *  - Trade size is capped at a small share of the pool and an absolute SOL amount, so the bot
 *    never buys more than a coin can absorb.
 *  - Take-profits fill at the target price, never at a momentary spike above it; stop-losses
 *    fill at the price actually seen (often worse than the stop).
 *  - It trades exactly the way the AI was tested: it buys only at the AI's 10-minute snapshots,
 *    measures the target and stop from the price the coin was picked at, and cancels a buy whose
 *    price ran up past the slippage limit before it landed.
 *  - It only buys coins launched on pump.fun, whose pool liquidity is locked for good when they
 *    graduate (double-checked with RugCheck), that are at least an hour old and traded by real
 *    wallets: pulled liquidity, then launch-pump-dump factories, were behind most of its losses.
 *  - Every swap pays a 1% pool/router fee and a network fee; a coin whose price feed dies, or
 *    whose pool is emptied (liquidity pulled: the price freezes but nothing can be sold), counts
 *    as a total loss.
 */

const TICK_MS = 5_000;
const FEE_SOL = 0.0005; // network + priority fee per swap
const FEE = 0.01; // pool + router fee per side
const MAX_TRADES = 500;
const TOP_N = 25;
const CURVE_EVERY_MS = ML.fast ? 30_000 : 15 * 60_000;
const CURVE_MAX = 1_000;
const GONE_AFTER_MS = 10 * 60_000;
const MAX_ACCOUNTS = 500;
const RISKY = new Set(['bots', 'copycat', 'dumping']);
/** Accounts started after realistic fills were introduced. Older ones are flagged as overstated. */
const FILL_MODEL = 2;

export const DEFAULT_PAPER_SETTINGS: PaperSettings = {
  sizePct: 10,
  maxOpen: 5,
  mode: 'auto',
  scoreMin: 75,
  minLiquidity: 20_000,
  maxTradeSol: 2,
  maxPoolPct: 0.25,
  paused: false,
};

interface Totals {
  closed: number;
  wins: number;
  sumPct: number;
  winSol: number;
  lossSol: number;
  best: number | null;
  worst: number | null;
}

interface Account {
  userId: string;
  createdAt: number;
  startBalance: number;
  cash: number;
  settings: PaperSettings;
  positions: PaperPosition[];
  trades: PaperTrade[];
  bestTrades: PaperTrade[];
  worstTrades: PaperTrade[];
  byReason: Partial<Record<PaperExit, PaperBucket>>;
  byStrategy: Partial<Record<PaperStrategy, PaperBucket>>;
  totals: Totals;
  curve: [number, number][];
  cooldown: Record<string, number>;
  missingSince: Record<string, number>;
  feesSol: number;
  seq: number;
  lastCurveAt: number;
  updatedAt: number;
  fillModel?: number;
}

const accounts = new Map<string, Account>();
const dirty = new Set<string>();
let ready = false;

// Open positions keep their coin's price followed even after it drops off the lists.
registerHold((mint) => {
  for (const a of accounts.values()) if (a.positions.some((p) => p.mint === mint)) return true;
  return false;
}, true);

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Constant-product pool: swapping `usd` worth in (valued at the pre-trade price) against a pool
 * with `liquidity` USD in total (half on each side) returns this much value at that price.
 * Small trades lose almost nothing; a trade as big as the pool's side loses half; you can never
 * get more than the side holds.
 */
export function swapOut(usd: number, liquidity: number): number {
  const side = liquidity / 2;
  if (!(side > 0) || !(usd > 0)) return 0;
  return (usd * side) / (side + usd);
}

interface Live {
  price: number;
  view: TokenView;
  /** Conservative pool liquidity, USD. */
  liquidity: number | null;
  liquidityConflict: boolean;
  /** When this price reading arrived from the data feed. */
  freshAt: number;
}

function live(mint: string, now: number): Live | null {
  const info = entryInfo(mint);
  const price = info?.view.priceUsd;
  if (!info || price == null || !(price > 0) || now - info.freshAt > 120_000) return null;
  return { price, view: info.view, liquidity: info.liquidityLow, liquidityConflict: info.liquidityConflict, freshAt: info.freshAt };
}

/** The price the target and stop are measured from: the price when the coin was picked. */
const refPrice = (p: PaperPosition) => p.refPrice ?? p.entryPrice;
/** Take-profits fill at the target price, never above it (a momentary spike isn't a fill). */
const tpPrice = (p: PaperPosition) => refPrice(p) * (1 + p.target.tp / 100);

/** SOL you'd get selling the whole position at `price` into a pool of `liquidity`, after fees. */
function saleProceeds(p: PaperPosition, price: number, liquidity: number | null | undefined, sol: number) {
  const valueUsd = p.qty * price;
  const outUsd = swapOut(valueUsd, liquidity ?? 0) * (1 - FEE);
  return { valueUsd, outUsd, proceeds: Math.max(0, outUsd / sol - FEE_SOL) };
}

function positionValue(p: PaperPosition, sol: number, now: number): number {
  if (p.pending) return p.costSol; // the SOL is set aside until the buy fills
  const l = live(p.mint, now);
  const price = Math.min(l?.price ?? p.lastPrice, tpPrice(p));
  return saleProceeds(p, price, l?.liquidity ?? p.lastLiquidity ?? p.entryLiquidity, sol).proceeds;
}

function equityOf(a: Account, sol: number | null, now = Date.now()): number {
  if (!sol) return a.cash + a.positions.reduce((s, p) => s + p.costSol, 0);
  return a.cash + a.positions.reduce((s, p) => s + positionValue(p, sol, now), 0);
}

function pushCurve(a: Account, now: number, sol: number | null) {
  a.curve.push([now, r6(equityOf(a, sol, now))]);
  a.lastCurveAt = now;
  if (a.curve.length > CURVE_MAX) {
    // Thin the older half so the chart keeps its whole history.
    const half = Math.floor(a.curve.length / 2);
    a.curve = [...a.curve.slice(0, half).filter((_, i) => i % 2 === 0), ...a.curve.slice(half)];
  }
}

function touchAccount(a: Account) {
  a.updatedAt = Date.now();
  dirty.add(a.userId);
}

// ---------------------------------------------------------------- trading

const scoreTarget = (): AiTarget => ({ ...ML.scoreTarget, holdMin: Math.round(ML.horizonMs / 60_000) });

/**
 * Paper bots trade the AI's picks whether or not it has passed its test: it's fake money, and the point
 * is to see how it really does. (Real money would need it proven: see the readiness checklist.) The
 * MemeRadar score is only used before there is any AI, if the account allows it.
 */
function strategyFor(a: Account, model: ReturnType<typeof modelForBot>): PaperStrategy | null {
  if (!modelLoaded()) return null; // starting up: don't mistake "not loaded yet" for "no model"
  if (model) return 'model';
  return a.settings.mode === 'auto' ? 'score' : null;
}

/** The most SOL this account would put into this coin right now (0 = don't buy). */
function tradeSize(a: Account, liquidity: number, sol: number, now: number): number {
  const equity = equityOf(a, sol, now);
  const poolCapSol = (liquidity * a.settings.maxPoolPct) / 100 / sol;
  const size = Math.min((equity * a.settings.sizePct) / 100, a.settings.maxTradeSol, poolCapSol, a.cash - FEE_SOL);
  return size >= 0.01 ? size : 0;
}

/**
 * Place a buy. Like a real order, it lands a moment later: it fills at the next fresh price
 * reading after the snapshot (see fill), not at the price that triggered it. The SOL is set aside
 * meanwhile. The target, stop and time limit count from the snapshot, as in the AI's test.
 */
function open(a: Account, l: Live, size: number, strategy: PaperStrategy, target: AiTarget, now: number, pickedAt: number) {
  const v = l.view;
  a.cash = r6(a.cash - size - FEE_SOL);
  a.positions.push({
    id: `${now.toString(36)}-${(a.seq++).toString(36)}`,
    mint: v.mint,
    symbol: v.symbol,
    icon: v.icon,
    openedAt: now,
    entryPrice: l.price,
    refPrice: l.price,
    qty: 0,
    costSol: r6(size + FEE_SOL),
    target,
    closeBy: pickedAt + target.holdMin * 60_000,
    strategy,
    signal: strategy === 'model' ? (v.ai?.win ?? 0) : (v.score ?? 0),
    lastPrice: l.price,
    lastPriceAt: now,
    entryLiquidity: Math.round(l.liquidity!),
    lastLiquidity: Math.round(l.liquidity!),
    pending: true,
    entrySeenAt: l.freshAt,
  });
  touchAccount(a);
}

/** The buy lands: price and pool as of this (newer) reading, with slippage and fees. */
function fill(a: Account, pos: PaperPosition, l: Live, sol: number, now: number) {
  // The price ran up past the slippage limit since the pick: like a real swap, the buy fails. (No
  // cooldown, as in the test: the coin can be bought at a later snapshot.)
  if (l.price > refPrice(pos) * (1 + ML.maxChasePct / 100)) {
    noteSkipped(a.userId, pos.mint, 'chase', now);
    return cancel(a, pos, false);
  }
  const picked = pos.entryLiquidity ?? 0;
  const liquidity = l.liquidity ?? pos.entryLiquidity ?? 0;
  const size = pos.costSol - FEE_SOL;
  const gotUsd = swapOut(size * sol * (1 - FEE), liquidity);
  pos.qty = gotUsd / l.price;
  pos.entryPrice = l.price;
  pos.openedAt = now;
  pos.lastPrice = l.price;
  pos.lastPriceAt = now;
  pos.entryLiquidity = Math.round(liquidity);
  pos.lastLiquidity = Math.round(liquidity);
  pos.pending = false;
  delete pos.entrySeenAt;
  a.feesSol += (size * sol - gotUsd) / sol + FEE_SOL;
  touchAccount(a);
  emit(a, { type: 'open', position: pos });
  // The pool was emptied between the pick and the buy: the SOL went into a pool with nothing in it.
  if (picked > 0 && liquidity < picked * PULLED_SHARE) close(a, pos, 'gone', l.price, now, sol);
}

/** A buy that never got a price to fill at, ran past the slippage limit, or you cancelled: give the SOL back. */
function cancel(a: Account, pos: PaperPosition, cooldown = true) {
  a.cash = r6(a.cash + pos.costSol);
  if (cooldown) a.cooldown[pos.mint] = Date.now() + ML.cooldownMs;
  a.positions = a.positions.filter((p) => p.id !== pos.id);
  delete a.missingSince[pos.id];
  touchAccount(a);
  sendToUser(a.userId, 'bot', accountView(a));
}

function bump(map: Partial<Record<string, PaperBucket>>, key: string, pnlSol: number) {
  const b = (map[key] ??= { trades: 0, wins: 0, pnlSol: 0 });
  b.trades++;
  if (pnlSol > 0) b.wins++;
  b.pnlSol = r6(b.pnlSol + pnlSol);
}

/** Keep the all-time best (or worst) trades, sorted. */
function keepTop(list: PaperTrade[], t: PaperTrade, better: (x: PaperTrade, y: PaperTrade) => number): PaperTrade[] {
  return [...list, t].sort(better).slice(0, TOP_N);
}

function close(a: Account, pos: PaperPosition, why: PaperExit, seenPrice: number, now: number, sol: number) {
  const l = live(pos.mint, now);
  const liquidity = l?.liquidity ?? pos.lastLiquidity ?? pos.entryLiquidity ?? 0;
  const price = why === 'tp' ? Math.min(seenPrice, tpPrice(pos)) : seenPrice;
  // The target's gain over what the buy paid (the target is set from the pick price, so this
  // differs a little from the nominal +X%).
  const goal = (tpPrice(pos) / pos.entryPrice - 1) * 100;
  // The price reached the target, but by the time the sale landed it had fallen back: under 90% of
  // the target's gain (e.g. below +45% for a +50% target) it doesn't count as "target hit".
  const reason: PaperExit = why === 'tp' && (price / pos.entryPrice - 1) * 100 < goal * 0.9 ? 'faded' : why;
  const { valueUsd, proceeds } = reason === 'gone' ? { valueUsd: 0, proceeds: 0 } : saleProceeds(pos, price, liquidity, sol);
  if (reason !== 'gone') a.feesSol += Math.max(0, (valueUsd / sol) - proceeds);
  a.cash = r6(a.cash + proceeds);
  a.positions = a.positions.filter((p) => p.id !== pos.id);
  delete a.missingSince[pos.id];
  emptySince.delete(pos.id);
  const pnlSol = proceeds - pos.costSol;
  const pnlPct = (proceeds / pos.costSol - 1) * 100;
  const trade: PaperTrade = {
    id: pos.id,
    mint: pos.mint,
    symbol: pos.symbol,
    icon: pos.icon,
    openedAt: pos.openedAt,
    closedAt: now,
    entryPrice: pos.entryPrice,
    exitPrice: reason === 'gone' ? 0 : price,
    costSol: pos.costSol,
    proceedsSol: r6(proceeds),
    pnlSol: r6(pnlSol),
    pnlPct: r2(pnlPct),
    reason,
    strategy: pos.strategy,
    signal: pos.signal,
    entryLiquidity: pos.entryLiquidity,
    exitLiquidity: Math.round(liquidity),
    targetPct: r2(goal),
    refPrice: refPrice(pos),
  };
  a.trades.unshift(trade);
  if (a.trades.length > MAX_TRADES) a.trades.length = MAX_TRADES;
  a.bestTrades = keepTop(a.bestTrades, trade, (x, y) => y.pnlSol - x.pnlSol);
  a.worstTrades = keepTop(a.worstTrades, trade, (x, y) => x.pnlSol - y.pnlSol);
  bump(a.byReason, reason, pnlSol);
  bump(a.byStrategy, pos.strategy, pnlSol);
  const t = a.totals;
  t.closed++;
  t.sumPct += pnlPct;
  if (pnlSol > 0) {
    t.wins++;
    t.winSol += pnlSol;
  } else t.lossSol -= pnlSol;
  t.best = t.best == null ? pnlPct : Math.max(t.best, pnlPct);
  t.worst = t.worst == null ? pnlPct : Math.min(t.worst, pnlPct);
  a.cooldown[pos.mint] = now + ML.cooldownMs;
  pushCurve(a, now, sol);
  touchAccount(a);
  emit(a, { type: 'close', trade });
}

/**
 * The target was just seen: sell at the price a few seconds later, the way a real bot's sale lands
 * (the price feeds only refresh every 10-25 seconds, and waiting for the next refresh let brief
 * spikes fade into losing "target hit" trades). If the price can't be fetched, or looks wrong, the
 * next refresh completes the sale as before.
 */
async function sellNow(userId: string, posId: string, seenPrice: number) {
  const mint = accounts.get(userId)?.positions.find((p) => p.id === posId)?.mint;
  if (!mint) return;
  let price: number | null = null;
  try {
    price = (await jupPrices([mint], 'trade', 5_000))[mint] ?? null;
  } catch {
    return;
  }
  // The account may have changed meanwhile (sold, reloaded by another server, shutting down).
  const a = accounts.get(userId);
  const pos = a?.positions.find((p) => p.id === posId);
  const sol = getSolPrice();
  if (!a || !pos || pos.pending || pos.tpSeenAt == null || !sol || stopping) return;
  // A different source: ignore a price wildly off the one just seen (a glitch, not a move).
  if (price == null || !(price > 0) || price < seenPrice * 0.5 || price > seenPrice * 2) return;
  close(a, pos, 'tp', price, Date.now(), sol);
}

/** Since when each open position's pool has looked emptied (memory only: re-detected after a restart). */
const emptySince = new Map<string, number>();

/** Sell positions that hit their target, stop, or time limit. */
function manage(a: Account, now: number, sol: number) {
  for (const pos of [...a.positions]) {
    const l = live(pos.mint, now);
    if (pos.pending) {
      if (l && l.freshAt > (pos.entrySeenAt ?? 0)) {
        delete a.missingSince[pos.id];
        fill(a, pos, l, sol, now);
      } else if (!l && now - (a.missingSince[pos.id] ??= now) >= 60_000) cancel(a, pos);
      continue;
    }
    if (l) {
      delete a.missingSince[pos.id];
      pos.lastPrice = l.price;
      pos.lastPriceAt = now;
      if (l.liquidity != null) pos.lastLiquidity = Math.round(l.liquidity);
      // The pool was emptied (liquidity pulled): the price freezes but nothing can be sold. Count it
      // as the total loss it is now, instead of an hour later at the time limit, and free the slot.
      if (l.liquidity != null && pos.entryLiquidity && l.liquidity < pos.entryLiquidity * PULLED_SHARE) {
        const since = emptySince.get(pos.id) ?? now;
        emptySince.set(pos.id, since);
        if (now - since >= PULLED_AFTER_MS) {
          emptySince.delete(pos.id);
          close(a, pos, 'gone', l.price, now, sol);
          continue;
        }
      } else emptySince.delete(pos.id);
      // From the pick price, like the test: the target is +X% and the stop -Y% from there.
      const move = (l.price / refPrice(pos) - 1) * 100;
      // Target seen: the sale lands at the next fresh reading, like a real sell sent at that moment
      // (a brief spike has usually faded by then). Capped at the target price in close().
      if (pos.tpSeenAt != null) {
        if (l.freshAt > pos.tpSeenAt) close(a, pos, 'tp', l.price, now, sol);
        continue;
      }
      if (move >= pos.target.tp) {
        pos.tpSeenAt = l.freshAt;
        void sellNow(a.userId, pos.id, l.price);
      }
      else if (move <= -pos.target.sl) close(a, pos, 'sl', l.price, now, sol);
      else if (now >= pos.closeBy) close(a, pos, 'time', l.price, now, sol);
      continue;
    }
    const since = (a.missingSince[pos.id] ??= now);
    // Its price stopped updating while other coins' prices kept coming: treat as rugged.
    if (now - since >= GONE_AFTER_MS && feedsOk()) close(a, pos, 'gone', 0, now, sol);
  }
}

interface Candidate {
  /** The coin as of its snapshot: price is the picked price, freshAt that reading's time. */
  live: Live;
  rank: number;
  signal: SnapshotSignal;
}

/**
 * Coins the model picked, and coins the MemeRadar score likes (used until the model is followed),
 * at the snapshots just taken: the only moments the bot buys, because they're what the AI's test
 * traded on. Score picks skip coins the crash model rates too likely to crash, once it has shown
 * it can. Coins with untrustworthy liquidity data are never bought.
 */
function candidates(now: number, fresh: SnapshotSignal[]) {
  const model: Candidate[] = [];
  const score: Candidate[] = [];
  for (const s of fresh) {
    if (now - s.at > 30_000) continue; // too late to act on it the way the test did
    if (!s.tradeable) continue; // not a coin the bot trades (or the AI is tested on): see tradeableCoin
    const info = entryInfo(s.mint);
    if (!info || info.hidden) continue;
    const v = info.view;
    const liq = info.liquidityLow;
    if (liq == null || liq < ML.tradeMinLiquidity || info.liquidityConflict) continue;
    // A pool's coin side can't be worth more than the whole coin (depth is both sides), so a much
    // deeper pool than that means the numbers are off.
    if (v.mcap != null && v.mcap > 0 && liq > v.mcap * 2.5) continue;
    if (v.flags.some((f) => f.severity === 'danger')) continue;
    const l: Live = { price: s.price, view: v, liquidity: liq, liquidityConflict: false, freshAt: s.freshAt };
    if (s.pick && s.target) model.push({ live: l, rank: s.rank, signal: s });
    if (s.score != null && s.score >= 60 && s.scoreSafe && !v.flags.some((f) => RISKY.has(f.code))) score.push({ live: l, rank: s.score, signal: s });
  }
  model.sort((x, y) => y.rank - x.rank);
  score.sort((x, y) => y.rank - x.rank);
  return { model, score };
}

/** The last snapshot the bot has looked at, and snapshots waiting on a RugCheck answer (looked at again next tick). */
let seenSignal = 0;
const retrySignals = new Map<number, SnapshotSignal>();

/**
 * Per account, over the last hour: coins its strategy wanted, those its own settings ruled out
 * (thinner than its minimum liquidity, or a trade too small to place), and buys cancelled because
 * the price ran past the slippage limit. Shown in the bot's status so a quiet bot explains itself.
 * Memory only.
 */
const wanted = new Map<string, Map<string, number>>();
type SkipWhy = 'liquidity' | 'size' | 'chase' | 'pullable' | 'unchecked';
const skipped = new Map<string, Map<string, { at: number; why: SkipWhy }>>();
const HOUR = 3_600_000;

function noteWanted(userId: string, mint: string, now: number) {
  let m = wanted.get(userId);
  if (!m) wanted.set(userId, (m = new Map()));
  m.set(mint, now);
}

function noteSkipped(userId: string, mint: string, why: SkipWhy, now: number) {
  let m = skipped.get(userId);
  if (!m) skipped.set(userId, (m = new Map()));
  m.set(mint, { at: now, why });
}

function forgetOld(now: number) {
  for (const m of wanted.values()) for (const [mint, at] of m) if (now - at > HOUR) m.delete(mint);
  for (const m of skipped.values()) for (const [mint, x] of m) if (now - x.at > HOUR) m.delete(mint);
}

function tick() {
  if (!ready || stopping || !accounts.size) return;
  const sol = getSolPrice();
  if (!sol) return;
  const now = Date.now();
  const model = modelForBot();
  const fresh = snapshotSignalsSince(seenSignal);
  if (fresh.length) seenSignal = fresh[fresh.length - 1].seq;
  const lists = candidates(now, [...retrySignals.values(), ...fresh]);
  retrySignals.clear();
  forgetOld(now);
  for (const a of accounts.values()) {
    manage(a, now, sol);
    if (now - a.lastCurveAt >= CURVE_EVERY_MS) {
      pushCurve(a, now, sol);
      dirty.add(a.userId);
    }
    for (const mint of Object.keys(a.cooldown)) if (a.cooldown[mint] < now) delete a.cooldown[mint];
    if (a.settings.paused) continue;
    const strategy = strategyFor(a, model);
    if (!strategy) continue;
    const list = strategy === 'model' ? lists.model : lists.score.filter((c) => c.signal.score! >= a.settings.scoreMin);
    for (const c of list) noteWanted(a.userId, c.live.view.mint, now);
    for (const c of list) {
      if (a.positions.length >= a.settings.maxOpen || a.cash - FEE_SOL < 0.01) break;
      const v = c.live.view;
      if (a.positions.some((p) => p.mint === v.mint) || (a.cooldown[v.mint] ?? 0) > now) continue;
      if (c.live.liquidity! < a.settings.minLiquidity) {
        noteSkipped(a.userId, v.mint, 'liquidity', now);
        continue;
      }
      // Never a coin whose creator can pull the pool's liquidity (the price freezes and nothing can be sold).
      const lp = lpSafety(v.mint);
      if (lp === 'checking') {
        retrySignals.set(c.signal.seq, c.signal); // the answer usually arrives within a tick or two
        continue;
      }
      if (lp !== 'safe') {
        noteSkipped(a.userId, v.mint, lp === 'pullable' ? 'pullable' : 'unchecked', now);
        continue;
      }
      const size = tradeSize(a, c.live.liquidity!, sol, now);
      const target = strategy === 'model' ? c.signal.target! : scoreTarget();
      if (size > 0) open(a, c.live, size, strategy, target, now, c.signal.at);
      else noteSkipped(a.userId, v.mint, 'size', now);
    }
  }
}

// ---------------------------------------------------------------- views & events

function stats(a: Account, sol: number | null): PaperStats {
  const t = a.totals;
  const equity = equityOf(a, sol);
  let peak = a.startBalance;
  let dd = 0;
  for (const [, v] of [...a.curve, [Date.now(), equity] as [number, number]]) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return {
    closed: t.closed,
    wins: t.wins,
    winRate: t.closed ? r2(t.wins / t.closed) : null,
    pnlSol: r6(equity - a.startBalance),
    pnlPct: r2((equity / a.startBalance - 1) * 100),
    avgTradePct: t.closed ? r2(t.sumPct / t.closed) : null,
    bestPct: t.best == null ? null : r2(t.best),
    worstPct: t.worst == null ? null : r2(t.worst),
    profitFactor: t.lossSol > 0 ? r2(t.winSol / t.lossSol) : null,
    maxDrawdownPct: r2(dd * 100),
    feesSol: r6(a.feesSol),
  };
}

const legacy = (a: Account) => (a.fillModel ?? 1) < FILL_MODEL;

function readiness(a: Account, s: PaperStats): ReadinessCheck[] {
  const days = (Date.now() - a.createdAt) / 86_400_000;
  const model = modelForBot();
  return [
    {
      label: 'Measured with realistic fills (slippage from pool size)',
      ok: !legacy(a),
      detail: legacy(a) ? 'start over: these results used the old, too-generous fills' : 'yes',
    },
    { label: 'At least 100 closed paper trades', ok: s.closed >= 100, detail: `${s.closed} so far` },
    { label: 'Made money after fees', ok: s.pnlSol > 0, detail: `${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(3)} SOL (${s.pnlPct}%)` },
    {
      label: 'Wins clearly outweigh losses (profit factor 1.3+)',
      ok: (s.profitFactor ?? 0) >= 1.3,
      detail: s.profitFactor == null ? 'not enough trades' : `${s.profitFactor}`,
    },
    { label: 'Worst drop from a peak under 35%', ok: s.maxDrawdownPct < 35, detail: `${s.maxDrawdownPct}%` },
    { label: 'Running for at least 7 days', ok: days >= 7, detail: `${days.toFixed(1)} days` },
    { label: 'The AI model passed its out-of-sample test', ok: Boolean(model?.proven), detail: model ? (model.proven ? 'proven' : 'not yet') : 'still collecting data' },
  ];
}

/** Why the bot hasn't been buying, if its own settings are what's stopping it (empty otherwise). */
function skipNote(a: Account, strategy: PaperStrategy): string {
  if (a.positions.length >= a.settings.maxOpen) return ''; // full anyway: skips don't matter
  const w = wanted.get(a.userId)?.size ?? 0;
  const sk = [...(skipped.get(a.userId)?.values() ?? [])];
  const thin = sk.filter((x) => x.why === 'liquidity').length;
  const small = sk.filter((x) => x.why === 'size').length;
  const ran = sk.filter((x) => x.why === 'chase').length;
  const pullable = sk.filter((x) => x.why === 'pullable').length;
  const unchecked = sk.filter((x) => x.why === 'unchecked').length;
  if (!thin && !small && !ran && !pullable && !unchecked) return '';
  const coins = (n: number) => `${n} ${n === 1 ? 'coin' : 'coins'}`;
  const found = strategy === 'model' ? `the AI picked ${coins(w)}` : `${coins(w)} scored ${a.settings.scoreMin}+`;
  const parts: string[] = [];
  const min = a.settings.minLiquidity;
  const minText = min >= 1e6 ? `$${Math.round(min / 1e5) / 10}M` : `$${Math.round(min / 1000)}K`;
  if (thin) parts.push(`${thin} had less liquidity than your ${minText} minimum`);
  if (small) parts.push(`${small} would have been a trade under 0.01 SOL (balance too low)`);
  if (pullable) parts.push(`${pullable} had pool liquidity ${pullable === 1 ? 'its creator' : 'their creators'} can pull at any time (RugCheck)`);
  if (unchecked) parts.push(`${unchecked} couldn't be checked with RugCheck`);
  const n = thin + small + pullable + unchecked;
  const skips = parts.length ? `; ${parts.join(' and ')}, so the bot skipped ${n === 1 ? 'it' : 'them'}` : '';
  const chased = ran
    ? ` ${ran === 1 ? '1 buy was' : `${ran} buys were`} cancelled because the price ran ${ML.maxChasePct}%+ above the pick before ${ran === 1 ? 'it' : 'they'} could land.`
    : '';
  return ` In the last hour ${found}${skips}.${chased}`;
}

function activity(a: Account): string {
  if (a.settings.paused) return a.positions.length ? 'Paused: managing open trades only, no new buys.' : 'Paused.';
  const model = modelForBot();
  const strategy = strategyFor(a, model);
  const holding = `Holding ${a.positions.length} of ${a.settings.maxOpen}.`;
  if (!modelLoaded()) return `Starting up… ${holding}`;
  const why = notFollowingReason();
  if (!strategy) return `Not buying: the AI model is still collecting data (you chose "AI only"). ${holding}`;
  if (strategy === 'score')
    return `Trading on the MemeRadar score (${a.settings.scoreMin}+) while the AI model is still collecting data. ${holding}${skipNote(a, strategy)}`;
  const proof = why
    ? ` Fake money only: ${why}, so real trading would stay locked; this shows how its picks really do.`
    : ' It passed its latest test.';
  return `Trading the AI model's picks at its 10-minute checks.${proof} ${holding}${skipNote(a, strategy)}`;
}

export function accountView(a: Account, tradeLimit = 100): PaperAccountView {
  const sol = getSolPrice();
  const s = stats(a, sol);
  return {
    createdAt: a.createdAt,
    startBalance: a.startBalance,
    cash: r6(a.cash),
    equity: r6(equityOf(a, sol)),
    settings: a.settings,
    positions: a.positions,
    trades: a.trades.slice(0, tradeLimit),
    stats: s,
    curve: a.curve,
    bestTrades: a.bestTrades,
    worstTrades: a.worstTrades,
    byReason: a.byReason,
    byStrategy: a.byStrategy,
    legacyFills: legacy(a),
    activity: activity(a),
    readiness: readiness(a, s),
    updatedAt: a.updatedAt,
  };
}

function emit(a: Account, ev: BotEvent) {
  sendToUser(a.userId, 'botEvent', ev);
  sendToUser(a.userId, 'bot', accountView(a));
}

// ---------------------------------------------------------------- account API (used by the routes)

export function getAccount(userId: string) {
  return accounts.get(userId) ?? null;
}

export function paperReady() {
  return ready;
}

/** No room for another account (an existing one can always start over). */
export function paperFull(userId: string) {
  return !accounts.has(userId) && accounts.size >= MAX_ACCOUNTS;
}

export function createAccount(userId: string, startBalance: number, settings: PaperSettings): Account {
  if (!accounts.has(userId) && accounts.size >= MAX_ACCOUNTS) throw new Error('The paper trading server is full right now.');
  const now = Date.now();
  const a: Account = {
    userId,
    createdAt: now,
    startBalance,
    cash: startBalance,
    settings,
    positions: [],
    trades: [],
    bestTrades: [],
    worstTrades: [],
    byReason: {},
    byStrategy: {},
    totals: { closed: 0, wins: 0, sumPct: 0, winSol: 0, lossSol: 0, best: null, worst: null },
    curve: [[now, startBalance]],
    cooldown: {},
    missingSince: {},
    feesSol: 0,
    seq: 0,
    lastCurveAt: now,
    updatedAt: now,
    fillModel: FILL_MODEL,
  };
  accounts.set(userId, a);
  dirty.add(userId);
  return a;
}

export function updateSettings(a: Account, settings: PaperSettings) {
  a.settings = settings;
  touchAccount(a);
  sendToUser(a.userId, 'bot', accountView(a));
}

/** Sell one position now, at the current price. */
export function closeManually(a: Account, positionId: string): boolean {
  const pos = a.positions.find((p) => p.id === positionId);
  const sol = getSolPrice();
  if (!pos || !sol) return false;
  if (pos.pending) {
    cancel(a, pos);
    return true;
  }
  const now = Date.now();
  close(a, pos, 'manual', live(pos.mint, now)?.price ?? pos.lastPrice, now, sol);
  return true;
}

export function deleteAccount(userId: string): Promise<void> {
  accounts.delete(userId);
  dirty.delete(userId);
  versions.delete(userId);
  // After any save already under way, so that save can't bring the row back.
  return serial(async () => {
    await db?.query(`delete from paper_accounts where user_id = $1`, [userId]);
  });
}

// ---------------------------------------------------------------- persistence

/*
 * During a deploy the new server starts (and loads every account) while the old one is still
 * running; the old one saves its latest state only when it's told to stop, a little later. So
 * each saved row carries a version: a routine save only overwrites the version this server last
 * saw, and for the first minutes after starting, this server checks for newer versions and takes
 * them over. Otherwise the old server's final trades would be lost, or both would trade the same
 * account for an hour.
 */

/** The row version (and save time) each account was last loaded or saved at. Missing = never saved. */
const versions = new Map<string, { version: number; at: number }>();
let stopping = false;

/** Saves and sync checks run one at a time, so a check never mistakes this server's own save for another's. */
let io: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = io.then(fn, fn);
  io = run.catch(() => undefined);
  return run;
}

function serialize(a: Account) {
  const { userId: _u, missingSince: _m, ...rest } = a;
  return rest;
}

type StoredAccount = Omit<Account, 'userId'>;

/** Rebuild an account from its saved state (null if the state is unusable). */
function fromStored(userId: string, s: StoredAccount | null): Account | null {
  if (!s || typeof s.cash !== 'number' || !Array.isArray(s.positions)) return null;
  const a: Account = {
    ...s,
    userId,
    settings: { ...DEFAULT_PAPER_SETTINGS, ...s.settings },
    cooldown: s.cooldown ?? {},
    missingSince: {},
    totals: s.totals ?? { closed: 0, wins: 0, sumPct: 0, winSol: 0, lossSol: 0, best: null, worst: null },
  };
  upgrade(a);
  return a;
}

/** Replace this server's copy of an account with the saved one (or drop it if it's gone). */
async function reloadAccount(userId: string) {
  if (!db) return;
  const { rows } = await db.query<{ state: StoredAccount; version: string; at: number }>(
    `select state, version, extract(epoch from updated_at) * 1000 as at from paper_accounts where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  dirty.delete(userId);
  const a = row ? fromStored(userId, row.state) : null;
  if (!row || !a) {
    accounts.delete(userId);
    versions.delete(userId);
    return;
  }
  accounts.set(userId, a);
  versions.set(userId, { version: Number(row.version), at: Number(row.at) });
  for (const p of a.positions) followInBackground(p.mint);
  sendToUser(userId, 'bot', accountView(a));
}

/**
 * Save changed accounts (hourly, after user actions, and at shutdown). `force` (a user's own
 * action) always wins; a routine save is skipped when another server saved a newer version, and
 * that version is loaded instead.
 */
export function savePaper(onlyUser?: string, opts: { force?: boolean } = {}): Promise<void> {
  return serial(() => saveAccounts(onlyUser, opts));
}

async function saveAccounts(onlyUser: string | undefined, opts: { force?: boolean }) {
  if (!db || !ready) return;
  const ids = onlyUser ? (dirty.has(onlyUser) ? [onlyUser] : []) : [...dirty];
  for (const id of ids) {
    const a = accounts.get(id);
    dirty.delete(id);
    if (!a) continue;
    const known = versions.get(id);
    const state = JSON.stringify(serialize(a));
    try {
      // A routine save of an account this server loaded only updates the version it saw (never
      // re-creates a row someone deleted); a user's own action, or a brand-new account, always writes.
      const { rows } =
        known && !opts.force
          ? await db.query<{ version: string; at: number }>(
              `update paper_accounts set state = $2, updated_at = now(), version = version + 1
               where user_id = $1 and version = $3
               returning version, extract(epoch from updated_at) * 1000 as at`,
              [id, state, known.version],
            )
          : await db.query<{ version: string; at: number }>(
              `insert into paper_accounts (user_id, state, updated_at, version) values ($1, $2, now(), 1)
               on conflict (user_id) do update set state = excluded.state, updated_at = now(), version = paper_accounts.version + 1
               returning version, extract(epoch from updated_at) * 1000 as at`,
              [id, state],
            );
      if (rows[0]) versions.set(id, { version: Number(rows[0].version), at: Number(rows[0].at) });
      else if (!stopping) {
        console.log(`[paper] account ${id.slice(0, 8)} was saved by another server; using that copy`);
        await reloadAccount(id);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23503') accounts.delete(id); // the user deleted their account
      else {
        dirty.add(id);
        console.error('[paper] save failed:', e instanceof Error ? e.message : e);
      }
    }
  }
}

/** Take over accounts another server (the previous one, during a deploy) saved after this one loaded them. */
function syncFromOtherServer(): Promise<void> {
  return serial(checkOtherServer);
}

async function checkOtherServer() {
  if (!db || stopping) return;
  const { rows } = await db.query<{ user_id: string; version: string; at: number }>(
    `select user_id, version, extract(epoch from updated_at) * 1000 as at from paper_accounts`,
  );
  for (const r of rows) {
    const known = versions.get(r.user_id);
    const version = Number(r.version);
    // A newer version, or (from a server that predates versions) a newer save of the same version.
    const newer = !known || version > known.version || (version === known.version && Number(r.at) > known.at + 1);
    if (newer && (known || !accounts.has(r.user_id))) await reloadAccount(r.user_id);
  }
}

/** Stop trading and syncing (the server is shutting down; the final save follows). */
export function stopPaper() {
  stopping = true;
}

/** Accounts saved by older versions lack the best/worst lists and breakdowns: rebuild them from the trade log. */
function upgrade(a: Account) {
  if (!Array.isArray(a.bestTrades) || !Array.isArray(a.worstTrades)) {
    a.bestTrades = [...a.trades].sort((x, y) => y.pnlSol - x.pnlSol).slice(0, TOP_N);
    a.worstTrades = [...a.trades].sort((x, y) => x.pnlSol - y.pnlSol).slice(0, TOP_N);
  }
  if (!a.byReason || !a.byStrategy) {
    a.byReason = {};
    a.byStrategy = {};
    for (const t of a.trades) {
      bump(a.byReason, t.reason, t.pnlSol);
      bump(a.byStrategy, t.strategy, t.pnlSol);
    }
  }
}

export async function startPaper() {
  if (!db) return;
  try {
    await db.query(`
      create table if not exists paper_accounts (
        user_id uuid primary key references users(id) on delete cascade,
        state jsonb not null,
        updated_at timestamptz not null default now()
      );
      alter table paper_accounts add column if not exists version bigint not null default 0;
    `);
    const { rows } = await db.query<{ user_id: string; state: StoredAccount; version: string; at: number }>(
      `select user_id, state, version, extract(epoch from updated_at) * 1000 as at from paper_accounts`,
    );
    for (const r of rows) {
      const a = fromStored(r.user_id, r.state);
      if (!a) continue;
      accounts.set(r.user_id, a);
      versions.set(r.user_id, { version: Number(r.version), at: Number(r.at) });
    }
    // Make sure every open trade's coin is being priced (it may not be after a restart).
    for (const a of accounts.values()) for (const p of a.positions) followInBackground(p.mint);
    ready = true;
    console.log(`[paper] ${accounts.size} paper trading account(s) running`);
  } catch (e) {
    console.error('[paper] could not start:', e instanceof Error ? e.message : e);
    setTimeout(() => void startPaper(), 60_000);
    return;
  }
  setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error('[paper] tick failed:', e);
    }
  }, TICK_MS).unref();
  setInterval(() => void savePaper(), ML.flushEveryMs).unref();
  // During a deploy the previous server keeps running for a moment and saves its final state when
  // it stops: pick that up. (Every 15s for the first 10 minutes after starting.)
  const bootedAt = Date.now();
  const sync = setInterval(() => {
    if (Date.now() - bootedAt > 10 * 60_000) return clearInterval(sync);
    void syncFromOtherServer().catch((e) => console.warn('[paper] sync check failed:', e instanceof Error ? e.message : e));
  }, 15_000);
  sync.unref();
  // Refresh open positions' prices for anyone watching.
  setInterval(() => {
    const online = connectedUsers();
    for (const a of accounts.values()) if (a.positions.length && online.has(a.userId)) sendToUser(a.userId, 'bot', accountView(a));
  }, 30_000).unref();
}
