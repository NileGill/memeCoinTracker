import { useEffect, useRef, useState } from 'react';
import { ALERT_ICONS, updateTitle } from '../lib/alerts';
import { api, BASE58, type SearchResult } from '../lib/api';
import { fmtAgo, fmtPrice, fmtSol, fmtUsd, shortAddr } from '../lib/format';
import { connectWallet, disconnectWallet, PHANTOM_DOWNLOAD, phantomAppLink } from '../lib/phantom';
import { clearAlerts, markAlertsRead, openToken, useStore, type AlertItem } from '../store';
import { Icon } from './Icon';
import { TokenIcon, useTick } from './common';

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Search() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hl, setHl] = useState(0);
  const ref = useOutsideClose(open, () => setOpen(false));

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    const id = setTimeout(async () => {
      try {
        const r = await api.search(query);
        setResults(r);
        setHl(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const pick = (mint: string) => {
    openToken(mint);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="search" ref={ref}>
      <Icon name="search" size={15} />
      <input
        placeholder="Search any coin by name, ticker or address…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0));
          else if (e.key === 'Enter') {
            const v = q.trim();
            if (results[hl]) pick(results[hl].mint);
            else if (BASE58.test(v)) pick(v);
          }
        }}
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {loading && !results.length && <div className="empty">Searching…</div>}
          {!loading && !results.length && (
            <div className="empty">
              {BASE58.test(q.trim()) ? (
                <button className="btn sm" onClick={() => pick(q.trim())}>
                  Open this address
                </button>
              ) : (
                'No coins found'
              )}
            </div>
          )}
          {results.map((r, i) => (
            <button key={r.mint} className={i === hl ? 'hl' : ''} onMouseEnter={() => setHl(i)} onClick={() => pick(r.mint)}>
              <TokenIcon src={r.icon} symbol={r.symbol} size="sm" />
              <span style={{ minWidth: 0, flex: 1 }}>
                <b>{r.symbol}</b> <span className="muted">{r.name}</span>
                <div className="dim mono" style={{ fontSize: 11 }}>
                  {shortAddr(r.mint, 6)}
                </div>
              </span>
              <span className="num muted" style={{ fontSize: 12, textAlign: 'right' }}>
                {fmtUsd(r.mcap)}
                <div className="dim">liq {fmtUsd(r.liquidity)}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveStatus() {
  useTick(2000);
  const connected = useStore((s) => s.connected);
  const last = useStore((s) => s.lastMessageAt);
  const age = Date.now() - last;
  const state = !connected ? 'off' : age > 25_000 ? 'stale' : 'on';
  const label = state === 'on' ? 'Live' : state === 'stale' ? 'Waiting for data' : 'Reconnecting…';
  return (
    <span className={`live ${state}`} title={last ? `Last update ${fmtAgo(last)}` : ''}>
      <span className="dot" />
      <span className="hide-xs">{label}</span>
    </span>
  );
}

function AlertRow({ a }: { a: AlertItem }) {
  return (
    <div
      className="feed-item"
      onClick={() => {
        if (a.mint) openToken(a.mint);
        else if (a.url) window.open(a.url, '_blank', 'noopener');
      }}
    >
      <span className={`alert-kind ${a.severity}`}>
        <Icon name={ALERT_ICONS[a.kind]} size={15} />
      </span>
      <div className="main-col">
        <div className="title" style={{ fontSize: 13 }}>
          <span className="truncate">{a.title}</span>
        </div>
        <div className="meta truncate">{a.body}</div>
      </div>
      <span className="dim nowrap" style={{ fontSize: 11.5 }}>
        {fmtAgo(a.time)}
      </span>
    </div>
  );
}

export function AlertList({ limit = 50 }: { limit?: number }) {
  useTick(5000);
  const alerts = useStore((s) => s.alerts);
  if (!alerts.length)
    return <div className="empty">No alerts yet. They appear here while this page is open, as things happen.</div>;
  return (
    <div className="feed">
      {alerts.slice(0, limit).map((a) => (
        <AlertRow key={a.id} a={a} />
      ))}
    </div>
  );
}

function Alerts() {
  const unread = useStore((s) => s.unread);
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        className="icon-btn"
        title="Alerts"
        onClick={() => {
          setOpen((o) => !o);
          markAlertsRead();
          updateTitle();
        }}
      >
        <Icon name="bell" size={17} />
        {unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="alert-panel">
          <div className="panel-head">
            <h2>Alerts</h2>
            <span className="sub">while this tab is open</span>
            <button className="btn ghost xs" style={{ marginLeft: 'auto' }} onClick={clearAlerts}>
              Clear
            </button>
          </div>
          <AlertList />
        </div>
      )}
    </div>
  );
}

function WalletButton() {
  const wallet = useStore((s) => s.wallet);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useOutsideClose(open, () => setOpen(false));

  if (!wallet.address) {
    return (
      <div style={{ position: 'relative' }}>
        <button
          className="wallet-btn"
          disabled={wallet.connecting}
          onClick={async () => {
            setErr(null);
            try {
              await connectWallet();
            } catch (e) {
              setErr((e as Error).message);
              setTimeout(() => setErr(null), 6000);
            }
          }}
          title={wallet.available ? 'Connect your Phantom wallet' : 'Phantom not detected: click to install'}
        >
          <span className="phantom-logo">
            <PhantomGlyph />
          </span>
          <span className="hide-xs">
            {wallet.connecting ? 'Connecting…' : wallet.available ? 'Connect Phantom' : phantomAppLink() ? 'Open in Phantom' : 'Get Phantom'}
          </span>
        </button>
        {err && (
          <div className="menu" style={{ padding: 12, fontSize: 13 }}>
            {err}
            {!wallet.available && (
              <a href={PHANTOM_DOWNLOAD} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-2)', marginTop: 6 }}>
                Download Phantom <Icon name="external" size={12} />
              </a>
            )}
          </div>
        )}
      </div>
    );
  }

  const sol = wallet.holdings?.sol;
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
        <span className="phantom-logo">
          <PhantomGlyph />
        </span>
        <span className="num">{sol != null ? fmtSol(sol) : shortAddr(wallet.address)}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu">
          <div className="menu-head">
            <div className="mono" style={{ fontSize: 12 }}>
              {shortAddr(wallet.address, 6)}
            </div>
            <div style={{ fontWeight: 750, fontSize: 18, marginTop: 4 }}>{sol != null ? fmtSol(sol) : '…'}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {fmtUsd(wallet.holdings?.solValueUsd)} · {wallet.holdings?.tokens.length ?? 0} tokens
            </div>
          </div>
          <a href="#/portfolio" onClick={() => setOpen(false)}>
            <Icon name="wallet" size={15} /> Portfolio
          </a>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(wallet.address!);
              setOpen(false);
            }}
          >
            <Icon name="copy" size={15} /> Copy address
          </button>
          <a href={`https://solscan.io/account/${wallet.address}`} target="_blank" rel="noreferrer">
            <Icon name="external" size={15} /> View on Solscan
          </a>
          <button
            onClick={() => {
              void disconnectWallet();
              setOpen(false);
            }}
          >
            <Icon name="logout" size={15} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function PhantomGlyph() {
  return <Icon name="wallet" size={12} strokeWidth={2.4} />;
}

export function Header() {
  const solPrice = useStore((s) => s.solPrice);
  return (
    <header className="header">
      <Search />
      <span className="spacer" />
      <LiveStatus />
      <span className="sol-price hide-xs" title="SOL price">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="solg" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#00FFA3" />
              <stop offset="1" stopColor="#DC1FFF" />
            </linearGradient>
          </defs>
          <path fill="url(#solg)" d="M5 16.5h14l-3 3H2l3-3Zm0-6h14l-3 3H2l3-3ZM8 4.5h14l-3 3H5l3-3Z" />
        </svg>
        {fmtPrice(solPrice)}
      </span>
      <Alerts />
      <WalletButton />
    </header>
  );
}
