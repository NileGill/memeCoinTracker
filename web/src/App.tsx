import { useEffect, useState, type ComponentType } from 'react';
import { AuthModal } from './components/AuthModal';
import { Header } from './components/Header';
import { Nav, ROUTES, type Route } from './components/Nav';
import { Toasts } from './components/Toasts';
import { TokenDrawer } from './components/TokenDrawer';
import { initAuth } from './lib/auth';
import { initWallet } from './lib/phantom';
import { startStream } from './lib/stream';
import { closeToken } from './store';
import { Account } from './pages/Account';
import { Bot } from './pages/Bot';
import { Dashboard } from './pages/Dashboard';
import { Launches } from './pages/Launches';
import { Market } from './pages/Market';
import { News } from './pages/News';
import { Portfolio } from './pages/Portfolio';
import { Settings } from './pages/Settings';
import { Setups } from './pages/Setups';
import { Traders } from './pages/Traders';
import { Watchlist } from './pages/Watchlist';

function routeFromHash(): Route {
  const id = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (id === 'account') return 'account';
  return (ROUTES.find((r) => r.id === id)?.id ?? 'dashboard') as Route;
}

const PAGES: Record<Route, ComponentType> = {
  dashboard: Dashboard,
  setups: Setups,
  bot: Bot,
  market: Market,
  launches: Launches,
  traders: Traders,
  watchlist: Watchlist,
  news: News,
  portfolio: Portfolio,
  settings: Settings,
  account: Account,
};

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    startStream();
    initWallet();
    void initAuth();
    const onHash = () => {
      setRoute(routeFromHash());
      closeToken();
      document.querySelector('.main')?.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const Page = PAGES[route];
  return (
    <div className="app">
      <Nav route={route} />
      <Header />
      <main className="main">
        <div className="main-inner">
          <Page />
        </div>
      </main>
      <TokenDrawer />
      <AuthModal />
      <Toasts />
    </div>
  );
}
