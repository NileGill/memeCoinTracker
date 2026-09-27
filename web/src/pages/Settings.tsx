import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { useTick } from '../components/common';
import { beep, requestDesktopPermission } from '../lib/alerts';
import { fmtAgo } from '../lib/format';
import { DEFAULT_SETTINGS, updateSettings, useStore, type Settings as S } from '../store';
import { PageTitle } from './shared';

function Toggle({ k, label, hint }: { k: keyof S; label: string; hint?: string }) {
  const v = useStore((s) => s.settings[k]) as boolean;
  return (
    <div className="setting">
      <div className="text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <button className={`toggle ${v ? 'on' : ''}`} onClick={() => updateSettings({ [k]: !v } as Partial<S>)} aria-label={label} />
    </div>
  );
}

function NumberSetting({ k, label, hint, min, max, step, suffix }: { k: keyof S; label: string; hint?: string; min: number; max: number; step: number; suffix?: ReactNode }) {
  const v = useStore((s) => s.settings[k]) as number;
  const [text, setText] = useState(String(v));
  useEffect(() => setText(String(v)), [v]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n >= min && n <= max) updateSettings({ [k]: n } as Partial<S>);
    else setText(String(v));
  };
  return (
    <div className="setting">
      <div className="text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        {suffix && <span className="muted" style={{ fontSize: 12.5, minWidth: 28 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Presets() {
  const presets = useStore((s) => s.settings.buyPresets);
  const [text, setText] = useState(presets.join(', '));
  useEffect(() => setText(presets.join(', ')), [presets]);
  const [err, setErr] = useState<string | null>(null);
  const commit = () => {
    const vals = text.split(/[,\s]+/).filter(Boolean).map(Number);
    if (vals.length !== 5 || vals.some((v) => !(v > 0) || v > 1000)) {
      setErr('Enter exactly 5 positive amounts, e.g. 0.05, 0.1, 0.25, 0.5, 1');
      return;
    }
    setErr(null);
    updateSettings({ buyPresets: vals });
  };
  return (
    <div className="setting" style={{ flexWrap: 'wrap' }}>
      <div className="text">
        <b>Quick-buy buttons</b>
        <span>Five SOL amounts shown under the buy box</span>
      </div>
      <input className="input" style={{ width: 220 }} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {err && <div className="down" style={{ width: '100%', fontSize: 12 }}>{err}</div>}
    </div>
  );
}

export function Settings() {
  useTick(10_000);
  const desktop = useStore((s) => s.settings.desktop);
  const status = useStore((s) => s.status);
  const [permMsg, setPermMsg] = useState<string | null>(null);

  return (
    <>
      <PageTitle title="Settings & alerts" sub="Alerts only fire while this site is open in a tab. Settings are saved in this browser.">
        <button
          className="btn sm"
          onClick={() => {
            if (confirm('Reset all settings to defaults?')) updateSettings(DEFAULT_SETTINGS);
          }}
        >
          Reset to defaults
        </button>
      </PageTitle>

      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>
              <Icon name="bell" size={15} /> What to alert on
            </h2>
          </div>
          <div className="panel-body">
            <Toggle k="alertSetups" label="New top setups" hint="A coin's score crosses your threshold" />
            <NumberSetting k="setupThreshold" label="Setup score threshold" hint="0-100, default 75" min={50} max={100} step={1} />
            <Toggle k="alertPumps" label="Sharp pumps" hint="A coin jumps fast with real volume behind it" />
            <NumberSetting k="pumpPct" label="Pump size (5 minutes)" min={5} max={500} step={1} suffix="%" />
            <Toggle k="alertVolume" label="Volume spikes" hint="5-minute volume running at 4x the hourly pace" />
            <NumberSetting k="minAlertLiquidity" label="Minimum liquidity for market alerts" hint="Filters out thin coins that pump on tiny volume" min={0} max={10_000_000} step={1000} suffix="USD" />
            <Toggle k="alertTraders" label="Watched trader trades" hint="Per-trader bells on the Traders page" />
            <NumberSetting k="traderMinSol" label="Minimum trader trade size" min={0} max={1000} step={0.1} suffix="SOL" />
            <Toggle k="alertConvergence" label="Traders converging" hint="2+ watched traders buy the same coin within an hour" />
            <Toggle k="alertWatchlist" label="Watchlist moves" hint="Starred coins moving fast, up or down" />
            <NumberSetting k="watchPct" label="Watchlist move size (5 minutes)" min={2} max={200} step={1} suffix="%" />
            <Toggle k="alertMigrations" label="Every pump.fun graduation" hint="Frequent: a new one every few minutes" />
            <Toggle k="alertNews" label="Breaking memecoin news" hint="Silent pop-up, no sound" />
          </div>
        </section>

        <div className="col" style={{ gap: 14 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>
                <Icon name="sound" size={15} /> How alerts reach you
              </h2>
            </div>
            <div className="panel-body">
              <div className="setting">
                <div className="text">
                  <b>Sound</b>
                  <span>Short chime for important alerts</span>
                </div>
                <button className="btn xs" onClick={() => beep('high')}>
                  Test
                </button>
                <SoundToggle />
              </div>
              <div className="setting">
                <div className="text">
                  <b>Desktop notifications</b>
                  <span>Pop up even when you're in another tab (while this site stays open)</span>
                </div>
                <button
                  className={`toggle ${desktop ? 'on' : ''}`}
                  aria-label="Desktop notifications"
                  onClick={async () => {
                    if (desktop) {
                      updateSettings({ desktop: false });
                      return;
                    }
                    const ok = await requestDesktopPermission();
                    if (ok) {
                      updateSettings({ desktop: true });
                      setPermMsg(null);
                    } else setPermMsg('Notifications are blocked for this site. Allow them in your browser\'s site settings.');
                  }}
                />
              </div>
              {permMsg && <div className="notice amber">{permMsg}</div>}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>
                <Icon name="wallet" size={15} /> Trading
              </h2>
            </div>
            <div className="panel-body">
              <NumberSetting k="maxTradeSol" label="Max trade size" hint="Buys above this are blocked, to prevent fat-finger mistakes" min={0.001} max={1000} step={0.1} suffix="SOL" />
              <Presets />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>
                <Icon name="bars" size={15} /> Data sources
              </h2>
            </div>
            <div className="panel-body">
              {status.map((s) => (
                <div key={s.id} className="setting" style={{ padding: '8px 0' }}>
                  <span className={`status-dot ${s.ok ? 'ok' : s.lastError ? 'error' : 'pending'}`} />
                  <div className="text">
                    <b style={{ fontSize: 13 }}>{s.label}</b>
                    <span>
                      {s.lastOk ? `OK ${fmtAgo(s.lastOk)}` : 'starting…'}
                      {s.lastError && s.lastErrorAt && (!s.lastOk || s.lastErrorAt > s.lastOk) ? ` · last error: ${s.lastError}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function SoundToggle() {
  const v = useStore((s) => s.settings.sound);
  return <button className={`toggle ${v ? 'on' : ''}`} aria-label="Sound" onClick={() => updateSettings({ sound: !v })} />;
}
