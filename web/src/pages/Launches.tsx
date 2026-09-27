import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Empty, useTick } from '../components/common';
import { useStore } from '../store';
import { LaunchRow, MigrationRow, PageTitle } from './shared';

export function Launches() {
  useTick(3000);
  const launches = useStore((s) => s.launches);
  const migrations = useStore((s) => s.migrations);
  const [tractionOnly, setTractionOnly] = useState(false);
  const rows = tractionOnly ? launches.filter((l) => l.traction) : launches;

  return (
    <>
      <PageTitle
        title="New launches"
        sub="Every new pump.fun coin the second it's created, plus other launchpads via Jupiter. Most new coins go to zero; coins marked traction have $25K+ market cap and real buying."
      />
      <div className="grid dash">
        <section className="panel span-7">
          <div className="panel-head">
            <h2>
              <Icon name="rocket" size={15} /> Live launch feed
            </h2>
            <span className="sub">{launches.length} recent</span>
            <label className="row" style={{ marginLeft: 'auto', gap: 8, fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }}>
              <button className={`toggle ${tractionOnly ? 'on' : ''}`} onClick={() => setTractionOnly((v) => !v)} aria-label="Traction only" />
              Traction only
            </label>
          </div>
          <div className="feed">
            {rows.map((l, i) => (
              <LaunchRow key={l.mint} l={l} fresh={i < 3 && Date.now() - l.time < 5_000} />
            ))}
            {!rows.length && <Empty>{tractionOnly ? 'No launches with traction yet. Give it a few minutes.' : 'Waiting for launches…'}</Empty>}
          </div>
        </section>
        <section className="panel span-5">
          <div className="panel-head">
            <h2>
              <Icon name="grad" size={15} /> Graduations
            </h2>
            <span className="sub">bonding curve completed, now on a DEX</span>
          </div>
          <div className="feed">
            {migrations.map((m) => (
              <MigrationRow key={m.mint} m={m} />
            ))}
            {!migrations.length && <Empty>No graduations yet this session.</Empty>}
          </div>
        </section>
      </div>
    </>
  );
}
