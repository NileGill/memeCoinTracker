import { useMemo, useState } from 'react';
import type { TokenSource } from '../../../shared/types';
import { TokenTable } from '../components/TokenTable';
import { useStore } from '../store';
import { PageTitle } from './shared';

const FILTERS: { id: 'all' | TokenSource; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'trending', label: 'Trending' },
  { id: 'traded', label: 'Most traded' },
  { id: 'organic', label: 'Organic volume' },
  { id: 'boosted', label: 'Boosted' },
  { id: 'profile', label: 'New profiles' },
  { id: 'cto', label: 'Community takeovers' },
  { id: 'newpool', label: 'New pools' },
  { id: 'graduated', label: 'Graduated' },
  { id: 'launch', label: 'Launches with traction' },
  { id: 'trader', label: 'Trader buys' },
];

export function Market() {
  const tokenList = useStore((s) => s.tokenList);
  const hasSnapshot = useStore((s) => s.hasSnapshot);
  const [filter, setFilter] = useState<'all' | TokenSource>('all');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return tokenList.filter(
      (t) =>
        (filter === 'all' || t.sources.includes(filter)) &&
        (!query || t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.mint.toLowerCase() === query),
    );
  }, [tokenList, filter, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tokenList.length };
    for (const t of tokenList) for (const s of t.sources) c[s] = (c[s] ?? 0) + 1;
    return c;
  }, [tokenList]);

  return (
    <>
      <PageTitle title="Trending memecoins" sub="Every coin being tracked live, from all sources. Click a column to sort.">
        <input className="input" style={{ width: 220 }} placeholder="Filter by name or ticker…" value={q} onChange={(e) => setQ(e.target.value)} />
      </PageTitle>
      <div className="chips" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label} <span className="dim">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="panel">
        <TokenTable
          tokens={rows}
          defaultSort={{ col: 'vol1h', desc: true }}
          columns={['token', 'score', 'price', 'm5', 'h1', 'h6', 'h24', 'vol5m', 'vol1h', 'liq', 'mcap', 'holders', 'age', 'flags', 'spark', 'actions']}
          empty={hasSnapshot ? 'No coins in this category right now.' : 'Loading live market…'}
        />
      </div>
    </>
  );
}
