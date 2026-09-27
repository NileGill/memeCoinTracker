import { create } from 'zustand';
import type {
  HoldingsResponse,
  KolEntry,
  LaunchItem,
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
  watchlist: [],
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

export function applyMarket(m: MarketPayload) {
  const tokens: Record<string, TokenView> = {};
  for (const t of m.tokens) {
    tokens[t.mint] = t;
    if (t.priceUsd != null) {
      const h = priceHistory.get(t.mint) ?? [];
      const last = h[h.length - 1];
      if (last !== undefined && last !== t.priceUsd) {
        const prev = priceMoves.get(t.mint);
        priceMoves.set(t.mint, { dir: t.priceUsd > last ? 'up' : 'down', seq: (prev?.seq ?? 0) + 1, at: Date.now() });
      }
      if (h[h.length - 1] !== t.priceUsd) h.push(t.priceUsd);
      if (h.length > 100) h.splice(0, h.length - 100);
      priceHistory.set(t.mint, h);
    }
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
