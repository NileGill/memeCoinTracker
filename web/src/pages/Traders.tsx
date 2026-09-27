import { useMemo, useState } from 'react';
import type { TraderView } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { CopyButton, Empty, useTick } from '../components/common';
import { api, BASE58 } from '../lib/api';
import { fmtAgo, fmtNum, fmtSol, fmtUsd, hashColor, shortAddr } from '../lib/format';
import { forgetTrader, rememberTrader, useStore } from '../store';
import { useIsPhone } from '../lib/useMedia';
import { PageTitle, TraderTradeRow } from './shared';

function AddTrader() {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const a = address.trim();
    if (!BASE58.test(a)) {
      setErr('That is not a valid Solana wallet address.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.addTrader(a, label.trim());
      rememberTrader(a, label.trim());
      setAddress('');
      setLabel('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-body col" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '2 1 240px' }} placeholder="Wallet address" value={address} onChange={(e) => setAddress(e.target.value)} />
        <input
          className="input"
          style={{ flex: '1 1 120px' }}
          placeholder="Name (optional)"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="btn primary" disabled={busy || !address.trim()} onClick={submit}>
          <Icon name="plus" size={15} /> Watch
        </button>
      </div>
      {err && <div className="down" style={{ fontSize: 12.5 }}>{err}</div>}
    </div>
  );
}

function TraderCard({ t, selected, onSelect }: { t: TraderView; selected: boolean; onSelect: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.label);
  const net = t.today.solOut - t.today.solIn;
  return (
    <div className={`trader-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="avatar" style={{ background: hashColor(t.address) }}>
        {t.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            className="input"
            autoFocus
            value={name}
            maxLength={40}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={async () => {
              setEditing(false);
              if (name.trim() && name.trim() !== t.label) {
                await api.updateTrader(t.address, { label: name.trim() }).catch(() => setName(t.label));
                if (useStore.getState().traders.some((x) => x.address === t.address)) rememberTrader(t.address, name.trim());
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">{t.label}</b>
            <span className={`status-dot ${t.status}`} title={t.statusMessage ?? t.status} />
            {t.source === 'kolscan' && <span className="badge">KOL</span>}
          </div>
        )}
        <div className="dim mono" style={{ fontSize: 11.5 }}>
          {shortAddr(t.address, 5)} · {t.lastTradeAt ? `last trade ${fmtAgo(t.lastTradeAt)}` : 'no trades seen yet'}
        </div>
        {t.status === 'noisy' && (
          <div className="warn" style={{ fontSize: 11.5 }}>
            Heavy spam on this wallet, some trades may be missed
          </div>
        )}
        {t.status === 'error' && t.statusMessage && (
          <div className="down truncate" style={{ fontSize: 11.5 }} title={t.statusMessage}>
            {t.statusMessage}
          </div>
        )}
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12 }}>
        <div>
          <span className="up">{t.today.buys}B</span> / <span className="down">{t.today.sells}S</span>
        </div>
        <div className={net > 0 ? 'up' : net < 0 ? 'down' : 'dim'} title="SOL out minus SOL in today (not realised PnL)">
          {net === 0 ? '—' : `${net > 0 ? '+' : ''}${fmtSol(net)}`}
        </div>
      </div>
      <div className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
        <button
          className="btn ghost xs"
          title={t.alerts ? 'Alerts on for this trader' : 'Alerts off for this trader'}
          onClick={() => api.updateTrader(t.address, { alerts: !t.alerts })}
          style={{ color: t.alerts ? 'var(--accent-2)' : undefined }}
        >
          <Icon name="bell" size={14} />
        </button>
        <button className="btn ghost xs" title="Rename" onClick={() => setEditing(true)}>
          <Icon name="settings" size={14} />
        </button>
        <a className="btn ghost xs" title="Open on Solscan" href={`https://solscan.io/account/${t.address}`} target="_blank" rel="noreferrer">
          <Icon name="external" size={14} />
        </a>
        <CopyButton text={t.address} />
        <button
          className="btn ghost xs"
          title="Stop watching"
          onClick={() => {
            if (confirm(`Stop watching ${t.label}?`)) {
              forgetTrader(t.address);
              void api.removeTrader(t.address);
            }
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

export function Traders() {
  useTick(5000);
  const traders = useStore((s) => s.traders);
  const trades = useStore((s) => s.traderTrades);
  const leaderboard = useStore((s) => s.leaderboard);
  const leaderboardUpdated = useStore((s) => s.leaderboardUpdated);
  const [selected, setSelected] = useState<string | null>(null);
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const watched = useMemo(() => new Set(traders.map((t) => t.address)), [traders]);
  const mobile = useIsPhone();
  const watchKol = (address: string, name: string) => {
    rememberTrader(address, name);
    void api.addTrader(address, name, 'kolscan');
  };

  const feed = trades.filter((t) => (!selected || t.trader === selected) && (side === 'all' || t.side === side));
  const selectedLabel = traders.find((t) => t.address === selected)?.label;

  return (
    <>
      <PageTitle
        title="Top traders"
        sub="Watch the wallets of proven memecoin traders. Their swaps are decoded straight from the Solana chain and alert you as they happen."
      />
      <div className="grid dash">
        <section className="panel span-5">
          <div className="panel-head">
            <h2>
              <Icon name="users" size={15} /> Watched wallets
            </h2>
            <span className="sub">{traders.length} / 40</span>
          </div>
          <AddTrader />
          <div>
            {traders.map((t) => (
              <TraderCard key={t.address} t={t} selected={selected === t.address} onSelect={() => setSelected((s) => (s === t.address ? null : t.address))} />
            ))}
            {!traders.length && <Empty>No wallets yet. Add one above or pick from the leaderboard.</Empty>}
          </div>
        </section>

        <section className="panel span-7">
          <div className="panel-head">
            <h2>
              <Icon name="zap" size={15} /> {selectedLabel ? `${selectedLabel}'s trades` : 'Live trades'}
            </h2>
            {selected && (
              <button className="btn ghost xs" onClick={() => setSelected(null)}>
                Show all
              </button>
            )}
            <div className="seg" style={{ marginLeft: 'auto' }}>
              {(['all', 'buy', 'sell'] as const).map((s) => (
                <button key={s} className={side === s ? `on ${s === 'all' ? '' : s}` : ''} onClick={() => setSide(s)}>
                  {s === 'all' ? 'All' : s === 'buy' ? 'Buys' : 'Sells'}
                </button>
              ))}
            </div>
          </div>
          <div className="feed" style={{ maxHeight: 640, overflowY: 'auto' }}>
            {feed.map((t) => (
              <TraderTradeRow key={t.id} tr={t} showTrader={!selected} />
            ))}
            {!feed.length && (
              <Empty>
                Trades appear here within about 20 seconds of landing on-chain. A few recent trades per wallet are loaded
                when you start watching it.
              </Empty>
            )}
          </div>
        </section>

        <section className="panel span-12">
          <div className="panel-head">
            <h2>
              <Icon name="trend" size={15} /> Today's most profitable memecoin traders
            </h2>
            <span className="sub">
              Kolscan leaderboard{leaderboardUpdated ? `, updated ${fmtAgo(leaderboardUpdated)}` : ''}
            </span>
            <a className="more" href="https://kolscan.io/leaderboard" target="_blank" rel="noreferrer">
              kolscan.io ↗
            </a>
          </div>
          {leaderboard.length && mobile ? (
            <div className="mlist">
              {leaderboard.map((k) => {
                const total = k.wins + k.losses;
                return (
                  <div key={k.address} className="mrow" style={{ cursor: 'default' }}>
                    <span className="dim num" style={{ width: 20, textAlign: 'right' }}>
                      {k.rank}
                    </span>
                    <div className="avatar" style={{ background: hashColor(k.address), width: 32, height: 32, fontSize: 12 }}>
                      {k.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
                    </div>
                    <div className="mrow-main">
                      <div className="mrow-top">
                        <b className="truncate">{k.name}</b>
                      </div>
                      <div className="mrow-sub">
                        <span className="up">{k.wins}W</span> / <span className="down">{k.losses}L</span>
                        {total ? ` · ${((k.wins / total) * 100).toFixed(0)}% wins` : ''}
                      </div>
                    </div>
                    <div className="mrow-right num">
                      <div className={k.profitSol >= 0 ? 'up' : 'down'}>
                        {k.profitSol >= 0 ? '+' : ''}
                        {fmtNum(k.profitSol)} SOL
                      </div>
                      <div className="dim">{fmtUsd(k.profitUsd, { sign: true })}</div>
                    </div>
                    {watched.has(k.address) ? (
                      <span className="badge green">
                        <Icon name="check" size={11} />
                      </span>
                    ) : (
                      <button className="btn xs primary" disabled={traders.length >= 40} onClick={() => watchKol(k.address, k.name)}>
                        Watch
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : leaderboard.length ? (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th className="c">#</th>
                    <th className="l">Trader</th>
                    <th>Wins / losses</th>
                    <th>Win rate</th>
                    <th>Profit (SOL)</th>
                    <th>Profit (USD)</th>
                    <th className="c"></th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((k) => {
                    const total = k.wins + k.losses;
                    const on = watched.has(k.address);
                    return (
                      <tr key={k.address} style={{ cursor: 'default' }}>
                        <td className="c dim">{k.rank}</td>
                        <td className="l">
                          <div className="row">
                            <div className="avatar" style={{ background: hashColor(k.address), width: 28, height: 28, fontSize: 11 }}>
                              {k.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
                            </div>
                            <div>
                              <b>{k.name}</b>
                              <div className="dim mono" style={{ fontSize: 11 }}>
                                {shortAddr(k.address, 5)}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="up">{k.wins}</span> / <span className="down">{k.losses}</span>
                        </td>
                        <td>{total ? `${((k.wins / total) * 100).toFixed(0)}%` : '—'}</td>
                        <td className={k.profitSol >= 0 ? 'up' : 'down'}>
                          {k.profitSol >= 0 ? '+' : ''}
                          {fmtNum(k.profitSol)}
                        </td>
                        <td className={k.profitUsd >= 0 ? 'up' : 'down'}>{fmtUsd(k.profitUsd, { sign: true })}</td>
                        <td className="c">
                          {on ? (
                            <span className="badge green">
                              <Icon name="check" size={11} /> watching
                            </span>
                          ) : (
                            <button
                              className="btn xs primary"
                              disabled={traders.length >= 40}
                              onClick={() => {
                                rememberTrader(k.address, k.name);
                                void api.addTrader(k.address, k.name, 'kolscan');
                              }}
                            >
                              <Icon name="plus" size={12} /> Watch
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Leaderboard unavailable right now. You can still add any wallet above.</Empty>
          )}
        </section>
      </div>
    </>
  );
}
