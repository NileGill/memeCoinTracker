import { Icon } from '../components/Icon';
import { Empty, Pct, TokenIcon, useTick } from '../components/common';
import { fmtAgo, fmtNum, fmtPrice, fmtSol, fmtUsd, shortAddr } from '../lib/format';
import { connectWallet, PHANTOM_DOWNLOAD, refreshHoldings } from '../lib/phantom';
import { openToken, useStore } from '../store';
import { PageTitle } from './shared';

export function Portfolio() {
  useTick(10_000);
  const wallet = useStore((s) => s.wallet);
  const tokens = useStore((s) => s.tokens);
  const swaps = useStore((s) => s.swaps);
  const h = wallet.holdings;

  if (!wallet.address) {
    return (
      <>
        <PageTitle title="Portfolio" sub="Your Phantom wallet's balances and one-click selling." />
        <div className="panel">
          <div className="empty" style={{ padding: 48 }}>
            <div style={{ marginBottom: 14, fontSize: 15, color: 'var(--text)' }}>Connect Phantom to see your coins and trade.</div>
            {wallet.available ? (
              <button className="btn primary lg" onClick={() => connectWallet().catch(() => undefined)} disabled={wallet.connecting}>
                <Icon name="wallet" size={16} /> {wallet.connecting ? 'Connecting…' : 'Connect Phantom'}
              </button>
            ) : (
              <a className="btn primary lg" href={PHANTOM_DOWNLOAD} target="_blank" rel="noreferrer">
                Install Phantom
              </a>
            )}
            <div className="dim" style={{ marginTop: 14, fontSize: 12.5 }}>
              Connecting only shares your public address. Every trade needs your approval in Phantom.
            </div>
          </div>
        </div>
      </>
    );
  }

  const tokenValue = h?.tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0) ?? 0;
  const total = (h?.solValueUsd ?? 0) + tokenValue;

  return (
    <>
      <PageTitle title="Portfolio" sub={`Wallet ${shortAddr(wallet.address, 6)}`}>
        <button className="btn sm" onClick={() => void refreshHoldings()}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </PageTitle>

      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <div className="kpi">
          <div className="label">Total value</div>
          <div className="value num">{h ? fmtUsd(total) : '…'}</div>
          <div className="hint">SOL + priced tokens</div>
        </div>
        <div className="kpi">
          <div className="label">SOL</div>
          <div className="value num">{h ? fmtSol(h.sol) : '…'}</div>
          <div className="hint">{fmtUsd(h?.solValueUsd)}</div>
        </div>
        <div className="kpi">
          <div className="label">Tokens</div>
          <div className="value num">{h ? h.tokens.length : '…'}</div>
          <div className="hint">{fmtUsd(tokenValue)}</div>
        </div>
      </div>

      {wallet.holdingsError && <div className="notice red" style={{ marginBottom: 12 }}>Couldn't load balances: {wallet.holdingsError}</div>}

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head">
          <h2>Holdings</h2>
          {h && <span className="sub">updated {fmtAgo(h.time)}</span>}
        </div>
        {h && h.tokens.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th className="l">Token</th>
                  <th>Amount</th>
                  <th>Price</th>
                  <th>Value</th>
                  <th>5m</th>
                  <th>1h</th>
                  <th className="c">Sell</th>
                </tr>
              </thead>
              <tbody>
                {h.tokens.map((t) => {
                  const live = tokens[t.mint];
                  const sym = t.symbol ?? shortAddr(t.mint);
                  const price = live?.priceUsd ?? t.priceUsd;
                  return (
                    <tr key={t.mint} onClick={() => openToken(t.mint, 'sell')}>
                      <td className="l">
                        <div className="token-cell">
                          <TokenIcon src={t.icon} symbol={sym} />
                          <div className="names">
                            <div className="sym">{sym}</div>
                            <div className="nm">{t.name}</div>
                          </div>
                        </div>
                      </td>
                      <td>{fmtNum(t.uiAmount)}</td>
                      <td>{fmtPrice(price)}</td>
                      <td>{price != null ? fmtUsd(price * t.uiAmount) : '—'}</td>
                      <td>
                        <Pct v={live?.change.m5} />
                      </td>
                      <td>
                        <Pct v={live?.change.h1} />
                      </td>
                      <td className="c">
                        <button
                          className="btn sell xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            openToken(t.mint, 'sell');
                          }}
                        >
                          Sell
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{h ? 'No tokens in this wallet yet.' : 'Loading balances…'}</Empty>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Trades from this site</h2>
          <span className="sub">stored in this browser</span>
        </div>
        {swaps.length ? (
          <div className="feed">
            {swaps.map((s) => (
              <a key={s.signature} className="feed-item" href={`https://solscan.io/tx/${s.signature}`} target="_blank" rel="noreferrer">
                <span className={`badge ${s.side === 'buy' ? 'green' : 'red'}`}>{s.side.toUpperCase()}</span>
                <div className="main-col">
                  <div className="title">${s.symbol}</div>
                  <div className="meta">{fmtAgo(s.time)}</div>
                </div>
                <span className="num" style={{ fontSize: 12.5 }}>
                  {s.side === 'buy'
                    ? `${fmtSol(s.inAmount)} → ${fmtNum(s.outAmount)} ${s.symbol}`
                    : `${fmtNum(s.inAmount)} ${s.symbol} → ${fmtSol(s.outAmount)}`}
                </span>
                <Icon name="external" size={13} />
              </a>
            ))}
          </div>
        ) : (
          <Empty>Trades you make here will be listed with links to the transaction.</Empty>
        )}
      </div>
    </>
  );
}
