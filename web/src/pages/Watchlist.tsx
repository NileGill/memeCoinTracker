import { useMemo } from 'react';
import type { TokenView } from '../../../shared/types';
import { TokenTable } from '../components/TokenTable';
import { useStore } from '../store';
import { PageTitle } from './shared';

export function Watchlist() {
  const watchlist = useStore((s) => s.watchlist);
  const tokens = useStore((s) => s.tokens);
  const settings = useStore((s) => s.settings);
  const rows = useMemo(() => watchlist.map((m) => tokens[m]).filter((t): t is TokenView => Boolean(t)), [watchlist, tokens]);
  const loading = watchlist.length - rows.length;

  return (
    <>
      <PageTitle
        title="Watchlist"
        sub={`Coins you starred, saved in this browser. You get an alert when one moves ${settings.watchPct}%+ in 5 minutes, either direction.`}
      />
      <div className="panel">
        <TokenTable
          tokens={rows}
          defaultSort={{ col: 'm5', desc: true }}
          columns={['token', 'score', 'price', 'm5', 'h1', 'h6', 'h24', 'vol1h', 'liq', 'mcap', 'holders', 'flags', 'spark', 'actions']}
          empty={watchlist.length ? 'Loading your coins…' : 'Star any coin (☆) to add it here.'}
        />
        {loading > 0 && rows.length > 0 && (
          <div className="dim" style={{ padding: '8px 14px', fontSize: 12 }}>
            Loading {loading} more…
          </div>
        )}
      </div>
    </>
  );
}
