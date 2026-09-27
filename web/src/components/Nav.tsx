import { useStore } from '../store';
import { Icon, type IconName } from './Icon';

export type Route = 'dashboard' | 'setups' | 'market' | 'launches' | 'traders' | 'watchlist' | 'news' | 'portfolio' | 'settings';

export const ROUTES: { id: Route; label: string; short: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Dashboard', short: 'Home', icon: 'dashboard' },
  { id: 'setups', label: 'Best trades', short: 'Setups', icon: 'target' },
  { id: 'market', label: 'Trending', short: 'Trending', icon: 'fire' },
  { id: 'launches', label: 'New launches', short: 'New', icon: 'rocket' },
  { id: 'traders', label: 'Top traders', short: 'Traders', icon: 'users' },
  { id: 'watchlist', label: 'Watchlist', short: 'Watch', icon: 'star' },
  { id: 'news', label: 'News', short: 'News', icon: 'news' },
  { id: 'portfolio', label: 'Portfolio', short: 'Wallet', icon: 'wallet' },
  { id: 'settings', label: 'Settings & alerts', short: 'Settings', icon: 'settings' },
];

export function Nav({ route }: { route: Route }) {
  const hot = useStore((s) => s.tokenList.filter((t) => (t.score ?? 0) >= s.settings.setupThreshold && !t.flags.some((f) => f.severity === 'danger')).length);
  const watch = useStore((s) => s.watchlist.length);
  const badge = (id: Route) => {
    if (id === 'setups' && hot > 0) return <span className="badge green">{hot}</span>;
    if (id === 'watchlist' && watch > 0) return <span className="badge">{watch}</span>;
    return null;
  };
  return (
    <>
      <div className="brand">
        <span style={{ color: 'var(--accent-2)', display: 'inline-flex' }}>
          <Icon name="radar" size={24} />
        </span>
        <div>
          MemeRadar
          <small>Solana memecoins, live</small>
        </div>
      </div>
      <nav className="nav">
        {ROUTES.map((r) => (
          <a key={r.id} href={`#/${r.id === 'dashboard' ? '' : r.id}`} className={route === r.id ? 'active' : ''}>
            <Icon name={r.icon} size={17} />
            {r.label}
            {badge(r.id)}
          </a>
        ))}
        <div className="nav-foot">
          Data: Jupiter, DexScreener, GeckoTerminal, pump.fun, Kolscan, RugCheck, Solana RPC and crypto news feeds.
          <br />
          Not financial advice.
        </div>
      </nav>
      <nav className="mobile-nav">
        {ROUTES.map((r) => (
          <a key={r.id} href={`#/${r.id === 'dashboard' ? '' : r.id}`} className={route === r.id ? 'active' : ''}>
            <Icon name={r.icon} size={18} />
            {r.short}
          </a>
        ))}
      </nav>
    </>
  );
}
