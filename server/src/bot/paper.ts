import type {
  AiTarget,
  BotEvent,
  PaperAccountView,
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
 * Fills are deliberately pessimistic: every buy and sell pays a 1% pool/router fee, price
 * impact based on the coin's liquidity, and a network fee; stop-losses fill at whatever the
 * price actually was when the stop was seen (often worse than the stop); a coin whose price
 * feed dies counts as a total loss.
 */

const TICK_MS = 5_000;
const FEE_SOL = 0.0005; // network + priority fee per swap
const BASE_COST = 0.01; // pool + router fee per side
const MAX_TRADES = 500;
const CURVE_EVERY_MS = ML.fast ? 30_000 : 15 * 60_000;
const CURVE_MAX = 1_000;
const GONE_AFTER_MS = 10 * 60_000;
const MAX_ACCOUNTS = 500;
const RISKY = new Set(['bots', 'copycat', 'dumping']);

export const DEFAULT_PAPER_SETTINGS: PaperSettings = {
  sizePct: 10,
  maxOpen: 5,
  mode: 'auto',
  scoreMin: 75,
  minLiquidity: 20_000,
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
  totals: Totals;
  curve: [number, number][];
  cooldown: Record<string, number>;
  missingSince: Record<string, number>;
  feesSol: number;
  seq: number;
  lastCurveAt: number;
  updatedAt: number;
}

const accounts = new Map<string, Account>();
const dirty = new Set<string>();
let ready = false;

// Open positions keep their coin's price followed even after it drops off the lists.
registerHold((mint) => {
  for (const a of accounts.values()) if (a.positions.some((p) => p.mint === mint)) return true;
  return false;
}, true);

const impact = (usd: number, liq: number | null | undefined) => Math.min(0.5, (2 * usd) / Math.max(liq ?? 0, 1));
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;

function freshPrice(mint: string, now: number): { price: number; view: TokenView } | null {
  const info = entryInfo(mint);
  const price = info?.view.priceUsd;
  if (!info || price == null || !(price > 0) || now - info.freshAt > 120_000) return null;
  return { price, view: info.view };
}

function positionValue(p: PaperPosition, sol: number, now: number): number {
  const live = freshPrice(p.mint, now);
  const price = live?.price ?? p.lastPrice;
  const usd = p.qty * price;
  return Math.max(0, (usd * (1 - BASE_COST - impact(usd, live?.view.liquidity))) / sol - FEE_SOL);
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

const scoreTarget = (): AiTarget => ({ tp: ML.targets[1].tp, sl: ML.targets[1].sl, holdMin: Math.round(ML.horizonMs / 60_000) });

function strategyFor(a: Account, model: ReturnType<typeof modelForBot>): PaperStrategy | null {
  if (model?.proven) return 'model';
  return a.settings.mode === 'auto' ? 'score' : null;
}

function open(a: Account, v: TokenView, strategy: PaperStrategy, target: AiTarget, sol: number, now: number): boolean {
  const price = v.priceUsd!;
  const equity = equityOf(a, sol, now);
  const size = Math.min((equity * a.settings.sizePct) / 100, a.cash - FEE_SOL);
  if (size < 0.01) return false;
  const usd = size * sol;
  const cost = BASE_COST + impact(usd, v.liquidity);
  const qty = (usd * (1 - cost)) / price;
  a.cash = r6(a.cash - size - FEE_SOL);
  a.feesSol += size * cost + FEE_SOL;
  const pos: PaperPosition = {
    id: `${now.toString(36)}-${(a.seq++).toString(36)}`,
    mint: v.mint,
    symbol: v.symbol,
    icon: v.icon,
    openedAt: now,
    entryPrice: price,
    qty,
    costSol: r6(size + FEE_SOL),
    target,
    closeBy: now + target.holdMin * 60_000,
    strategy,
    signal: strategy === 'model' ? (v.ai?.win ?? 0) : (v.score ?? 0),
    lastPrice: price,
    lastPriceAt: now,
  };
  a.positions.push(pos);
  touchAccount(a);
  emit(a, { type: 'open', position: pos });
  return true;
}

function close(a: Account, pos: PaperPosition, reason: PaperExit, price: number, now: number, sol: number) {
  const live = freshPrice(pos.mint, now);
  const usd = pos.qty * price;
  const cost = BASE_COST + impact(usd, live?.view.liquidity);
  const proceeds = reason === 'gone' ? 0 : Math.max(0, (usd * (1 - cost)) / sol - FEE_SOL);
  if (reason !== 'gone') a.feesSol += (usd * cost) / sol + FEE_SOL;
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
  };
  a.trades.unshift(trade);
  if (a.trades.length > MAX_TRADES) a.trades.length = MAX_TRADES;
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
    const live = freshPrice(pos.mint, now);
    if (live) {
      delete a.missingSince[pos.id];
      pos.lastPrice = live.price;
      pos.lastPriceAt = now;
      const move = (live.price / pos.entryPrice - 1) * 100;
      if (move >= pos.target.tp) close(a, pos, 'tp', live.price, now, sol);
      else if (move <= -pos.target.sl) close(a, pos, 'sl', live.price, now, sol);
      else if (now >= pos.closeBy) close(a, pos, 'time', live.price, now, sol);
      continue;
    }
    const since = (a.missingSince[pos.id] ??= now);
    // Its price stopped updating while other coins' prices kept coming: treat as rugged.
    if (now - since >= GONE_AFTER_MS && feedsOk()) close(a, pos, 'gone', 0, now, sol);
  }
}

interface Candidate {
  view: TokenView;
  rank: number;
}

/** Coins the model picks, and coins the MemeRadar score likes (used until the model is proven). */
function candidates(now: number) {
  const model: Candidate[] = [];
  const score: Candidate[] = [];
  for (const info of allEntries()) {
    const v = info.view;
    if (info.hidden || !(v.priceUsd! > 0) || now - info.freshAt > 60_000) continue;
    if ((v.liquidity ?? 0) < ML.tradeMinLiquidity || v.flags.some((f) => f.severity === 'danger')) continue;
    if (v.ai?.pick) model.push({ view: v, rank: (v.ai.ev ?? 0) * 100 + v.ai.win });
    if (v.score != null && v.score >= 60 && !v.flags.some((f) => RISKY.has(f.code))) score.push({ view: v, rank: v.score });
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
  const lists = candidates(now);
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
    const list = strategy === 'model' ? lists.model : lists.score.filter((c) => c.view.score! >= a.settings.scoreMin);
    const target = strategy === 'model' ? model!.target : scoreTarget();
    for (const c of list) {
      if (a.positions.length >= a.settings.maxOpen) break;
      const v = c.view;
      if ((v.liquidity ?? 0) < a.settings.minLiquidity) continue;
      if (a.positions.some((p) => p.mint === v.mint) || (a.cooldown[v.mint] ?? 0) > now) continue;
      if (!open(a, v, strategy, target, sol, now)) break; // out of cash
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

function readiness(a: Account, s: PaperStats): ReadinessCheck[] {
  const days = (Date.now() - a.createdAt) / 86_400_000;
  const model = modelForBot();
  return [
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
    return `Trading on the MemeRadar score (${a.settings.scoreMin}+) until the AI model proves itself. ${holding}`;
  return `Trading the AI model's picks. ${holding}`;
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
    totals: { closed: 0, wins: 0, sumPct: 0, winSol: 0, lossSol: 0, best: null, worst: null },
    curve: [[now, startBalance]],
    cooldown: {},
    missingSince: {},
    feesSol: 0,
    seq: 0,
    lastCurveAt: now,
    updatedAt: now,
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
  close(a, pos, 'manual', freshPrice(pos.mint, now)?.price ?? pos.lastPrice, now, sol);
  return true;
}

export async function deleteAccount(userId: string) {
  accounts.delete(userId);
  dirty.delete(userId);
  await db?.query(`delete from paper_accounts where user_id = $1`, [userId]);
}

// ---------------------------------------------------------------- persistence

function serialize(a: Account) {
  const { userId: _u, ...rest } = a;
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
      accounts.set(r.user_id, {
        ...s,
        userId: r.user_id,
        settings: { ...DEFAULT_PAPER_SETTINGS, ...s.settings },
        cooldown: s.cooldown ?? {},
        missingSince: {},
        totals: s.totals ?? { closed: 0, wins: 0, sumPct: 0, winSol: 0, lossSol: 0, best: null, worst: null },
      });
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
