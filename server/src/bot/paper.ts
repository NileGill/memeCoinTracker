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
import { allEntries, entryInfo, followInBackground, getSolPrice, registerHold } from '../engine/market';
import { connectedUsers, sendToUser } from '../lib/bus';
import { ML } from '../ml/config';
import { modelForBot } from '../ml/model';
import { feedsOk } from '../ml/recorder';

/*
 * Paper trading: a bot per account that trades fake SOL on the live market, 24/7 on the
 * server, so the strategy's real-world results can be judged before any real money is used.
 *
 * Fills are modelled on how memecoin pools actually trade, and err on the pessimistic side:
 *  - Slippage uses constant-product pool math: buying or selling a large amount relative to a
 *    pool's liquidity gets a much worse price, and you can never take out more than the pool
 *    holds. (The first version capped slippage at 50%, which let big positions "sell" into
 *    near-empty pools and produced absurd profits.)
 *  - Liquidity is the lower of DexScreener's and Jupiter's readings; coins where they disagree
 *    wildly are skipped.
 *  - Trade size is capped at a small share of the pool and an absolute SOL amount, so the bot
 *    never buys more than a coin can absorb.
 *  - Take-profits fill at the target price, never at a momentary spike above it; stop-losses
 *    fill at the price actually seen (often worse than the stop).
 *  - Every swap pays a 1% pool/router fee and a network fee; a coin whose price feed dies
 *    counts as a total loss.
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
}

function live(mint: string, now: number): Live | null {
  const info = entryInfo(mint);
  const price = info?.view.priceUsd;
  if (!info || price == null || !(price > 0) || now - info.freshAt > 120_000) return null;
  return { price, view: info.view, liquidity: info.liquidityLow, liquidityConflict: info.liquidityConflict };
}

/** Take-profits fill at the target price, never above it (a momentary spike isn't a fill). */
const tpPrice = (p: PaperPosition) => p.entryPrice * (1 + p.target.tp / 100);

/** SOL you'd get selling the whole position at `price` into a pool of `liquidity`, after fees. */
function saleProceeds(p: PaperPosition, price: number, liquidity: number | null | undefined, sol: number) {
  const valueUsd = p.qty * price;
  const outUsd = swapOut(valueUsd, liquidity ?? 0) * (1 - FEE);
  return { valueUsd, outUsd, proceeds: Math.max(0, outUsd / sol - FEE_SOL) };
}

function positionValue(p: PaperPosition, sol: number, now: number): number {
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

function strategyFor(a: Account, model: ReturnType<typeof modelForBot>): PaperStrategy | null {
  if (model?.proven) return 'model';
  return a.settings.mode === 'auto' ? 'score' : null;
}

/** The most SOL this account would put into this coin right now (0 = don't buy). */
function tradeSize(a: Account, liquidity: number, sol: number, now: number): number {
  const equity = equityOf(a, sol, now);
  const poolCapSol = (liquidity * a.settings.maxPoolPct) / 100 / sol;
  const size = Math.min((equity * a.settings.sizePct) / 100, a.settings.maxTradeSol, poolCapSol, a.cash - FEE_SOL);
  return size >= 0.01 ? size : 0;
}

function open(a: Account, l: Live, size: number, strategy: PaperStrategy, target: AiTarget, sol: number, now: number) {
  const v = l.view;
  const liquidity = l.liquidity!;
  const inUsd = size * sol * (1 - FEE);
  const gotUsd = swapOut(inUsd, liquidity);
  const qty = gotUsd / l.price;
  a.cash = r6(a.cash - size - FEE_SOL);
  a.feesSol += (size * sol - gotUsd) / sol + FEE_SOL;
  const pos: PaperPosition = {
    id: `${now.toString(36)}-${(a.seq++).toString(36)}`,
    mint: v.mint,
    symbol: v.symbol,
    icon: v.icon,
    openedAt: now,
    entryPrice: l.price,
    qty,
    costSol: r6(size + FEE_SOL),
    target,
    closeBy: now + target.holdMin * 60_000,
    strategy,
    signal: strategy === 'model' ? (v.ai?.win ?? 0) : (v.score ?? 0),
    lastPrice: l.price,
    lastPriceAt: now,
    entryLiquidity: Math.round(liquidity),
    lastLiquidity: Math.round(liquidity),
  };
  a.positions.push(pos);
  touchAccount(a);
  emit(a, { type: 'open', position: pos });
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

function close(a: Account, pos: PaperPosition, reason: PaperExit, seenPrice: number, now: number, sol: number) {
  const l = live(pos.mint, now);
  const liquidity = l?.liquidity ?? pos.lastLiquidity ?? pos.entryLiquidity ?? 0;
  const price = reason === 'tp' ? Math.min(seenPrice, tpPrice(pos)) : seenPrice;
  const { valueUsd, proceeds } = reason === 'gone' ? { valueUsd: 0, proceeds: 0 } : saleProceeds(pos, price, liquidity, sol);
  if (reason !== 'gone') a.feesSol += Math.max(0, (valueUsd / sol) - proceeds);
  a.cash = r6(a.cash + proceeds);
  a.positions = a.positions.filter((p) => p.id !== pos.id);
  delete a.missingSince[pos.id];
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

/** Sell positions that hit their target, stop, or time limit. */
function manage(a: Account, now: number, sol: number) {
  for (const pos of [...a.positions]) {
    const l = live(pos.mint, now);
    if (l) {
      delete a.missingSince[pos.id];
      pos.lastPrice = l.price;
      pos.lastPriceAt = now;
      if (l.liquidity != null) pos.lastLiquidity = Math.round(l.liquidity);
      const move = (l.price / pos.entryPrice - 1) * 100;
      if (move >= pos.target.tp) close(a, pos, 'tp', l.price, now, sol);
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
  live: Live;
  rank: number;
}

/**
 * Coins the model picks, and coins the MemeRadar score likes (used until the model is proven).
 * Score picks skip coins the crash model rates too likely to crash, once it has shown it can.
 * Coins with untrustworthy liquidity data are never bought.
 */
function candidates(now: number, riskMax: number | null) {
  const model: Candidate[] = [];
  const score: Candidate[] = [];
  for (const info of allEntries()) {
    const v = info.view;
    if (info.hidden || !(v.priceUsd! > 0) || now - info.freshAt > 60_000) continue;
    const liq = info.liquidityLow;
    if (liq == null || liq < ML.tradeMinLiquidity || info.liquidityConflict) continue;
    // A pool bigger than the whole coin's value means the numbers are off.
    if (v.mcap != null && v.mcap > 0 && liq > v.mcap * 1.5) continue;
    if (v.flags.some((f) => f.severity === 'danger')) continue;
    const l: Live = { price: v.priceUsd!, view: v, liquidity: liq, liquidityConflict: false };
    if (v.ai?.pick) model.push({ live: l, rank: (v.ai.ev ?? 0) * 100 + v.ai.win });
    const safeEnough = riskMax == null || (v.ai?.risk != null && v.ai.risk <= riskMax);
    if (v.score != null && v.score >= 60 && safeEnough && !v.flags.some((f) => RISKY.has(f.code))) score.push({ live: l, rank: v.score });
  }
  model.sort((x, y) => y.rank - x.rank);
  score.sort((x, y) => y.rank - x.rank);
  return { model, score };
}

function tick() {
  if (!ready || !accounts.size) return;
  const sol = getSolPrice();
  if (!sol) return;
  const now = Date.now();
  const model = modelForBot();
  const lists = candidates(now, model?.scoreRiskMax ?? null);
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
    const list = strategy === 'model' ? lists.model : lists.score.filter((c) => c.live.view.score! >= a.settings.scoreMin);
    const target = strategy === 'model' ? model!.target : scoreTarget();
    for (const c of list) {
      if (a.positions.length >= a.settings.maxOpen || a.cash - FEE_SOL < 0.01) break;
      const v = c.live.view;
      if (c.live.liquidity! < a.settings.minLiquidity) continue;
      if (a.positions.some((p) => p.mint === v.mint) || (a.cooldown[v.mint] ?? 0) > now) continue;
      const size = tradeSize(a, c.live.liquidity!, sol, now);
      if (size > 0) open(a, c.live, size, strategy, target, sol, now);
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

function activity(a: Account): string {
  if (a.settings.paused) return a.positions.length ? 'Paused: managing open trades only, no new buys.' : 'Paused.';
  const model = modelForBot();
  const strategy = strategyFor(a, model);
  const holding = `Holding ${a.positions.length} of ${a.settings.maxOpen}.`;
  if (!strategy) return `Waiting for the AI model to prove itself before trading (you chose "model only"). ${holding}`;
  if (strategy === 'score')
    return `Trading on the MemeRadar score (${a.settings.scoreMin}+)${model?.scoreRiskMax != null ? ', skipping coins the crash model flags,' : ''} until the AI model proves itself. ${holding}`;
  return `Trading the AI model's picks (likely winners it doesn't expect to crash). ${holding}`;
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
  const now = Date.now();
  close(a, pos, 'manual', live(pos.mint, now)?.price ?? pos.lastPrice, now, sol);
  return true;
}

export async function deleteAccount(userId: string) {
  accounts.delete(userId);
  dirty.delete(userId);
  await db?.query(`delete from paper_accounts where user_id = $1`, [userId]);
}

// ---------------------------------------------------------------- persistence

function serialize(a: Account) {
  const { userId: _u, missingSince: _m, ...rest } = a;
  return rest;
}

/** Save changed accounts (hourly, after user actions, and at shutdown). */
export async function savePaper(onlyUser?: string) {
  if (!db || !ready) return;
  const ids = onlyUser ? (dirty.has(onlyUser) ? [onlyUser] : []) : [...dirty];
  for (const id of ids) {
    const a = accounts.get(id);
    dirty.delete(id);
    if (!a) continue;
    try {
      await db.query(
        `insert into paper_accounts (user_id, state, updated_at) values ($1, $2, now())
         on conflict (user_id) do update set state = excluded.state, updated_at = now()`,
        [id, JSON.stringify(serialize(a))],
      );
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
      )
    `);
    const { rows } = await db.query<{ user_id: string; state: Omit<Account, 'userId'> }>(`select user_id, state from paper_accounts`);
    for (const r of rows) {
      const s = r.state;
      if (!s || typeof s.cash !== 'number' || !Array.isArray(s.positions)) continue;
      const a: Account = {
        ...s,
        userId: r.user_id,
        settings: { ...DEFAULT_PAPER_SETTINGS, ...s.settings },
        cooldown: s.cooldown ?? {},
        missingSince: {},
        totals: s.totals ?? { closed: 0, wins: 0, sumPct: 0, winSol: 0, lossSol: 0, best: null, worst: null },
      };
      upgrade(a);
      accounts.set(r.user_id, a);
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
  // Refresh open positions' prices for anyone watching.
  setInterval(() => {
    const online = connectedUsers();
    for (const a of accounts.values()) if (a.positions.length && online.has(a.userId)) sendToUser(a.userId, 'bot', accountView(a));
  }, 30_000).unref();
}
