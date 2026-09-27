import { useMemo, useState } from 'react';
import { TokenTable } from '../components/TokenTable';
import { updateSettings, useStore } from '../store';
import { PageTitle, selectSetups } from './shared';

const AGE_OPTIONS = [
  { label: 'Any age', ms: Infinity },
  { label: '< 1 hour', ms: 3_600_000 },
  { label: '< 6 hours', ms: 6 * 3_600_000 },
  { label: '< 24 hours', ms: 86_400_000 },
  { label: '< 7 days', ms: 7 * 86_400_000 },
];

export function Setups() {
  const tokenList = useStore((s) => s.tokenList);
  const settings = useStore((s) => s.settings);
  const hasSnapshot = useStore((s) => s.hasSnapshot);
  const [maxAge, setMaxAge] = useState(Infinity);
  const [explain, setExplain] = useState(false);

  const rows = useMemo(() => {
    const now = Date.now();
    return selectSetups(tokenList, settings).filter((t) => maxAge === Infinity || (t.createdAt != null && now - t.createdAt <= maxAge));
  }, [tokenList, settings, maxAge]);

  return (
    <>
      <PageTitle
        title="Best trades right now"
        sub="Solana memecoins ranked live by momentum, buy pressure, volume pace, participation and safety."
      >
        <button className="btn sm" onClick={() => setExplain((e) => !e)}>
          {explain ? 'Hide' : 'How the score works'}
        </button>
      </PageTitle>

      {explain && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-body explain">
            Every tracked coin with at least $8K liquidity and $2K hourly volume gets a score from 0 to 100, recalculated
            every few seconds. <b>50 is neutral</b>, and <b>75+ means everything is pointing up at once</b>. The score adds
            up five signals:
            <br />
            <b>Momentum</b>: price change over 5 minutes and 1 hour, damped so one spike can't dominate. <b>Buy pressure</b>:
            buy volume vs sell volume. <b>Volume pace</b>: is the last 5 minutes busier than the hourly average?{' '}
            <b>Participation</b>: number of wallets trading, net new buyers and holder growth. <b>Quality</b>: liquidity
            depth, organic (non-bot) activity, revoked mint/freeze authority and holder distribution.
            <br />
            Moves on thin volume count for less. Points come off for risk: active freeze or mint authority, dumping,
            parabolic runs, bot volume, concentrated holders, copycat tickers and brand-new launches. It measures what is
            happening now, not what will happen next. Memecoins can go to zero in minutes, so size trades accordingly.
          </div>
        </div>
      )}

      <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          Min liquidity
          <select
            className="input"
            style={{ width: 'auto' }}
            value={settings.setupsMinLiquidity}
            onChange={(e) => updateSettings({ setupsMinLiquidity: Number(e.target.value) })}
          >
            {[10_000, 25_000, 50_000, 100_000, 250_000].map((v) => (
              <option key={v} value={v}>
                ${v / 1000}K+
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          Age
          <select className="input" style={{ width: 'auto' }} value={String(maxAge)} onChange={(e) => setMaxAge(Number(e.target.value))}>
            {AGE_OPTIONS.map((o) => (
              <option key={o.label} value={String(o.ms)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="row" style={{ gap: 8, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
          <button
            className={`toggle ${settings.hideRisky ? 'on' : ''}`}
            onClick={() => updateSettings({ hideRisky: !settings.hideRisky })}
            aria-label="Hide risky coins"
          />
          Hide risky coins (authorities on, bots, copycats, dumping)
        </label>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 13 }}>
          {rows.length} coins
        </span>
      </div>

      <div className="panel">
        <TokenTable
          tokens={rows}
          presorted
          columns={['rank', 'token', 'score', 'price', 'm5', 'h1', 'h24', 'vol1h', 'liq', 'mcap', 'age', 'pressure', 'flags', 'spark', 'actions']}
          empty={hasSnapshot ? 'Nothing passes these filters right now. Try a lower liquidity minimum.' : 'Loading live market…'}
        />
      </div>
    </>
  );
}
