import type {
  LaunchItem,
  MarketDelta,
  MarketPayload,
  MigrationItem,
  TokenSource,
  TokenView,
} from '../../../shared/types';
import { NON_MEME_MINTS, NON_MEME_TAGS, SOL_MINT } from '../config';
import { broadcast } from '../lib/bus';
import { registerPersisted } from '../lib/cache';
import { num } from '../lib/http';
import { markError, markOk, registerSource } from '../lib/status';
import {
  dsLatestBoosts,
  dsLatestProfiles,
  dsPairs,
  dsTakeovers,
  dsTopBoosts,
  type DsListItem,
  type DsPair,
} from '../sources/dexscreener';
import { gtNewPools, gtTrending } from '../sources/geckoterminal';
import { jupList, jupPrices, jupRecent, jupTokens, type JupList, type JupToken } from '../sources/jupiter';
import { startPumpPortal } from '../sources/pumpportal';
import { scoreToken } from './scoring';

// ---------------------------------------------------------------- state

interface Entry {
  mint: string;
  jup: JupToken | null;
  jupAt: number;
  /** Jupiter does not know this mint yet; retry after this time. */
  jupRetryAt: number;
  ds: DsPair | null;
  dsAt: number;
  /** Last time each source listed this token. */
  sources: Map<TokenSource, number>;
  firstSeen: number;
  boostAmount: number | null;
  view: TokenView | null;
  /** Dropped from the lists but still followed in the background (an open bot trade or model snapshot needs its price). */
  hidden: boolean;
}

const MAX_UNIVERSE = 400;
const entries = new Map<string, Entry>();
const launches = new Map<string, LaunchItem>();
const migrations = new Map<string, MigrationItem>();
const launchTimes: number[] = [];
const graduationTimes: number[] = [];
let solPrice: number | null = null;
const startedAt = Date.now();

type MigrationListener = (m: MigrationItem) => void;
const migrationListeners: MigrationListener[] = [];
export const onMigration = (fn: MigrationListener) => migrationListeners.push(fn);

// ---------------------------------------------------------------- helpers

function isNonMeme(j: JupToken | null): boolean {
  if (!j) return false;
  if (NON_MEME_MINTS.has(j.id)) return true;
  const tags = j.tags ?? [];
  if (tags.includes('meme')) return false;
  return tags.some((t) => NON_MEME_TAGS.has(t));
}

/** Watchlists live in each visitor's browser; open tabs re-announce them every few minutes. */
const WATCH_TTL = 15 * 60_000;

function isProtected(e: Entry, now: number) {
  const watched = e.sources.get('watch');
  if (watched && now - watched < WATCH_TTL) return true;
  const trader = e.sources.get('trader');
  if (trader && now - trader < 6 * 3_600_000) return true;
  const search = e.sources.get('search');
  return Boolean(search && now - search < 30 * 60_000);
}

/** Add a token to the tracked universe (or refresh which sources list it). */
export function touch(mint: string, source: TokenSource, jup?: JupToken | null) {
  if (!mint || NON_MEME_MINTS.has(mint)) return;
  const now = Date.now();
  let e = entries.get(mint);
  if (!e) {
    e = { mint, jup: null, jupAt: 0, jupRetryAt: 0, ds: null, dsAt: 0, sources: new Map(), firstSeen: now, boostAmount: null, view: null, hidden: false };
    entries.set(mint, e);
  }
  e.sources.set(source, now);
  e.hidden = false;
  if (jup && jup.id === mint) {
    e.jup = jup;
    e.jupAt = now;
  }
}

export function getSolPrice() {
  return solPrice;
}

export function getView(mint: string): TokenView | null {
  return entries.get(mint)?.view ?? null;
}

export function tokenMeta(mint: string): { symbol: string | null; decimals: number | null; name: string | null; icon: string | null } {
  const e = entries.get(mint);
  const l = launches.get(mint);
  return {
    symbol: e?.jup?.symbol ?? e?.ds?.baseToken.symbol ?? l?.symbol ?? null,
    name: e?.jup?.name ?? e?.ds?.baseToken.name ?? l?.name ?? null,
    decimals: e?.jup?.decimals ?? null,
    icon: e?.jup?.icon ?? e?.ds?.info?.imageUrl ?? l?.icon ?? null,
  };
}

function socialUrl(ds: DsPair | null, type: string) {
  return ds?.info?.socials?.find((s) => s.type === type)?.url;
}

function buildView(e: Entry, now: number): TokenView | null {
  const j = e.jup;
  const d = e.ds;
  if (!j && !d) return null;

  const s5 = j?.stats5m;
  const s1 = j?.stats1h;
  const s6 = j?.stats6h;
  const s24 = j?.stats24h;
  const jVol = (s?: { buyVolume?: number; sellVolume?: number }) =>
    s && (s.buyVolume != null || s.sellVolume != null) ? (s.buyVolume ?? 0) + (s.sellVolume ?? 0) : null;
  const jTx = (s?: { numBuys?: number; numSells?: number }) =>
    s && (s.numBuys != null || s.numSells != null) ? { buys: s.numBuys ?? 0, sells: s.numSells ?? 0 } : null;

  // DexScreener refreshes fastest, so it wins for live price fields, unless it has stopped
  // updating this coin while Jupiter hasn't (a stale price would freeze stops and outcomes).
  const preferJup = !(d && now - e.dsAt < 90_000) && Boolean(j && now - e.jupAt < 90_000);
  const live = (dsVal: unknown, jupVal: unknown) => (preferJup ? (num(jupVal) ?? num(dsVal)) : (num(dsVal) ?? num(jupVal)));

  const created =
    (j?.firstPool?.createdAt ? Date.parse(j.firstPool.createdAt) : NaN) ||
    (j?.createdAt ? Date.parse(j.createdAt) : NaN) ||
    d?.pairCreatedAt ||
    null;

  const base: Omit<TokenView, 'score' | 'scoreParts' | 'flags' | 'ai'> = {
    mint: e.mint,
    symbol: (j?.symbol ?? d?.baseToken.symbol ?? '???').slice(0, 20),
    name: (j?.name ?? d?.baseToken.name ?? '').slice(0, 60),
    // DexScreener's CDN is much faster than the IPFS gateways many launchpads use.
    icon: d?.info?.imageUrl ?? j?.icon ?? null,
    decimals: j?.decimals ?? null,
    priceUsd: live(d?.priceUsd, j?.usdPrice),
    mcap: live(d?.marketCap, j?.mcap),
    fdv: live(d?.fdv, j?.fdv),
    liquidity: live(d?.liquidity?.usd, j?.liquidity),
    holders: num(j?.holderCount),
    createdAt: Number.isFinite(created) ? (created as number) : null,
    launchpad: j?.launchpad ?? null,
    dexId: d?.dexId ?? null,
    pairAddress: d?.pairAddress ?? j?.graduatedPool ?? null,
    change: {
      m5: num(d?.priceChange?.m5) ?? num(s5?.priceChange),
      h1: num(d?.priceChange?.h1) ?? num(s1?.priceChange),
      h6: num(d?.priceChange?.h6) ?? num(s6?.priceChange),
      h24: num(d?.priceChange?.h24) ?? num(s24?.priceChange),
    },
    volume: {
      m5: num(d?.volume?.m5) ?? jVol(s5),
      h1: num(d?.volume?.h1) ?? jVol(s1),
      h6: num(d?.volume?.h6) ?? jVol(s6),
      h24: num(d?.volume?.h24) ?? jVol(s24),
    },
    buyVolume: { m5: num(s5?.buyVolume), h1: num(s1?.buyVolume) },
    sellVolume: { m5: num(s5?.sellVolume), h1: num(s1?.sellVolume) },
    txns: { m5: d?.txns?.m5 ?? jTx(s5), h1: d?.txns?.h1 ?? jTx(s1) },
    traders5m: num(s5?.numTraders),
    netBuyers5m: num(s5?.numNetBuyers),
    netBuyers1h: num(s1?.numNetBuyers),
    holderChange1h: num(s1?.holderChange),
    organicScore: num(j?.organicScore),
    organicLabel: j?.organicScoreLabel ?? null,
    verified: Boolean(j?.isVerified ?? j?.tags?.includes('verified')),
    audit: {
      mintDisabled: j?.audit?.mintAuthorityDisabled ?? null,
      freezeDisabled: j?.audit?.freezeAuthorityDisabled ?? null,
      topHoldersPct: num(j?.audit?.topHoldersPercentage),
      devPct: num(j?.audit?.devBalancePercentage),
    },
    boosts: num(d?.boosts?.active) ?? e.boostAmount,
    links: {
      website: j?.website ?? d?.info?.websites?.[0]?.url,
      twitter: j?.twitter ?? socialUrl(d, 'twitter'),
      telegram: j?.telegram ?? socialUrl(d, 'telegram'),
    },
    sources: [...e.sources.keys()],
    firstSeen: e.firstSeen,
  };
  const { score, parts, flags } = scoreToken(base, now);
  return { ...base, score, scoreParts: parts, flags, ai: null };
}

// ---------------------------------------------------------------- broadcasting

let lastMarketBroadcast = 0;
let marketTimer: NodeJS.Timeout | null = null;

/** Adds model predictions to fresh views before they're sent (set by the ML module). */
let decorate: ((views: TokenView[]) => void) | null = null;
export function setViewDecorator(fn: (views: TokenView[]) => void) {
  decorate = fn;
}

function rebuildAll() {
  const now = Date.now();
  for (const e of entries.values()) e.view = buildView(e, now);
  flagCopycats();
  if (decorate) {
    const views: TokenView[] = [];
    for (const e of entries.values()) if (e.view && !e.hidden) views.push(e.view);
    try {
      decorate(views);
    } catch (err) {
      console.error('[market] decorator failed:', err);
    }
  }
}

/**
 * Scammers launch fake tokens with the same ticker as a coin that is running.
 * Within each ticker, every token but the largest gets a warning and a score penalty.
 */
function flagCopycats() {
  const bySymbol = new Map<string, TokenView[]>();
  for (const e of entries.values()) {
    if (!e.view || e.hidden) continue;
    const key = e.view.symbol.trim().toLowerCase();
    if (!key || key === '???') continue;
    const group = bySymbol.get(key);
    if (group) group.push(e.view);
    else bySymbol.set(key, [e.view]);
  }
  for (const group of bySymbol.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0) || (b.liquidity ?? 0) - (a.liquidity ?? 0));
    const leader = group[0];
    for (const v of group.slice(1)) {
      v.flags.push({
        code: 'copycat',
        label: `Same ticker as a bigger token (${leader.mint.slice(0, 4)}…${leader.mint.slice(-4)}): check the address`,
        severity: 'warn',
      });
      if (v.score !== null && v.scoreParts) {
        v.score = Math.max(0, v.score - 10);
        v.scoreParts.penalty += 10;
      }
    }
  }
}

export function marketPayload(): MarketPayload {
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  while (launchTimes.length && launchTimes[0] < hourAgo) launchTimes.shift();
  while (graduationTimes.length && graduationTimes[0] < hourAgo) graduationTimes.shift();
  const tokens: TokenView[] = [];
  for (const e of entries.values()) if (e.view && !e.hidden) tokens.push(e.view);
  return {
    tokens,
    solPrice,
    launchesLastHour: launchTimes.length,
    graduationsLastHour: graduationTimes.length,
    startedAt,
    time: now,
  };
}

/** What each token looked like in the last broadcast, to send only what changed. */
const lastSent = new Map<string, string>();

function marketDelta(): MarketDelta {
  const full = marketPayload();
  const changed: TokenView[] = [];
  const present = new Set<string>();
  for (const t of full.tokens) {
    present.add(t.mint);
    const json = JSON.stringify(t);
    if (lastSent.get(t.mint) !== json) {
      lastSent.set(t.mint, json);
      changed.push(t);
    }
  }
  const removed: string[] = [];
  for (const mint of lastSent.keys()) {
    if (!present.has(mint)) {
      lastSent.delete(mint);
      removed.push(mint);
    }
  }
  const { tokens: _all, ...rest } = full;
  return { ...rest, tokens: changed, removed };
}

/** Rebuild views and push the changes to browsers, at most once every 2.5s. */
function scheduleMarketBroadcast() {
  if (marketTimer) return;
  const wait = Math.max(0, 2_500 - (Date.now() - lastMarketBroadcast));
  marketTimer = setTimeout(() => {
    marketTimer = null;
    lastMarketBroadcast = Date.now();
    rebuildAll();
    broadcast('marketDelta', marketDelta());
  }, wait);
}

export function launchList(): LaunchItem[] {
  return [...launches.values()].sort((a, b) => b.time - a.time).slice(0, 150);
}

export function migrationList(): MigrationItem[] {
  return [...migrations.values()].sort((a, b) => b.time - a.time).slice(0, 60);
}

let launchTimer: NodeJS.Timeout | null = null;
function scheduleLaunchBroadcast() {
  if (launchTimer) return;
  launchTimer = setTimeout(() => {
    launchTimer = null;
    broadcast('launches', launchList());
  }, 1_000);
}

// ---------------------------------------------------------------- pollers

/** Run `fn` forever, `ms` after each run finishes (never overlapping). */
function every(ms: number, id: string, fn: () => Promise<void>, delay = 0) {
  const run = async () => {
    try {
      await fn();
      markOk(id);
    } catch (e) {
      markError(id, e);
    }
    setTimeout(run, ms);
  };
  setTimeout(run, delay);
}

async function refreshDex() {
  const mints = [...entries.keys()];
  if (!mints.length) return;
  const pairs = await dsPairs(mints);
  const now = Date.now();
  for (const [mint, pair] of pairs) {
    const e = entries.get(mint);
    if (e) {
      e.ds = pair;
      e.dsAt = now;
    }
  }
  scheduleMarketBroadcast();
}

async function refreshJupiter() {
  const now = Date.now();
  // Tokens that arrived with fresh list data don't need a second fetch yet.
  const stale = [...entries.values()]
    .filter((e) => now - e.jupAt > 12_000 && now >= e.jupRetryAt)
    .map((e) => e.mint);
  if (!stale.length) return;
  const rows = await jupTokens(stale);
  const at = Date.now();
  for (const j of rows) {
    const e = entries.get(j.id);
    if (!e) continue;
    e.jup = j;
    e.jupAt = at;
    noteGraduation(j);
  }
  // Tokens Jupiter doesn't know are still refreshed by DexScreener; stop asking for 1 minute.
  const got = new Set(rows.map((r) => r.id));
  for (const mint of stale) {
    const e = entries.get(mint);
    if (e && !got.has(mint)) e.jupRetryAt = at + 60_000;
  }
  dropNonMeme();
  scheduleMarketBroadcast();
}

function dropNonMeme() {
  const now = Date.now();
  for (const e of entries.values()) {
    if (!e.hidden && isNonMeme(e.jup) && !isProtected(e, now)) retire(e);
  }
}

// ---------------------------------------------------------------- background follows

type HoldFn = (mint: string) => boolean;
const strongHolds: HoldFn[] = [];
const weakHolds: HoldFn[] = [];
const MAX_HIDDEN = 300;

/**
 * Keep following a coin's price after it drops off the lists. Without this a coin that
 * rugged would simply vanish, and an open bot trade or a model snapshot would never see the
 * loss. Strong holds (open trades) are never dropped; weak ones (model snapshots) may be if
 * too many pile up.
 */
export function registerHold(fn: HoldFn, strong: boolean) {
  (strong ? strongHolds : weakHolds).push(fn);
}
const heldStrong = (mint: string) => strongHolds.some((f) => f(mint));
const held = (mint: string) => heldStrong(mint) || weakHolds.some((f) => f(mint));

/** Start following a coin's price without listing it (e.g. an open bot trade after a restart). */
export function followInBackground(mint: string) {
  if (!mint || entries.has(mint) || NON_MEME_MINTS.has(mint)) return;
  entries.set(mint, {
    mint,
    jup: null,
    jupAt: 0,
    jupRetryAt: 0,
    ds: null,
    dsAt: 0,
    sources: new Map(),
    firstSeen: Date.now(),
    boostAmount: null,
    view: null,
    hidden: true,
  });
}

/** Remove a coin from the lists; keep following it quietly if something still needs its price. */
function retire(e: Entry) {
  if (held(e.mint)) e.hidden = true;
  else entries.delete(e.mint);
}

function prune() {
  const now = Date.now();
  for (const e of entries.values()) {
    if (e.hidden) {
      if (!held(e.mint)) entries.delete(e.mint);
      continue;
    }
    if (isProtected(e, now)) continue;
    const lastListed = Math.max(...e.sources.values());
    const liq = e.view?.liquidity ?? null;
    const ageMin = (now - e.firstSeen) / 60_000;
    const dead = liq !== null && liq < 2_000 && ageMin > 20;
    const forgotten = now - lastListed > 90 * 60_000 && (e.view?.score ?? 0) < 65;
    const noData = !e.jup && !e.ds && ageMin > 10;
    if (dead || forgotten || noData) retire(e);
  }
  const visible = [...entries.values()].filter((e) => !e.hidden);
  if (visible.length > MAX_UNIVERSE) {
    const ranked = visible.filter((e) => !isProtected(e, now)).sort((a, b) => rank(a) - rank(b));
    for (const e of ranked.slice(0, visible.length - MAX_UNIVERSE)) retire(e);
  }
  const hidden = [...entries.values()].filter((e) => e.hidden && !heldStrong(e.mint));
  if (hidden.length > MAX_HIDDEN) {
    hidden.sort((a, b) => a.firstSeen - b.firstSeen);
    for (const e of hidden.slice(0, hidden.length - MAX_HIDDEN)) entries.delete(e.mint);
  }
}

export interface EntryInfo {
  view: TokenView;
  /** Last time a price source returned data for this coin. */
  freshAt: number;
  hidden: boolean;
}

function info(e: Entry): EntryInfo | null {
  if (!e.view) return null;
  return { view: e.view, freshAt: Math.max(e.ds ? e.dsAt : 0, e.jup ? e.jupAt : 0), hidden: e.hidden };
}

/** A coin's latest view and data freshness, including coins followed in the background. */
export function entryInfo(mint: string): EntryInfo | null {
  const e = entries.get(mint);
  return e ? info(e) : null;
}

export function allEntries(): EntryInfo[] {
  const out: EntryInfo[] = [];
  for (const e of entries.values()) {
    const i = info(e);
    if (i) out.push(i);
  }
  return out;
}

/** Launches and graduations in the last hour. */
export function marketCounts() {
  const hourAgo = Date.now() - 3_600_000;
  return {
    launches1h: launchTimes.filter((t) => t >= hourAgo).length,
    grads1h: graduationTimes.filter((t) => t >= hourAgo).length,
  };
}

/** Lower = evicted first. */
function rank(e: Entry) {
  const lastListed = Math.max(...e.sources.values());
  const vol = e.view?.volume.h1 ?? 0;
  return lastListed / 60_000 + Math.log10(1 + vol) * 20 + (e.view?.score ?? 40) / 2;
}

async function pollJupList(list: JupList, interval: '5m' | '1h', source: TokenSource) {
  const rows = await jupList(list, interval, 50);
  for (const j of rows) if (!isNonMeme(j)) touch(j.id, source, j);
  scheduleMarketBroadcast();
}

function applyDsList(rows: DsListItem[], source: TokenSource) {
  for (const r of rows) {
    touch(r.tokenAddress, source);
    if (source === 'boosted' && r.totalAmount) {
      const e = entries.get(r.tokenAddress);
      if (e) e.boostAmount = r.totalAmount;
    }
  }
}

async function pollDexLists() {
  applyDsList(await dsLatestBoosts(), 'boosted');
  applyDsList(await dsTopBoosts(), 'boosted');
  applyDsList(await dsLatestProfiles(), 'profile');
  applyDsList(await dsTakeovers(), 'cto');
}

async function pollGecko() {
  for (const p of await gtTrending()) touch(p.mint, 'trending');
  for (const p of await gtNewPools()) {
    if ((p.liquidity ?? 0) >= 10_000) touch(p.mint, 'newpool');
  }
}

async function pollSolPrice() {
  const prices = await jupPrices([SOL_MINT]);
  if (prices[SOL_MINT]) solPrice = prices[SOL_MINT];
}

// ---------------------------------------------------------------- launches & graduations

function upsertLaunchFromJup(j: JupToken, fallbackTime: number) {
  let l = launches.get(j.id);
  if (!l) {
    const created = j.createdAt ? Date.parse(j.createdAt) : NaN;
    l = {
      mint: j.id,
      time: Number.isFinite(created) ? created : fallbackTime,
      launchpad: j.launchpad ?? 'unknown',
      creator: null,
      initialBuySol: null,
      symbol: null,
      name: null,
      icon: null,
      mcapUsd: null,
      volume5m: null,
      holders: null,
      buys5m: null,
      traction: false,
    };
    launches.set(j.id, l);
  }
  l.symbol = j.symbol ?? l.symbol;
  l.name = j.name ?? l.name;
  l.icon = j.icon ?? l.icon;
  l.mcapUsd = num(j.mcap) ?? l.mcapUsd;
  const s5 = j.stats5m;
  l.volume5m = s5 ? (s5.buyVolume ?? 0) + (s5.sellVolume ?? 0) : l.volume5m;
  l.buys5m = s5?.numBuys ?? l.buys5m;
  l.holders = num(j.holderCount) ?? l.holders;
  const traction = (l.mcapUsd ?? 0) >= 25_000 && ((l.volume5m ?? 0) >= 3_000 || (l.holders ?? 0) >= 80);
  if (traction && !l.traction) {
    l.traction = true;
    touch(j.id, 'launch', j);
  }
}

function trimLaunches() {
  if (launches.size <= 400) return;
  const sorted = [...launches.values()].sort((a, b) => a.time - b.time);
  for (const l of sorted.slice(0, launches.size - 400)) launches.delete(l.mint);
}

async function pollRecent() {
  const rows = await jupRecent();
  const now = Date.now();
  for (const j of rows) {
    if (!isNonMeme(j)) upsertLaunchFromJup(j, now);
  }
  trimLaunches();
  scheduleLaunchBroadcast();
}

/** Keep names, market caps and traction of the newest launches current. */
async function enrichLaunches() {
  const cutoff = Date.now() - 45 * 60_000;
  const mints = [...launches.values()]
    .filter((l) => l.time > cutoff)
    .sort((a, b) => b.time - a.time)
    .slice(0, 100)
    .map((l) => l.mint);
  if (!mints.length) return;
  const rows = await jupTokens(mints);
  const now = Date.now();
  for (const j of rows) upsertLaunchFromJup(j, now);
  // Fill in names for migrations too.
  for (const m of migrations.values()) {
    if (m.symbol) continue;
    const meta = tokenMeta(m.mint);
    m.symbol = meta.symbol;
    m.name = meta.name;
    m.icon = meta.icon;
  }
  scheduleLaunchBroadcast();
}

function addMigration(mint: string, pool: string | null, time: number, jup: JupToken | null) {
  if (migrations.has(mint)) return;
  const meta = tokenMeta(mint);
  const item: MigrationItem = {
    mint,
    time,
    symbol: jup?.symbol ?? meta.symbol,
    name: jup?.name ?? meta.name,
    icon: jup?.icon ?? meta.icon,
    mcapUsd: num(jup?.mcap) ?? launches.get(mint)?.mcapUsd ?? null,
    pool,
  };
  migrations.set(mint, item);
  graduationTimes.push(time);
  graduationTimes.sort((a, b) => a - b);
  if (migrations.size > 200) {
    const oldest = [...migrations.values()].sort((a, b) => a.time - b.time)[0];
    migrations.delete(oldest.mint);
  }
  touch(mint, 'graduated', jup);
  for (const fn of migrationListeners) fn(item);
  broadcast('migrations', migrationList());
}

/** Jupiter reports graduations too; this catches any the live stream missed. */
function noteGraduation(j: JupToken) {
  if (!j.graduatedAt || migrations.has(j.id)) return;
  const t = Date.parse(j.graduatedAt);
  if (Number.isFinite(t) && Date.now() - t < 30 * 60_000) addMigration(j.id, j.graduatedPool ?? null, t, j);
}

// ---------------------------------------------------------------- start

export function startMarket() {
  registerSource('jupiter', 'Jupiter token data');
  registerSource('dexscreener', 'DexScreener prices');
  registerSource('dexlists', 'DexScreener boosts & profiles');
  registerSource('gecko', 'GeckoTerminal pools');

  startPumpPortal({
    onCreate(c) {
      const now = Date.now();
      launchTimes.push(now);
      if (launches.has(c.mint)) return;
      const item: LaunchItem = {
        mint: c.mint,
        time: now,
        launchpad: c.pool === 'bonk' ? 'letsbonk.fun' : 'pump.fun',
        creator: c.creator,
        initialBuySol: c.initialBuySol,
        symbol: c.symbol,
        name: c.name,
        icon: null,
        mcapUsd: c.marketCapSol != null && solPrice ? c.marketCapSol * solPrice : null,
        volume5m: null,
        holders: null,
        buys5m: null,
        traction: false,
      };
      launches.set(c.mint, item);
      trimLaunches();
      broadcast('launch', item);
    },
    onMigration(m) {
      addMigration(m.mint, m.pool, Date.now(), null);
    },
  });

  // Everything starts within ~3 seconds; the limiters keep request rates safe.
  every(6_000, 'dexscreener', refreshDex, 300);
  every(20_000, 'jupiter', pollSolPrice, 0);
  every(30_000, 'jupiter', () => pollJupList('toptrending', '5m', 'trending'), 0);
  every(40_000, 'dexlists', pollDexLists, 0);
  every(60_000, 'gecko', pollGecko, 0);
  every(15_000, 'jupiter', refreshJupiter, 1_500);
  every(20_000, 'jupiter', pollRecent, 2_000);
  every(45_000, 'jupiter', () => pollJupList('toptraded', '5m', 'traded'), 2_500);
  every(15_000, 'jupiter', enrichLaunches, 3_000);
  every(90_000, 'jupiter', () => pollJupList('toporganicscore', '1h', 'organic'), 3_500);
  setInterval(prune, 60_000).unref();
}

/** Make sure a token is tracked and has fresh data (used when the user opens it). */
export async function ensureToken(mint: string): Promise<TokenView | null> {
  touch(mint, 'search');
  const e = entries.get(mint);
  if (!e) return null;
  const [jRows, pairs] = await Promise.all([
    Date.now() - e.jupAt > 10_000 ? jupTokens([mint], 'trade').catch(() => []) : Promise.resolve([]),
    Date.now() - e.dsAt > 10_000 ? dsPairs([mint]).catch(() => new Map<string, DsPair>()) : Promise.resolve(new Map<string, DsPair>()),
  ]);
  const now = Date.now();
  const j = jRows.find((r) => r.id === mint);
  if (j) {
    e.jup = j;
    e.jupAt = now;
  }
  const p = pairs.get(mint);
  if (p) {
    e.ds = p;
    e.dsAt = now;
  }
  e.view = buildView(e, now);
  return e.view;
}

/** Called by the trader engine so traded tokens get priced. */
export function trackTraderToken(mint: string) {
  touch(mint, 'trader');
}

/** A browser announcing the coins on its watchlist, so they keep being tracked. */
export function keepWatching(mints: string[]) {
  for (const m of mints) touch(m, 'watch');
  scheduleMarketBroadcast();
}

// ---------------------------------------------------------------- warm restarts

interface SavedEntry {
  mint: string;
  jup: JupToken | null;
  jupAt: number;
  ds: DsPair | null;
  dsAt: number;
  sources: [TokenSource, number][];
  firstSeen: number;
  boostAmount: number | null;
}

interface SavedMarket {
  entries: SavedEntry[];
  launches: LaunchItem[];
  migrations: MigrationItem[];
  launchTimes: number[];
  graduationTimes: number[];
  solPrice: number | null;
}

registerPersisted(
  'market',
  (): SavedMarket => ({
    entries: [...entries.values()].map((e) => ({
      mint: e.mint,
      jup: e.jup,
      jupAt: e.jupAt,
      ds: e.ds,
      dsAt: e.dsAt,
      sources: [...e.sources.entries()],
      firstSeen: e.firstSeen,
      boostAmount: e.boostAmount,
    })),
    launches: [...launches.values()],
    migrations: [...migrations.values()],
    launchTimes,
    graduationTimes,
    solPrice,
  }),
  (value) => {
    const saved = value as Partial<SavedMarket>;
    for (const s of saved.entries ?? []) {
      if (!s?.mint || entries.has(s.mint)) continue;
      entries.set(s.mint, {
        mint: s.mint,
        jup: s.jup ?? null,
        jupAt: s.jupAt ?? 0,
        jupRetryAt: 0,
        ds: s.ds ?? null,
        dsAt: s.dsAt ?? 0,
        sources: new Map(s.sources ?? []),
        firstSeen: s.firstSeen ?? Date.now(),
        boostAmount: s.boostAmount ?? null,
        view: null,
        hidden: false,
      });
    }
    for (const l of saved.launches ?? []) if (l?.mint && !launches.has(l.mint)) launches.set(l.mint, l);
    for (const m of saved.migrations ?? []) if (m?.mint && !migrations.has(m.mint)) migrations.set(m.mint, m);
    const hourAgo = Date.now() - 3_600_000;
    launchTimes.push(...(saved.launchTimes ?? []).filter((t) => t > hourAgo));
    launchTimes.sort((a, b) => a - b);
    graduationTimes.push(...(saved.graduationTimes ?? []).filter((t) => t > hourAgo));
    graduationTimes.sort((a, b) => a - b);
    solPrice ??= saved.solPrice ?? null;
    rebuildAll();
  },
);
