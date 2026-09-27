import type { ReactNode } from 'react';
import type { LaunchItem, MigrationItem, NewsItem, TokenView, TraderTrade } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { AiChip, FlagIcons, Pct, ScoreBadge, TokenCell, TokenIcon } from '../components/common';
import { fmtAge, fmtAgo, fmtSol, fmtUsd, shortAddr } from '../lib/format';
import { openToken, useStore, type Settings } from '../store';

const RISKY = new Set(['bots', 'copycat', 'dumping']);

/** Scored tokens that pass the user's liquidity and risk filters, best first. */
export function selectSetups(tokens: TokenView[], settings: Settings): TokenView[] {
  return tokens
    .filter(
      (t) =>
        t.score != null &&
        (t.liquidity ?? 0) >= settings.setupsMinLiquidity &&
        (!settings.hideRisky || !t.flags.some((f) => f.severity === 'danger' || RISKY.has(f.code))),
    )
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function PageTitle({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <span className="spacer" />
      {children}
    </div>
  );
}

export function SetupRow({ t }: { t: TokenView }) {
  return (
    <div className="feed-item" onClick={() => openToken(t.mint)}>
      <ScoreBadge t={t} />
      <div className="main-col">
        <TokenCell t={t} sub={`${fmtUsd(t.mcap)} mcap · liq ${fmtUsd(t.liquidity)} · ${fmtAge(t.createdAt)} old`} />
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
        <div>
          5m <Pct v={t.change.m5} />
        </div>
        <div>
          1h <Pct v={t.change.h1} />
        </div>
      </div>
      <FlagIcons flags={t.flags} hideEmpty />
      <AiChip t={t} />
      <button
        className="btn buy xs"
        onClick={(e) => {
          e.stopPropagation();
          openToken(t.mint, 'buy');
        }}
      >
        Buy
      </button>
    </div>
  );
}

export function LaunchRow({ l, fresh }: { l: LaunchItem; fresh?: boolean }) {
  const sym = l.symbol ?? shortAddr(l.mint);
  return (
    <div className={`feed-item ${fresh ? 'enter' : ''}`} onClick={() => openToken(l.mint)}>
      <TokenIcon src={l.icon} symbol={sym} />
      <div className="main-col">
        <div className="title">
          <span className="truncate">{sym}</span>
          {l.traction && <span className="badge green">traction</span>}
          {l.launchpad !== 'unknown' && <span className="badge">{l.launchpad}</span>}
        </div>
        <div className="meta truncate">
          {l.name ?? 'Fetching details…'}
          {l.initialBuySol != null && ` · dev bought ${fmtSol(l.initialBuySol)}`}
        </div>
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
        <div>{fmtUsd(l.mcapUsd)}</div>
        <div className="dim">{l.holders != null ? `${l.holders} holders` : fmtAgo(l.time)}</div>
      </div>
    </div>
  );
}

export function MigrationRow({ m }: { m: MigrationItem }) {
  const sym = m.symbol ?? shortAddr(m.mint);
  return (
    <div className="feed-item" onClick={() => openToken(m.mint)}>
      <TokenIcon src={m.icon} symbol={sym} />
      <div className="main-col">
        <div className="title">
          <span className="truncate">{sym}</span>
          <span className="badge accent">
            <Icon name="grad" size={11} /> graduated
          </span>
        </div>
        <div className="meta truncate">{m.name ?? ''}</div>
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
        <div>{fmtUsd(m.mcapUsd)}</div>
        <div className="dim">{fmtAgo(m.time)}</div>
      </div>
    </div>
  );
}

export function TraderTradeRow({ tr, showTrader = true }: { tr: TraderTrade; showTrader?: boolean }) {
  const token = useStore((s) => s.tokens[tr.mint]);
  const sym = token?.symbol ?? tr.symbol ?? shortAddr(tr.mint);
  return (
    <div className="feed-item" onClick={() => openToken(tr.mint, 'buy')}>
      <span className={`badge ${tr.side === 'buy' ? 'green' : 'red'}`} style={{ width: 42, justifyContent: 'center' }}>
        {tr.side === 'buy' ? 'BUY' : 'SELL'}
      </span>
      <TokenIcon src={token?.icon} symbol={sym} size="sm" />
      <div className="main-col">
        <div className="title">
          <span className="truncate">
            {showTrader && <span className="muted">{tr.traderLabel} · </span>}${sym}
          </span>
        </div>
        <div className="meta">
          {fmtAgo(tr.time)}
          {token?.mcap != null && ` · mcap now ${fmtUsd(token.mcap)}`}
        </div>
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
        <div>{tr.quote === 'SOL' ? fmtSol(tr.quoteAmount) : fmtUsd(tr.quoteAmount)}</div>
        <div className="dim">{fmtUsd(tr.usdValue)}</div>
      </div>
    </div>
  );
}

export function NewsRow({ n, compact }: { n: NewsItem; compact?: boolean }) {
  if (compact) {
    return (
      <a className="feed-item" href={n.url} target="_blank" rel="noreferrer">
        <div className="main-col">
          <div className="title" style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'normal' }}>
            {n.title}
          </div>
          <div className="meta">
            {n.source} · {fmtAgo(n.published)}
            {n.tickers.length > 0 && ` · ${n.tickers.map((t) => `$${t}`).join(' ')}`}
          </div>
        </div>
      </a>
    );
  }
  return (
    <a className="news-card" href={n.url} target="_blank" rel="noreferrer">
      {n.image ? (
        <img src={n.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
      ) : null}
      <div style={{ minWidth: 0 }}>
        <h3>{n.title}</h3>
        {n.summary && <p>{n.summary}</p>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, fontSize: 12 }}>
          <span className="badge">{n.source}</span>
          {n.meme && <span className="badge accent">memecoin</span>}
          {n.tickers.map((t) => (
            <span key={t} className="badge blue">
              ${t}
            </span>
          ))}
          <span className="dim">{fmtAgo(n.published)}</span>
        </div>
      </div>
    </a>
  );
}
