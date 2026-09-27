import { useMemo, useState } from 'react';
import { Empty, useTick } from '../components/common';
import { useStore } from '../store';
import { NewsRow, PageTitle } from './shared';

export function News() {
  useTick(30_000);
  const news = useStore((s) => s.news);
  const [scope, setScope] = useState<'meme' | 'all'>('meme');
  const [source, setSource] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const sources = useMemo(() => [...new Set(news.map((n) => n.source))].sort(), [news]);
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return news.filter(
      (n) =>
        (scope === 'all' || n.meme) &&
        (!source || n.source === source) &&
        (!query || n.title.toLowerCase().includes(query) || n.summary.toLowerCase().includes(query) || n.tickers.some((t) => t.toLowerCase() === query.replace('$', ''))),
    );
  }, [news, scope, source, q]);

  return (
    <>
      <PageTitle title="News" sub="Memecoin and crypto headlines from 14 sources, refreshed every few minutes.">
        <input className="input" style={{ width: 220 }} placeholder="Search headlines or $TICKER…" value={q} onChange={(e) => setQ(e.target.value)} />
      </PageTitle>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div className="seg">
          <button className={scope === 'meme' ? 'on' : ''} onClick={() => setScope('meme')}>
            Memecoins
          </button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            All crypto
          </button>
        </div>
        <div className="chips">
          <button className={`chip ${!source ? 'on' : ''}`} onClick={() => setSource(null)}>
            All sources
          </button>
          {sources.map((s) => (
            <button key={s} className={`chip ${source === s ? 'on' : ''}`} onClick={() => setSource(s === source ? null : s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="panel">
        {rows.slice(0, 150).map((n) => (
          <NewsRow key={n.id} n={n} />
        ))}
        {!rows.length && <Empty>{news.length ? 'No headlines match.' : 'Loading news…'}</Empty>}
      </div>
    </>
  );
}
