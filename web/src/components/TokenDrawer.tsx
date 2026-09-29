import { useEffect, useState } from 'react';
import type { AiDriver, TokenDetail, TokenView } from '../../../shared/types';
import { api } from '../lib/api';
import { fmtAge, fmtAgo, fmtNum, fmtPct, fmtPrice, fmtSol, fmtUsd, pctClass, shortAddr } from '../lib/format';
import { closeToken, useStore } from '../store';
import { Icon } from './Icon';
import { CopyButton, ScoreBar, scoreClass, StarButton, TokenIcon, useTick } from './common';
import { TradePanel } from './TradePanel';

function Driver({ d, max }: { d: AiDriver; max: number }) {
  const w = (Math.abs(d.impact) / max) * 50;
  const up = d.impact >= 0;
  return (
    <div className="bar-row">
      <span className="muted truncate">{d.label}</span>
      <div className="bar-track">
        <div className="mid" />
        <div className="bar-fill" style={{ left: up ? '50%' : `${50 - w}%`, width: `${w}%`, background: up ? 'var(--green)' : 'var(--red)' }} />
      </div>
      <span className={`num ${up ? 'up' : 'down'}`} style={{ textAlign: 'right' }}>
        {up ? 'helps' : 'hurts'}
      </span>
    </div>
  );
}

/** The AI model's rating of this coin and the biggest reasons behind it. */
function AiPanel({ t, drivers }: { t: TokenView; drivers: AiDriver[] | null | undefined }) {
  const model = useStore((s) => s.ml?.model);
  if (!t.ai || !model) return null;
  const { win, ev, pick, risk } = t.ai;
  const max = Math.max(...(drivers ?? []).map((d) => Math.abs(d.impact)), 0.001);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="sparkles" size={15} /> AI model
        </h2>
        <span className={`badge ${model.proven ? 'green' : 'amber'}`}>{model.proven ? 'proven in testing' : 'not proven yet'}</span>
      </div>
      <div className="panel-body col" style={{ gap: 10 }}>
        <div style={{ fontSize: 13.5 }}>
          <b>{Math.round(win * 100)}%</b> of similar setups hit <span className="up">+{model.target.tp}%</span> before{' '}
          <span className="down">−{model.target.sl}%</span> within {model.target.holdMin} minutes in testing
          {ev != null && (
            <>
              , averaging <span className={pctClass(ev)}>{fmtPct(ev)}</span> after fees
            </>
          )}
          . {pick ? <b className="up">The bot would buy this now.</b> : <span className="muted">Not strong enough for the bot to buy.</span>}
        </div>
        {risk != null && (
          <div style={{ fontSize: 13.5 }}>
            Crash chance: <b className={risk >= (model.crash?.maxRisk ?? 1) ? 'down' : ''}>{Math.round(risk * 100)}%</b>{' '}
            <span className="muted">
              (falling 50%+ or vanishing within the hour{model.crash ? `; ${Math.round(model.crash.rate * 100)}% of coins did in testing` : ''})
              {model.crash?.maxRisk != null && risk > model.crash.maxRisk ? '. Too risky: the bot skips it.' : ''}
            </span>
          </div>
        )}
        {drivers && drivers.length > 0 && (
          <>
            <div className="dim" style={{ fontSize: 12 }}>
              Biggest reasons behind this rating
            </div>
            <div className="bars ai-drivers">
              {drivers.map((d) => (
                <Driver key={d.label} d={d} max={max} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className={`v num ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  trending: 'Trending',
  traded: 'Most traded',
  organic: 'Organic volume',
  boosted: 'DexScreener boost',
  profile: 'New profile',
  cto: 'Community takeover',
  newpool: 'New pool',
  launch: 'Fresh launch',
  graduated: 'Graduated',
  trader: 'Watched trader',
  watch: 'Watchlist',
  search: 'Searched',
};

export function TokenDrawer() {
  const mint = useStore((s) => s.selectedMint);
  const side = useStore((s) => s.drawerSide);
  const live = useStore((s) => (mint ? s.tokens[mint] : undefined));
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTick(5000);

  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    const load = async () => {
      try {
        const d = await api.token(mint);
        if (!cancelled) {
          setDetail(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    const id = setInterval(load, 20_000);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeToken();
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('keydown', onKey);
    };
  }, [mint]);

  if (!mint) return null;
  // Prefer the live-streamed record (updates every few seconds); fall back to the detail fetch.
  const t: TokenView | undefined = live ?? detail?.token;

  return (
    <>
      <div className="drawer-backdrop" onClick={closeToken} />
      <aside className="drawer" role="dialog" aria-label="Token details">
        <div className="drawer-head">
          {t ? (
            <>
              <TokenIcon src={t.icon} symbol={t.symbol} size="lg" />
              <div className="drawer-title">
                <div className="row" style={{ gap: 8 }}>
                  <b className="drawer-symbol">{t.symbol}</b>
                  {t.verified && <span className="badge green hide-sm">Verified</span>}
                  {t.score != null && <span className={`score ${scoreClass(t.score)}`}>{t.score}</span>}
                </div>
                <div className="muted truncate" style={{ fontSize: 13 }}>
                  {t.name}
                </div>
              </div>
              <div className="drawer-price">
                <div className="num drawer-price-value">
                  {fmtPrice(t.priceUsd)}
                </div>
                <div className={`num ${pctClass(t.change.h24)}`} style={{ fontSize: 13 }}>
                  {fmtPct(t.change.h24)} 24h
                </div>
              </div>
            </>
          ) : (
            <div className="muted">{error ?? 'Loading…'}</div>
          )}
          <StarButton mint={mint} size={19} />
          <button className="icon-btn" onClick={closeToken} title="Close (Esc)">
            <Icon name="x" size={17} />
          </button>
        </div>

        {t && (
          <div className="drawer-body">
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="mono dim" style={{ fontSize: 12 }}>
                {shortAddr(t.mint, 8)}
              </span>
              <CopyButton text={t.mint} label="Copy address" />
              <span className="spacer" />
              {t.sources
                .filter((s) => s !== 'search' && s !== 'watch')
                .map((s) => (
                  <span key={s} className="badge">
                    {SOURCE_LABEL[s] ?? s}
                  </span>
                ))}
            </div>

            <iframe
              key={t.pairAddress ?? t.mint}
              className="chart-frame"
              title={`${t.symbol} chart`}
              src={`https://dexscreener.com/solana/${t.pairAddress ?? t.mint}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=5`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />

            <TradePanel token={t} initialSide={side} />

            <div className="stats-grid">
              <Stat k="Market cap" v={fmtUsd(t.mcap)} />
              <Stat k="Liquidity" v={fmtUsd(t.liquidity)} />
              <Stat k="Holders" v={fmtNum(t.holders, 0)} />
              <Stat k="Age" v={fmtAge(t.createdAt)} />
              <Stat k="5m" v={fmtPct(t.change.m5)} cls={pctClass(t.change.m5)} />
              <Stat k="1h" v={fmtPct(t.change.h1)} cls={pctClass(t.change.h1)} />
              <Stat k="6h" v={fmtPct(t.change.h6)} cls={pctClass(t.change.h6)} />
              <Stat k="24h" v={fmtPct(t.change.h24)} cls={pctClass(t.change.h24)} />
              <Stat k="Vol 5m" v={fmtUsd(t.volume.m5)} />
              <Stat k="Vol 1h" v={fmtUsd(t.volume.h1)} />
              <Stat k="Vol 24h" v={fmtUsd(t.volume.h24)} />
              <Stat
                k="Buys / sells 5m"
                v={
                  t.buyVolume.m5 != null
                    ? `${fmtUsd(t.buyVolume.m5)} / ${fmtUsd(t.sellVolume.m5)}`
                    : t.txns.m5
                      ? `${t.txns.m5.buys} / ${t.txns.m5.sells}`
                      : '—'
                }
              />
              <Stat k="Traders 5m" v={fmtNum(t.traders5m, 0)} />
              <Stat k="Net buyers 1h" v={fmtNum(t.netBuyers1h, 0)} />
              <Stat k="Holder growth 1h" v={fmtPct(t.holderChange1h)} cls={pctClass(t.holderChange1h)} />
              <Stat k="Organic score" v={t.organicScore != null ? `${t.organicScore.toFixed(0)} (${t.organicLabel})` : '—'} />
            </div>

            <AiPanel t={t} drivers={detail?.aiDrivers} />

            {t.scoreParts && (
              <div className="panel">
                <div className="panel-head">
                  <h2>
                    <Icon name="target" size={15} /> Setup score {t.score}/100
                  </h2>
                  <span className="sub">momentum screen, not a prediction</span>
                </div>
                <div className="panel-body bars">
                  <ScoreBar label="Momentum" v={t.scoreParts.momentum} signed />
                  <ScoreBar label="Buy pressure" v={t.scoreParts.flow} signed />
                  <ScoreBar label="Volume pace" v={t.scoreParts.acceleration} signed />
                  <ScoreBar label="Participation" v={t.scoreParts.participation} />
                  <ScoreBar label="Quality" v={t.scoreParts.quality} />
                  {t.scoreParts.penalty > 0 && <div className="warn">−{t.scoreParts.penalty} points for the risk flags below</div>}
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <h2>
                  <Icon name="shield" size={15} /> Safety checks
                </h2>
                {detail?.security.rugcheckScore != null && (
                  <span className="sub">RugCheck risk score {detail.security.rugcheckScore} (lower is safer)</span>
                )}
              </div>
              <div className="panel-body flag-list">
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <span className={`badge ${t.audit.mintDisabled === false ? 'red' : t.audit.mintDisabled ? 'green' : ''}`}>
                    Mint authority {t.audit.mintDisabled === false ? 'ON' : t.audit.mintDisabled ? 'revoked' : 'unknown'}
                  </span>
                  <span className={`badge ${t.audit.freezeDisabled === false ? 'red' : t.audit.freezeDisabled ? 'green' : ''}`}>
                    Freeze authority {t.audit.freezeDisabled === false ? 'ON' : t.audit.freezeDisabled ? 'revoked' : 'unknown'}
                  </span>
                  {t.audit.topHoldersPct != null && (
                    <span className={`badge ${t.audit.topHoldersPct > 50 ? 'amber' : ''}`}>
                      Top holders {t.audit.topHoldersPct.toFixed(1)}%
                    </span>
                  )}
                  {t.audit.devPct != null && <span className="badge">Dev holds {t.audit.devPct.toFixed(2)}%</span>}
                  {detail?.security.lpLockedPct != null && (
                    <span className="badge">LP locked {detail.security.lpLockedPct.toFixed(0)}%</span>
                  )}
                </div>
                {t.flags.map((f) => (
                  <div key={f.code} className={`flag-line ${f.severity}`}>
                    <Icon name={f.severity === 'info' ? 'info' : 'alert'} size={14} />
                    <span>{f.label}</span>
                  </div>
                ))}
                {detail?.security.rugcheckRisks.map((r) => (
                  <div key={r.name} className={`flag-line ${r.level === 'danger' ? 'danger' : r.level === 'warn' ? 'warn' : ''}`}>
                    <Icon name="shield" size={14} />
                    <span>
                      <b>{r.name}</b> {r.description && <span className="muted">· {r.description}</span>}
                    </span>
                  </div>
                ))}
                {detail?.security.shieldWarnings
                  .filter((w) => w.severity !== 'info')
                  .map((w) => (
                    <div key={w.type} className={`flag-line ${w.severity === 'critical' ? 'danger' : 'warn'}`}>
                      <Icon name="alert" size={14} />
                      <span>{w.message}</span>
                    </div>
                  ))}
                {!t.flags.length && !detail?.security.rugcheckRisks.length && (
                  <div className="dim">No risk flags detected. That doesn't make a memecoin safe.</div>
                )}
              </div>
            </div>

            {detail && detail.watchedTraderTrades.length > 0 && (
              <div className="panel">
                <div className="panel-head">
                  <h2>
                    <Icon name="users" size={15} /> Watched traders in this coin
                  </h2>
                </div>
                <div className="feed">
                  {detail.watchedTraderTrades.map((tr) => (
                    <div key={tr.id} className="feed-item" style={{ cursor: 'default' }}>
                      <span className={`badge ${tr.side === 'buy' ? 'green' : 'red'}`}>{tr.side.toUpperCase()}</span>
                      <div className="main-col">
                        <div className="title">{tr.traderLabel}</div>
                        <div className="meta">{fmtAgo(tr.time)}</div>
                      </div>
                      <span className="num">{tr.quote === 'SOL' ? fmtSol(tr.quoteAmount) : fmtUsd(tr.quoteAmount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="links" style={{ marginBottom: 8 }}>
              {t.links.website && (
                <a href={t.links.website} target="_blank" rel="noreferrer">
                  <Icon name="globe" size={13} /> Website
                </a>
              )}
              {t.links.twitter && (
                <a href={t.links.twitter} target="_blank" rel="noreferrer">
                  <Icon name="xlogo" size={12} /> X
                </a>
              )}
              {t.links.telegram && (
                <a href={t.links.telegram} target="_blank" rel="noreferrer">
                  <Icon name="send" size={13} /> Telegram
                </a>
              )}
              <a href={`https://x.com/search?q=${t.mint}&f=live`} target="_blank" rel="noreferrer">
                <Icon name="search" size={13} /> Live X posts
              </a>
              <a href={`https://dexscreener.com/solana/${t.pairAddress ?? t.mint}`} target="_blank" rel="noreferrer">
                DexScreener <Icon name="external" size={12} />
              </a>
              <a href={`https://birdeye.so/token/${t.mint}?chain=solana`} target="_blank" rel="noreferrer">
                Birdeye <Icon name="external" size={12} />
              </a>
              <a href={`https://gmgn.ai/sol/token/${t.mint}`} target="_blank" rel="noreferrer">
                GMGN <Icon name="external" size={12} />
              </a>
              <a href={`https://rugcheck.xyz/tokens/${t.mint}`} target="_blank" rel="noreferrer">
                RugCheck <Icon name="external" size={12} />
              </a>
              <a href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noreferrer">
                Solscan <Icon name="external" size={12} />
              </a>
              {t.launchpad === 'pump.fun' && (
                <a href={`https://pump.fun/coin/${t.mint}`} target="_blank" rel="noreferrer">
                  pump.fun <Icon name="external" size={12} />
                </a>
              )}
            </div>
          </div>
        )}
        {t && (
          <div className="drawer-actions">
            {(['buy', 'sell'] as const).map((side) => (
              <button
                key={side}
                className={`btn lg ${side}`}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('memeradar:trade-side', { detail: side }));
                  document.getElementById('trade-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {side === 'buy' ? `Buy ${t.symbol}` : `Sell ${t.symbol}`}
              </button>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}
