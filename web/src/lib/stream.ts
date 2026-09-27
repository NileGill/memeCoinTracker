import type {
  KolEntry,
  LaunchItem,
  MarketPayload,
  MigrationItem,
  NewsItem,
  ServerEvent,
  Snapshot,
  SourceStatus,
  TraderTrade,
  TraderView,
} from '../../../shared/types';
import { applyMarket, useStore } from '../store';
import { checkMarket, checkNews, handleServerEvent, resetPriming } from './alerts';

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
      watchlist: s.watchlist,
      status: s.status,
    });
    checkMarket(s.market.tokens, s.market.startedAt);
    checkNews(s.news);
  });

  on<MarketPayload>('market', (m) => {
    applyMarket(m);
    checkMarket(m.tokens, m.startedAt);
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
  on<string[]>('watchlist', (watchlist) => useStore.setState({ watchlist }));
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
