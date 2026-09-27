import { useMemo, useState, type ReactNode } from 'react';
import type { TokenView } from '../../../shared/types';
import { fmtAge, fmtNum, fmtPrice, fmtUsd } from '../lib/format';
import { useCompactLists } from '../lib/useMedia';
import { openToken, priceMoves } from '../store';
import { Empty, FlagIcons, Pct, Pressure, ScoreBadge, Sparkline, StarButton, TokenCell, TokenIcon } from './common';

export type Col =
  | 'rank'
  | 'token'
  | 'score'
  | 'price'
  | 'm5'
  | 'h1'
  | 'h6'
  | 'h24'
  | 'vol5m'
  | 'vol1h'
  | 'vol24h'
  | 'liq'
  | 'mcap'
  | 'age'
  | 'holders'
  | 'pressure'
  | 'flags'
  | 'spark'
  | 'actions';

interface ColDef {
  label: string;
  cls?: string;
  hide?: string;
  sort?: (t: TokenView) => number | null;
  render: (t: TokenView, i: number) => ReactNode;
  title?: string;
}

const COLS: Record<Col, ColDef> = {
  rank: { label: '#', cls: 'c', render: (_t, i) => <span className="dim">{i + 1}</span> },
  token: { label: 'Token', cls: 'l', render: (t) => <TokenCell t={t} /> },
  score: {
    label: 'Score',
    cls: 'c',
    sort: (t) => t.score,
    render: (t) => <ScoreBadge t={t} />,
    title: 'Momentum score 0-100 (hover a score for the breakdown)',
  },
  price: { label: 'Price', sort: (t) => t.priceUsd, render: (t) => <span className="num">{fmtPrice(t.priceUsd)}</span> },
  m5: { label: '5m', sort: (t) => t.change.m5, render: (t) => <Pct v={t.change.m5} /> },
  h1: { label: '1h', sort: (t) => t.change.h1, render: (t) => <Pct v={t.change.h1} /> },
  h6: { label: '6h', hide: 'hide-sm hide-md', sort: (t) => t.change.h6, render: (t) => <Pct v={t.change.h6} /> },
  h24: { label: '24h', hide: 'hide-sm hide-md', sort: (t) => t.change.h24, render: (t) => <Pct v={t.change.h24} /> },
  vol5m: { label: 'Vol 5m', hide: 'hide-sm hide-lg', sort: (t) => t.volume.m5, render: (t) => fmtUsd(t.volume.m5) },
  vol1h: { label: 'Vol 1h', sort: (t) => t.volume.h1, render: (t) => fmtUsd(t.volume.h1) },
  vol24h: { label: 'Vol 24h', hide: 'hide-sm', sort: (t) => t.volume.h24, render: (t) => fmtUsd(t.volume.h24) },
  liq: { label: 'Liquidity', sort: (t) => t.liquidity, render: (t) => fmtUsd(t.liquidity) },
  mcap: { label: 'MCap', sort: (t) => t.mcap, render: (t) => fmtUsd(t.mcap) },
  age: {
    label: 'Age',
    hide: 'hide-sm',
    sort: (t) => (t.createdAt ? -t.createdAt : null),
    render: (t) => <span className="muted">{fmtAge(t.createdAt)}</span>,
  },
  holders: { label: 'Holders', hide: 'hide-sm hide-lg', sort: (t) => t.holders, render: (t) => fmtNum(t.holders, 0) },
  pressure: {
    label: 'Buys 5m',
    cls: 'c',
    hide: 'hide-sm hide-md',
    sort: (t) => {
      const b = t.buyVolume.m5 ?? t.txns.m5?.buys;
      const s = t.sellVolume.m5 ?? t.txns.m5?.sells;
      return b != null && s != null && b + s > 0 ? b / (b + s) : null;
    },
    render: (t) =>
      t.buyVolume.m5 != null ? (
        <Pressure buy={t.buyVolume.m5} sell={t.sellVolume.m5} />
      ) : (
        <Pressure buy={t.txns.m5?.buys} sell={t.txns.m5?.sells} />
      ),
    title: 'Share of 5-minute volume that was buying',
  },
  flags: { label: 'Risk', cls: 'c', render: (t) => <FlagIcons flags={t.flags} /> },
  spark: { label: 'Live', cls: 'c', hide: 'hide-xs hide-laptop', render: (t) => <Sparkline mint={t.mint} /> },
  actions: {
    label: '',
    cls: 'c',
    render: (t) => (
      <span className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
        <StarButton mint={t.mint} />
        <button
          className="btn buy xs"
          onClick={(e) => {
            e.stopPropagation();
            openToken(t.mint, 'buy');
          }}
        >
          Trade
        </button>
      </span>
    ),
  },
};

export function TokenTable({
  tokens,
  columns,
  defaultSort,
  limit = 100,
  empty = 'No tokens match right now.',
  presorted = false,
}: {
  tokens: TokenView[];
  columns: Col[];
  defaultSort?: { col: Col; desc: boolean };
  limit?: number;
  empty?: ReactNode;
  /** Keep the incoming order until the user clicks a column. */
  presorted?: boolean;
}) {
  const [sort, setSort] = useState<{ col: Col; desc: boolean } | null>(presorted ? null : (defaultSort ?? null));
  const [shown, setShown] = useState(limit);
  const mobile = useCompactLists();

  const rows = useMemo(() => {
    if (!sort) return tokens;
    const fn = COLS[sort.col].sort;
    if (!fn) return tokens;
    return [...tokens].sort((a, b) => {
      const va = fn(a);
      const vb = fn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return sort.desc ? vb - va : va - vb;
    });
  }, [tokens, sort]);

  if (!tokens.length) return <Empty>{empty}</Empty>;
  const now = Date.now();

  if (mobile) {
    const sortable = columns.filter((c) => COLS[c].sort);
    return (
      <div>
        {sortable.length > 0 && (
          <div className="mlist-sort">
            <span className="muted">Sort by</span>
            <select
              className="input"
              value={sort ? `${sort.col}:${sort.desc ? 'd' : 'a'}` : ''}
              onChange={(e) => {
                const [col, dir] = e.target.value.split(':');
                setSort(col ? { col: col as Col, desc: dir === 'd' } : null);
              }}
            >
              {presorted && <option value="">Best first</option>}
              {sortable.map((c) => (
                <option key={c} value={`${c}:d`}>
                  {c === 'age' ? 'Newest' : `${COLS[c].label} (high to low)`}
                </option>
              ))}
              {sortable.includes('m5') && <option value="m5:a">5m (biggest drops)</option>}
            </select>
          </div>
        )}
        <div className="mlist">
          {rows.slice(0, shown).map((t) => {
            const mv = priceMoves.get(t.mint);
            const flash = mv && now - mv.at < 1500 ? `flash-${mv.dir}-${mv.seq % 2}` : '';
            return (
              <div key={t.mint} className={`mrow ${flash}`} onClick={() => openToken(t.mint)}>
                <TokenIcon src={t.icon} symbol={t.symbol} />
                <div className="mrow-main">
                  <div className="mrow-top">
                    <b className="truncate">{t.symbol}</b>
                    {columns.includes('flags') && <FlagIcons flags={t.flags} hideEmpty />}
                  </div>
                  <div className="mrow-sub">
                    {fmtUsd(t.mcap)} mcap · liq {fmtUsd(t.liquidity)} · {fmtAge(t.createdAt)}
                  </div>
                </div>
                <div className="mrow-right num">
                  <div>{fmtPrice(t.priceUsd)}</div>
                  <div>
                    <Pct v={t.change.m5} /> <span className="dim">5m</span>
                  </div>
                  <div>
                    <Pct v={t.change.h1} /> <span className="dim">1h</span>
                  </div>
                </div>
                {columns.includes('score') && <ScoreBadge t={t} />}
                <StarButton mint={t.mint} size={18} />
              </div>
            );
          })}
        </div>
        {rows.length > shown && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button className="btn" onClick={() => setShown((n) => n + limit)}>
              Show more ({rows.length - shown} left)
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {columns.map((c) => {
              const def = COLS[c];
              const sortable = Boolean(def.sort);
              const active = sort?.col === c;
              return (
                <th
                  key={c}
                  className={[def.cls, def.hide, sortable ? 'sortable' : '', active ? 'sorted' : ''].filter(Boolean).join(' ')}
                  title={def.title}
                  onClick={() => sortable && setSort((s) => ({ col: c, desc: s?.col === c ? !s.desc : true }))}
                >
                  {def.label}
                  {active ? (sort!.desc ? ' ↓' : ' ↑') : ''}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((t, i) => {
            const mv = priceMoves.get(t.mint);
            const flash = mv && now - mv.at < 1500 ? `flash-${mv.dir}-${mv.seq % 2}` : '';
            return (
              <tr key={t.mint} className={flash} onClick={() => openToken(t.mint)}>
                {columns.map((c) => (
                  <td key={c} className={[COLS[c].cls, COLS[c].hide].filter(Boolean).join(' ')}>
                    {COLS[c].render(t, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > shown && (
        <div style={{ padding: 12, textAlign: 'center' }}>
          <button className="btn sm" onClick={() => setShown((n) => n + limit)}>
            Show more ({rows.length - shown} left)
          </button>
        </div>
      )}
    </div>
  );
}
