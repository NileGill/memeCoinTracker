import type {
  KolEntry,
  LaunchItem,
  MarketDelta,
  MigrationItem,
  NewsItem,
  ServerEvent,
  Snapshot,
  SourceStatus,
  TraderTrade,
  TraderView,
} from '../../../shared/types';
import { applyMarket, applyMarketDelta, myTraders, useStore } from '../store';
import { checkMarket, checkNews, handleServerEvent, resetPriming } from './alerts';
import { api } from './api';

/**
 * Re-announce this browser's watchlist so the server keeps tracking those coins.
 * Sent even when empty: on free hosting it also keeps the server awake while a tab is open.
 */
export function announceWatchlist() {
  api.watching(useStore.getState().watchlist).catch(() => undefined);
}

/** Put back any trader wallets this browser added, e.g. after the server restarted. */
function restoreMyTraders(serverTraders: TraderView[]) {
  const have = new Set(serverTraders.map((t) => t.address));
  for (const t of myTraders()) {
    if (!have.has(t.address)) api.addTrader(t.address, t.label).catch(() => undefined);
  }
}

setInterval(announceWatchlist, 4 * 60_000);

/** The bundle this tab is running, e.g. "index-QxZedPTv.js" (null in dev mode). */
const myVersion = (() => {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src ?? '';
  return /(index-[\w-]+\.js)/.exec(src)?.[1] ?? null;
})();

/** After a new version is deployed, reload so this tab isn't running old code (at most once a minute). */
function reloadIfOutdated(serverVersion: string | null): boolean {
  if (!myVersion || !serverVersion || myVersion === serverVersion) return false;
  try {
    const last = Number(sessionStorage.getItem('memeradar.reloadAt') ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem('memeradar.reloadAt', String(Date.now()));
  } catch {
    /* no sessionStorage: still reload */
  }
  location.reload();
  return true;
}

let es: EventSource | null = null;

function on<T>(name: string, fn: (data: T) => void) {
  es?.addEventListener(name, (e) => {
    useStore.setState({ lastMessageAt: Date.now(), connected: true });
    try {
      fn(JSON.parse((e as MessageEvent<string>).data) as T);
    } catch (err) {
      console.error(`[stream] bad ${name} message`, err);
    }
  });
}

export function startStream() {
  if (es) return;
  es = new EventSource('/api/stream');

  es.onopen = () => useStore.setState({ connected: true, lastMessageAt: Date.now() });
  es.onerror = () => useStore.setState({ connected: false });

  on<Snapshot>('snapshot', (s) => {
    if (reloadIfOutdated(s.version)) return;
    resetPriming();
    applyMarket(s.market);
    useStore.setState({
      hasSnapshot: true,
      launches: s.launches,
      migrations: s.migrations,
      news: s.news,
      traders: s.traders,
      traderTrades: s.traderTrades,
      leaderboard: s.leaderboard,
      leaderboardUpdated: s.leaderboardUpdated,
      status: s.status,
    });
    checkMarket(s.market.tokens, s.market.startedAt);
    checkNews(s.news);
    announceWatchlist();
    restoreMyTraders(s.traders);
  });

  on<MarketDelta>('marketDelta', (d) => {
    const all = applyMarketDelta(d);
    checkMarket(all, d.startedAt);
  });

  on<LaunchItem>('launch', (item) => {
    const launches = [item, ...useStore.getState().launches.filter((l) => l.mint !== item.mint)].slice(0, 150);
    useStore.setState({ launches });
  });
  on<LaunchItem[]>('launches', (launches) => useStore.setState({ launches }));
  on<MigrationItem[]>('migrations', (migrations) => useStore.setState({ migrations }));
  on<NewsItem[]>('news', (news) => {
    useStore.setState({ news });
    checkNews(news);
  });
  on<TraderView[]>('traders', (traders) => useStore.setState({ traders }));
  on<TraderTrade[]>('traderTrades', (traderTrades) => useStore.setState({ traderTrades }));
  on<{ leaderboard: KolEntry[]; leaderboardUpdated: number | null }>('leaderboard', (l) =>
    useStore.setState({ leaderboard: l.leaderboard, leaderboardUpdated: l.leaderboardUpdated }),
  );
  on<SourceStatus[]>('status', (status) => useStore.setState({ status }));

  on<ServerEvent>('event', (ev) => {
    if (ev.type === 'traderTrade') {
      const trades = useStore.getState().traderTrades.filter((t) => t.id !== ev.trade.id);
      const traderTrades = [ev.trade, ...trades].sort((a, b) => b.time - a.time).slice(0, 200);
      useStore.setState({ traderTrades });
    }
    handleServerEvent(ev);
  });
}
