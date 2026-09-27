import { useMemo } from 'react';
import { AlertList } from '../components/Header';
import { Icon } from '../components/Icon';
import { Empty, useTick } from '../components/common';
import { fmtPrice } from '../lib/format';
import { useStore } from '../store';
import { LaunchRow, MigrationRow, NewsRow, selectSetups, SetupRow, TraderTradeRow } from './shared';

export function Dashboard() {
  useTick(5000);
  const tokenList = useStore((s) => s.tokenList);
  const settings = useStore((s) => s.settings);
  const solPrice = useStore((s) => s.solPrice);
  const launches = useStore((s) => s.launches);
  const migrations = useStore((s) => s.migrations);
  const news = useStore((s) => s.news);
  const trades = useStore((s) => s.traderTrades);
  const traders = useStore((s) => s.traders);
  const launchesLastHour = useStore((s) => s.launchesLastHour);
  const graduationsLastHour = useStore((s) => s.graduationsLastHour);
  const hasSnapshot = useStore((s) => s.hasSnapshot);

  const setups = useMemo(() => selectSetups(tokenList, settings), [tokenList, settings]);
  const hot = setups.filter((t) => (t.score ?? 0) >= settings.setupThreshold).length;
  const memeNews = news.filter((n) => n.meme);
  const liveTrades = trades.filter((t) => !t.backfill || Date.now() - t.time < 86_400_000);
  const activeTraders = traders.filter((t) => t.today.buys + t.today.sells > 0).length;

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="label">SOL</div>
          <div className="value num">{fmtPrice(solPrice)}</div>
          <div className="hint">live via Jupiter</div>
        </div>
        <div className="kpi">
          <div className="label">Hot setups</div>
          <div className="value num up">{hasSnapshot ? hot : '…'}</div>
          <div className="hint">score ≥ {settings.setupThreshold}</div>
        </div>
        <div className="kpi">
          <div className="label">Coins tracked</div>
          <div className="value num">{hasSnapshot ? tokenList.length : '…'}</div>
          <div className="hint">refreshed every ~6s</div>
        </div>
        <div className="kpi">
          <div className="label">Launches</div>
          <div className="value num">{launchesLastHour}</div>
          <div className="hint">pump.fun, last hour*</div>
        </div>
        <div className="kpi">
          <div className="label">Graduations</div>
          <div className="value num">{graduationsLastHour}</div>
          <div className="hint">last hour*</div>
        </div>
        <div className="kpi">
          <div className="label">Traders active</div>
          <div className="value num">
            {activeTraders}/{traders.length}
          </div>
          <div className="hint">traded today</div>
        </div>
      </div>

      <div className="grid dash">
        <section className="panel span-7">
          <div className="panel-head">
            <h2>
              <Icon name="target" size={15} /> Best setups right now
            </h2>
            <span className="sub">momentum + buy pressure + safety</span>
            <a className="more" href="#/setups">
              All setups →
            </a>
          </div>
          <div className="feed">
            {setups.slice(0, 9).map((t) => (
              <SetupRow key={t.mint} t={t} />
            ))}
            {!setups.length && <Empty>{hasSnapshot ? 'No coins pass the filters right now. Check back in a minute.' : 'Loading live market…'}</Empty>}
          </div>
        </section>

        <section className="panel span-5">
          <div className="panel-head">
            <h2>
              <Icon name="bell" size={15} /> Live alerts
            </h2>
            <a className="more" href="#/settings">
              Alert settings →
            </a>
          </div>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            <AlertList limit={15} />
          </div>
        </section>

        <section className="panel span-4">
          <div className="panel-head">
            <h2>
              <Icon name="rocket" size={15} /> Fresh launches
            </h2>
            <a className="more" href="#/launches">
              All →
            </a>
          </div>
          <div className="feed">
            {launches.slice(0, 8).map((l, i) => (
              <LaunchRow key={l.mint} l={l} fresh={i === 0 && Date.now() - l.time < 5_000} />
            ))}
            {!launches.length && <Empty>Waiting for the next launch…</Empty>}
          </div>
        </section>

        <section className="panel span-4">
          <div className="panel-head">
            <h2>
              <Icon name="users" size={15} /> Top trader moves
            </h2>
            <a className="more" href="#/traders">
              Traders →
            </a>
          </div>
          <div className="feed">
            {liveTrades.slice(0, 8).map((t) => (
              <TraderTradeRow key={t.id} tr={t} />
            ))}
            {!liveTrades.length && (
              <Empty>
                {traders.length ? 'Watching wallets. Their next buys and sells will show up here.' : 'Add traders to watch on the Traders page.'}
              </Empty>
            )}
          </div>
        </section>

        <section className="panel span-4">
          <div className="panel-head">
            <h2>
              <Icon name="grad" size={15} /> Just graduated
            </h2>
            <span className="sub">left the pump.fun curve</span>
          </div>
          <div className="feed">
            {migrations.slice(0, 8).map((m) => (
              <MigrationRow key={m.mint} m={m} />
            ))}
            {!migrations.length && <Empty>No graduations yet this session.</Empty>}
          </div>
        </section>

        <section className="panel span-12">
          <div className="panel-head">
            <h2>
              <Icon name="news" size={15} /> Memecoin news
            </h2>
            <a className="more" href="#/news">
              All news →
            </a>
          </div>
          <div className="feed" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {memeNews.slice(0, 9).map((n) => (
              <NewsRow key={n.id} n={n} compact />
            ))}
            {!memeNews.length && <Empty>Loading news…</Empty>}
          </div>
        </section>
      </div>
      <p className="dim" style={{ fontSize: 11.5, marginTop: 12 }}>
        * Counted since the server last started (it restarts when a new version is deployed).
      </p>
    </>
  );
}
