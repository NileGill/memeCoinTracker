import { create } from 'zustand';
import type {
  HoldingsResponse,
  KolEntry,
  LaunchItem,
  MarketDelta,
  MarketPayload,
  MigrationItem,
  NewsItem,
  SourceStatus,
  TokenView,
  TraderTrade,
  TraderView,
} from '../../shared/types';

export interface Settings {
  sound: boolean;
  desktop: boolean;
  alertSetups: boolean;
  setupThreshold: number;
  alertPumps: boolean;
  pumpPct: number;
  alertVolume: boolean;
  minAlertLiquidity: number;
  alertTraders: boolean;
  traderMinSol: number;
  alertConvergence: boolean;
  alertMigrations: boolean;
  alertWatchlist: boolean;
  watchPct: number;
  alertNews: boolean;
  buyPresets: number[];
  maxTradeSol: number;
  setupsMinLiquidity: number;
  hideRisky: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  desktop: false,
  alertSetups: true,
  setupThreshold: 75,
  alertPumps: true,
  pumpPct: 25,
  alertVolume: true,
  minAlertLiquidity: 20_000,
  alertTraders: true,
  traderMinSol: 0.5,
  alertConvergence: true,
  alertMigrations: false,
  alertWatchlist: true,
  watchPct: 10,
  alertNews: true,
  buyPresets: [0.05, 0.1, 0.25, 0.5, 1],
  maxTradeSol: 2,
  setupsMinLiquidity: 10_000,
  hideRisky: true,
};

const SETTINGS_KEY = 'memeradar.settings.v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    if (!Array.isArray(merged.buyPresets) || merged.buyPresets.length !== 5 || merged.buyPresets.some((v) => !(v > 0)))
      merged.buyPresets = DEFAULT_SETTINGS.buyPresets;
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export type AlertSeverity = 'high' | 'danger' | 'normal' | 'low';
export type AlertKind = 'setup' | 'pump' | 'dump' | 'volume' | 'trader' | 'convergence' | 'migration' | 'watch' | 'news';

export interface AlertItem {
  id: string;
  time: number;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  mint?: string;
  url?: string;
}

export interface ExecutedSwap {
  signature: string;
  time: number;
  side: 'buy' | 'sell';
  mint: string;
  symbol: string;
  inAmount: number;
  outAmount: number;
}

interface WalletState {
  available: boolean;
  address: string | null;
  connecting: boolean;
  holdings: HoldingsResponse | null;
  holdingsError: string | null;
}

export interface AppState {
  connected: boolean;
  lastMessageAt: number;
  hasSnapshot: boolean;

  tokens: Record<string, TokenView>;
  tokenList: TokenView[];
  solPrice: number | null;
  launchesLastHour: number;
  graduationsLastHour: number;
  marketTime: number;
  launches: LaunchItem[];
  migrations: MigrationItem[];
  news: NewsItem[];
  traders: TraderView[];
  traderTrades: TraderTrade[];
  leaderboard: KolEntry[];
  leaderboardUpdated: number | null;
  watchlist: string[];
  status: SourceStatus[];

  alerts: AlertItem[];
  unread: number;
  toasts: AlertItem[];

  selectedMint: string | null;
  drawerSide: 'buy' | 'sell';
  settings: Settings;
  wallet: WalletState;
  swaps: ExecutedSwap[];
}

const WATCH_KEY = 'memeradar.watchlist.v1';
const MY_TRADERS_KEY = 'memeradar.mytraders.v1';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function loadJson<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: lasts for this session only */
  }
}

const isMintList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && BASE58.test(x));

export interface MyTrader {
  address: string;
  label: string;
}
const isMyTraders = (v: unknown): v is MyTrader[] =>
  Array.isArray(v) && v.every((x) => x && typeof x.address === 'string' && BASE58.test(x.address) && typeof x.label === 'string');

const SWAPS_KEY = 'memeradar.swaps.v1';
function loadSwaps(): ExecutedSwap[] {
  try {
    const raw = localStorage.getItem(SWAPS_KEY);
    const v = raw ? (JSON.parse(raw) as ExecutedSwap[]) : [];
    return Array.isArray(v) ? v.slice(0, 100) : [];
  } catch {
    return [];
  }
}

export const useStore = create<AppState>(() => ({
  connected: false,
  lastMessageAt: 0,
  hasSnapshot: false,
  tokens: {},
  tokenList: [],
  solPrice: null,
  launchesLastHour: 0,
  graduationsLastHour: 0,
  marketTime: 0,
  launches: [],
  migrations: [],
  news: [],
  traders: [],
  traderTrades: [],
  leaderboard: [],
  leaderboardUpdated: null,
  watchlist: loadJson(WATCH_KEY, isMintList, []).slice(0, 100),
  status: [],
  alerts: [],
  unread: 0,
  toasts: [],
  selectedMint: null,
  drawerSide: 'buy',
  settings: loadSettings(),
  wallet: { available: false, address: null, connecting: false, holdings: null, holdingsError: null },
  swaps: loadSwaps(),
}));

const set = useStore.setState;
const get = useStore.getState;

// ------------------------------------------------------------------ price history (session only)

/** Last ~10 minutes of prices per token, for sparklines. Kept outside React state on purpose. */
export const priceHistory = new Map<string, number[]>();

/** Latest price direction per token, used to flash table rows green or red. */
export const priceMoves = new Map<string, { dir: 'up' | 'down'; seq: number; at: number }>();

function recordPrice(t: TokenView) {
  if (t.priceUsd == null) return;
  const h = priceHistory.get(t.mint) ?? [];
  const last = h[h.length - 1];
  if (last !== undefined && last !== t.priceUsd) {
    const prev = priceMoves.get(t.mint);
    priceMoves.set(t.mint, { dir: t.priceUsd > last ? 'up' : 'down', seq: (prev?.seq ?? 0) + 1, at: Date.now() });
  }
  if (last !== t.priceUsd) h.push(t.priceUsd);
  if (h.length > 100) h.splice(0, h.length - 100);
  priceHistory.set(t.mint, h);
}

/** Full market state (sent on connect). */
export function applyMarket(m: MarketPayload) {
  const tokens: Record<string, TokenView> = {};
  for (const t of m.tokens) {
    tokens[t.mint] = t;
    recordPrice(t);
  }
  for (const mint of priceHistory.keys()) {
    if (!tokens[mint]) {
      priceHistory.delete(mint);
      priceMoves.delete(mint);
    }
  }
  set({
    tokens,
    tokenList: m.tokens,
    solPrice: m.solPrice ?? get().solPrice,
    launchesLastHour: m.launchesLastHour,
    graduationsLastHour: m.graduationsLastHour,
    marketTime: m.time,
  });
}

/** Incremental update: only tokens that changed, plus removals. Returns the merged list. */
export function applyMarketDelta(d: MarketDelta): TokenView[] {
  const tokens = { ...get().tokens };
  for (const t of d.tokens) {
    tokens[t.mint] = t;
    recordPrice(t);
  }
  for (const mint of d.removed) {
    delete tokens[mint];
    priceHistory.delete(mint);
    priceMoves.delete(mint);
  }
  const tokenList = Object.values(tokens);
  set({
    tokens,
    tokenList,
    solPrice: d.solPrice ?? get().solPrice,
    launchesLastHour: d.launchesLastHour,
    graduationsLastHour: d.graduationsLastHour,
    marketTime: d.time,
  });
  return tokenList;
}

// ------------------------------------------------------------------ watchlist (kept in this browser)

export function toggleWatch(mint: string) {
  const cur = get().watchlist;
  const watchlist = cur.includes(mint) ? cur.filter((m) => m !== mint) : [...cur, mint].slice(-100);
  set({ watchlist });
  saveJson(WATCH_KEY, watchlist);
  return watchlist;
}

// ------------------------------------------------------------------ trader wallets this browser added

export function myTraders(): MyTrader[] {
  return loadJson(MY_TRADERS_KEY, isMyTraders, []);
}

export function rememberTrader(address: string, label: string) {
  const list = myTraders().filter((t) => t.address !== address);
  saveJson(MY_TRADERS_KEY, [...list, { address, label }].slice(-40));
}

export function forgetTrader(address: string) {
  saveJson(MY_TRADERS_KEY, myTraders().filter((t) => t.address !== address));
}

// ------------------------------------------------------------------ actions

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}

export function openToken(mint: string, side: 'buy' | 'sell' = 'buy') {
  set({ selectedMint: mint, drawerSide: side });
}

export function closeToken() {
  set({ selectedMint: null });
}

export function recordSwap(s: ExecutedSwap) {
  const swaps = [s, ...get().swaps].slice(0, 100);
  set({ swaps });
  try {
    localStorage.setItem(SWAPS_KEY, JSON.stringify(swaps));
  } catch {
    /* ignore */
  }
}

export function setWallet(patch: Partial<WalletState>) {
  set({ wallet: { ...get().wallet, ...patch } });
}

export function dismissToast(id: string) {
  set({ toasts: get().toasts.filter((t) => t.id !== id) });
}

export function markAlertsRead() {
  set({ unread: 0 });
}

export function clearAlerts() {
  set({ alerts: [], unread: 0 });
}
