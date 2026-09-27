import type { KolEntry, ServerEvent, TraderTrade, TraderView } from '../../../shared/types';
import { config } from '../config';
import { broadcast } from '../lib/bus';
import { registerPersisted } from '../lib/cache';
import { errMessage } from '../lib/http';
import { markError, markOk, registerSource } from '../lib/status';
import { save, state, type StoredTrader } from '../lib/store';
import { fetchKolLeaderboard } from '../sources/kolscan';
import { getSignatures, getTransaction, parseSwap } from '../sources/solana';
import { getSolPrice, tokenMeta, trackTraderToken } from './market';

interface Runtime {
  cursor: string | null;
  status: TraderView['status'];
  statusMessage: string | null;
  lastPoll: number | null;
  lastTradeAt: number | null;
  trades: TraderTrade[];
}

interface Job {
  address: string;
  signature: string;
  backfill: boolean;
  attempts?: number;
}

const runtime = new Map<string, Runtime>();
const liveQueue: Job[] = [];
const backfillQueue: Job[] = [];
const seenSigs = new Set<string>();
let feed: TraderTrade[] = [];
let leaderboard: KolEntry[] = [];
let leaderboardUpdated: number | null = null;

/** mint -> (trader address -> time of buy) over the last hour, for convergence alerts. */
const recentBuys = new Map<string, Map<string, number>>();
const convergenceSent = new Map<string, { at: number; count: number }>();

const MIN_SOL = 0.05;
const BACKFILL_SCAN = 25;
const BACKFILL_TRADES = 6;
const MIN_USD = 5;
const POLL_MS = config.customRpc ? 8_000 : 20_000;

function rt(address: string): Runtime {
  let r = runtime.get(address);
  if (!r) {
    r = { cursor: null, status: 'pending', statusMessage: null, lastPoll: null, lastTradeAt: null, trades: [] };
    runtime.set(address, r);
  }
  return r;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function traderViews(): TraderView[] {
  const today = startOfToday();
  return state.traders.map((t) => {
    const r = rt(t.address);
    const todays = r.trades.filter((x) => x.time >= today);
    const sol = (x: TraderTrade) => (x.quote === 'SOL' ? x.quoteAmount : 0);
    return {
      address: t.address,
      label: t.label,
      source: t.source,
      addedAt: t.addedAt,
      alerts: t.alerts,
      status: r.status,
      statusMessage: r.statusMessage,
      lastPoll: r.lastPoll,
      lastTradeAt: r.lastTradeAt,
      today: {
        buys: todays.filter((x) => x.side === 'buy').length,
        sells: todays.filter((x) => x.side === 'sell').length,
        solIn: todays.filter((x) => x.side === 'buy').reduce((s, x) => s + sol(x), 0),
        solOut: todays.filter((x) => x.side === 'sell').reduce((s, x) => s + sol(x), 0),
      },
    };
  });
}

/** Fill in symbols that were unknown when the trade was first seen. */
function withSymbols(list: TraderTrade[]): TraderTrade[] {
  for (const t of list) if (!t.symbol) t.symbol = tokenMeta(t.mint).symbol;
  return list;
}

export function traderFeed(): TraderTrade[] {
  return withSymbols(feed.slice(0, 200));
}

export function tradesForMint(mint: string): TraderTrade[] {
  return withSymbols(feed.filter((t) => t.mint === mint).slice(0, 50));
}

export function leaderboardState() {
  return { leaderboard, leaderboardUpdated };
}

registerPersisted(
  'traders',
  () => ({ leaderboard, leaderboardUpdated, feed }),
  (value) => {
    const v = value as { leaderboard?: KolEntry[]; leaderboardUpdated?: number | null; feed?: TraderTrade[] };
    if (Array.isArray(v.leaderboard) && v.leaderboard.length) {
      leaderboard = v.leaderboard;
      leaderboardUpdated = v.leaderboardUpdated ?? null;
    }
    if (Array.isArray(v.feed)) {
      feed = v.feed.slice(0, 500);
      // Rebuild each trader's recent trades so today's stats and "last trade" survive restarts.
      for (const t of [...feed].reverse()) {
        const r = rt(t.trader);
        r.trades.unshift(t);
        r.trades.length = Math.min(r.trades.length, 100);
        r.lastTradeAt = Math.max(r.lastTradeAt ?? 0, t.time);
        seenSigs.add(t.id);
      }
    }
  },
);

let tradersTimer: NodeJS.Timeout | null = null;
function scheduleTradersBroadcast() {
  if (tradersTimer) return;
  tradersTimer = setTimeout(() => {
    tradersTimer = null;
    broadcast('traders', traderViews());
  }, 1_500);
}

function emit(ev: ServerEvent) {
  broadcast('event', ev);
}

function labelOf(address: string) {
  return state.traders.find((t) => t.address === address)?.label ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function recordTrade(job: Job, trade: Omit<TraderTrade, 'id' | 'trader' | 'traderLabel' | 'symbol' | 'usdValue' | 'backfill'>) {
  const trader = state.traders.find((t) => t.address === job.address);
  if (!trader) return; // removed while queued
  if (trade.quote === 'SOL' ? trade.quoteAmount < MIN_SOL : trade.quoteAmount < MIN_USD) return;

  trackTraderToken(trade.mint);
  const sol = getSolPrice();
  const full: TraderTrade = {
    ...trade,
    id: job.signature,
    trader: job.address,
    traderLabel: trader.label,
    symbol: tokenMeta(trade.mint).symbol,
    usdValue: trade.quote === 'USD' ? trade.quoteAmount : sol ? trade.quoteAmount * sol : null,
    backfill: job.backfill,
  };

  const r = rt(job.address);
  r.trades.unshift(full);
  r.trades.sort((a, b) => b.time - a.time);
  r.trades.length = Math.min(r.trades.length, 100);
  r.lastTradeAt = Math.max(r.lastTradeAt ?? 0, full.time);

  feed.push(full);
  feed.sort((a, b) => b.time - a.time);
  feed = feed.slice(0, 500);

  scheduleTradersBroadcast();
  if (job.backfill) {
    broadcast('traderTrades', traderFeed());
    return;
  }
  emit({ type: 'traderTrade', trade: full });
  if (full.side === 'buy') checkConvergence(full);
}

function checkConvergence(t: TraderTrade) {
  const now = Date.now();
  let buyers = recentBuys.get(t.mint);
  if (!buyers) {
    buyers = new Map();
    recentBuys.set(t.mint, buyers);
  }
  buyers.set(t.trader, t.time);
  for (const [addr, at] of buyers) if (now - at > 3_600_000) buyers.delete(addr);
  if (buyers.size < 2) return;
  const prev = convergenceSent.get(t.mint);
  // Alert when a new trader joins the group, at most once per 10 minutes per token.
  if (prev && (prev.count >= buyers.size || now - prev.at < 10 * 60_000)) return;
  convergenceSent.set(t.mint, { at: now, count: buyers.size });
  emit({
    type: 'convergence',
    mint: t.mint,
    symbol: t.symbol ?? tokenMeta(t.mint).symbol,
    traders: [...buyers.keys()].map(labelOf),
    time: now,
  });
}

// ---------------------------------------------------------------- polling

async function pollTrader(t: StoredTrader) {
  const r = rt(t.address);
  try {
    const first = r.cursor === null;
    const sigs = await getSignatures(t.address, { limit: first ? 150 : 1000, until: r.cursor ?? undefined });
    r.lastPoll = Date.now();
    if (!state.traders.some((x) => x.address === t.address)) return; // removed mid-poll
    if (sigs.length) r.cursor = sigs[0].signature;
    const ok = sigs.filter((s) => !s.err && !seenSigs.has(s.signature));

    if (first) {
      // Backfill recent trades so the panel isn't empty. Many recent transactions are spam
      // airdrops rather than swaps, so look through up to 25 and stop once enough swaps are found.
      for (const s of ok.slice(0, BACKFILL_SCAN)) backfillQueue.push({ address: t.address, signature: s.signature, backfill: true });
      r.status = 'ok';
      r.statusMessage = null;
    } else {
      if (sigs.length >= 1000) {
        r.status = 'noisy';
        r.statusMessage = 'This wallet receives heavy spam traffic, so some trades may be missed.';
      } else {
        r.status = 'ok';
        r.statusMessage = null;
      }
      // Newest 15 only, oldest first, so a burst never builds an endless backlog.
      for (const s of ok.slice(0, 15).reverse()) liveQueue.push({ address: t.address, signature: s.signature, backfill: false });
    }
    for (const s of ok) seenSigs.add(s.signature);
    if (seenSigs.size > 50_000) {
      const keep = [...seenSigs].slice(-20_000);
      seenSigs.clear();
      keep.forEach((s) => seenSigs.add(s));
    }
    markOk('traders');
  } catch (e) {
    r.status = 'error';
    r.statusMessage = errMessage(e);
    markError('traders', e);
  }
  scheduleTradersBroadcast();
}

async function pollLoop() {
  for (;;) {
    const started = Date.now();
    for (const t of [...state.traders]) await pollTrader(t);
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1_000, POLL_MS - elapsed)));
  }
}

async function txWorker() {
  for (;;) {
    const job = liveQueue.shift() ?? backfillQueue.shift();
    if (!job) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!state.traders.some((t) => t.address === job.address)) continue;
    if (job.backfill && rt(job.address).trades.length >= BACKFILL_TRADES) continue;
    try {
      const tx = await getTransaction(job.signature);
      if (!tx && (job.attempts ?? 0) < 2) {
        // Very fresh transactions can lag behind the signature index; try again shortly.
        setTimeout(() => liveQueue.push({ ...job, attempts: (job.attempts ?? 0) + 1 }), 4_000);
        continue;
      }
      const swap = parseSwap(tx, job.address);
      if (swap) {
        recordTrade(job, {
          side: swap.side,
          mint: swap.mint,
          tokenAmount: swap.tokenAmount,
          quoteAmount: swap.quoteAmount,
          quote: swap.quote,
          time: (tx?.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
        });
      }
    } catch (e) {
      markError('traders', e);
    }
  }
}

// ---------------------------------------------------------------- leaderboard & list management

async function refreshLeaderboard() {
  try {
    const rows = await fetchKolLeaderboard();
    if (!rows.length) throw new Error('leaderboard page returned no rows (layout may have changed)');
    leaderboard = rows;
    leaderboardUpdated = Date.now();
    markOk('kolscan');
    broadcast('leaderboard', leaderboardState());
    if (!state.tradersInitialised) seedTraders(rows);
  } catch (e) {
    markError('kolscan', e);
  }
}

/** First run: watch today's most profitable traders who made a meaningful number of trades. */
function seedTraders(rows: KolEntry[]) {
  const picks = rows
    .filter((r) => r.wins + r.losses >= 3 && r.profitSol > 0)
    .sort((a, b) => b.profitSol - a.profitSol)
    .slice(0, 8);
  for (const p of picks) {
    if (state.traders.some((t) => t.address === p.address)) continue;
    state.traders.push({ address: p.address, label: p.name, source: 'kolscan', addedAt: Date.now(), alerts: true });
  }
  state.tradersInitialised = true;
  save();
  scheduleTradersBroadcast();
  console.log(`[traders] seeded ${picks.length} traders from the Kolscan leaderboard`);
}

export function addTrader(address: string, label: string, source: 'manual' | 'kolscan') {
  const existing = state.traders.find((t) => t.address === address);
  if (existing) {
    existing.label = label || existing.label;
  } else {
    state.traders.push({ address, label: label || `${address.slice(0, 4)}…${address.slice(-4)}`, source, addedAt: Date.now(), alerts: true });
  }
  state.tradersInitialised = true;
  save();
  scheduleTradersBroadcast();
}

export function updateTrader(address: string, patch: { label?: string; alerts?: boolean }) {
  const t = state.traders.find((x) => x.address === address);
  if (!t) return false;
  if (typeof patch.label === 'string' && patch.label.trim()) t.label = patch.label.trim().slice(0, 40);
  if (typeof patch.alerts === 'boolean') t.alerts = patch.alerts;
  for (const tr of feed) if (tr.trader === address) tr.traderLabel = t.label;
  save();
  scheduleTradersBroadcast();
  return true;
}

export function removeTrader(address: string) {
  const before = state.traders.length;
  state.traders = state.traders.filter((t) => t.address !== address);
  runtime.delete(address);
  feed = feed.filter((t) => t.trader !== address);
  save();
  scheduleTradersBroadcast();
  broadcast('traderTrades', traderFeed());
  return state.traders.length < before;
}

export function startTraders() {
  registerSource('traders', 'Trader wallets (Solana RPC)');
  registerSource('kolscan', 'Kolscan leaderboard');
  void refreshLeaderboard();
  setInterval(() => void refreshLeaderboard(), 10 * 60_000).unref();
  void pollLoop();
  void txWorker();
}
