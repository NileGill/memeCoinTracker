import { useEffect, useMemo, useState } from 'react';
import type { MlModelInfo, MlStatus, PaperAccountView, PaperPosition, PaperSettings, PaperTrade, StrategyResult, TokenView } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { AiChip, Empty, Pct, TokenIcon, useTick } from '../components/common';
import { botApi } from '../lib/bot';
import { fmtAge, fmtAgo, fmtPct, fmtPrice, fmtSol, fmtUsd, pctClass } from '../lib/format';
import { openToken, useStore } from '../store';
import { PageTitle } from './shared';

// ---------------------------------------------------------------- small pieces

function Stat({ k, v, cls, hint }: { k: string; v: string; cls?: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="label">{k}</div>
      <div className={`value num ${cls ?? ''}`}>{v}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

const STATE_LABEL: Record<MlStatus['state'], { text: string; cls: string }> = {
  collecting: { text: 'Collecting data', cls: 'blue' },
  training: { text: 'Training', cls: 'accent' },
  ready: { text: 'Proven', cls: 'green' },
  unproven: { text: 'Not proven yet', cls: 'amber' },
};

const pct1 = (v: number) => `${Math.round(v * 1000) / 10}%`;
const fmtWhen = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

function until(t: number | null): string {
  if (!t) return '—';
  const m = Math.round((t - Date.now()) / 60_000);
  if (m <= 0) return 'any minute';
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)}h ${m % 60}m`;
}

function StrategyLine({ label, r }: { label: string; r: StrategyResult }) {
  return (
    <div className="bot-strategy">
      <b>{label}</b>
      <span>
        {r.trades} trades · won {pct1(r.winRate)} · average <span className={pctClass(r.avgReturn)}>{fmtPct(r.avgReturn)}</span> per trade after fees
        {r.profitFactor != null && ` · profit factor ${r.profitFactor}`}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- the model

function ModelPanel({ ml }: { ml: MlStatus | null }) {
  const [how, setHow] = useState(false);
  useTick(30_000);
  if (!ml) return null;
  const m = ml.model;
  const st = STATE_LABEL[ml.state];
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="sparkles" size={15} /> The AI model
        </h2>
        <span className={`badge ${st.cls}`}>{st.text}</span>
        <span className="spacer" />
        <button className="btn xs" onClick={() => setHow((h) => !h)}>
          {how ? 'Hide' : 'How it learns'}
        </button>
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        <div className={`notice ${ml.state === 'ready' ? 'green' : ml.state === 'unproven' ? 'amber' : ''}`}>{ml.message}</div>

        {how && (
          <div className="explain">
            <b>What it predicts.</b> For any coin at any moment: if you bought right now, would it hit a profit target
            (for example +30%) before a stop-loss (for example −15%) within an hour?
            <br />
            <b>What it learns from.</b> No free source has the full history of memecoin buyers, sellers, liquidity and
            holders, so MemeRadar records it: every coin it tracks is snapshotted when it appears and every 15 minutes
            after (price moves, volume, buy pressure, wallets, holders, liquidity, safety checks, launchpad, how the market
            is doing), and each snapshot's price is followed for an hour to see what actually happened. Coins that rug are
            followed to the end, so losses count.
            <br />
            <b>How it's judged.</b> Data is split by time. It learns on the oldest 70%, the next 15% picks its target and
            how picky to be, and the newest 15% is a test it never trained on. Test trades pay fees and slippage, and a stop
            fills at the price actually seen, which is often worse than the stop. It's only called <i>proven</i> (and only
            then does the bot follow it) when those test trades made money. It retrains every few hours as data grows.
            <br />
            <b>The crash filter.</b> A win-or-lose model can't tell a −15% stop from a rug that falls straight to zero, and rugs
            gap right through stop-losses. So a second model learns which coins crash 50%+ (or vanish) within the hour, and the bot
            skips coins it flags, even ones that look like winners. When two settings make about the same money, it picks the one that
            wins more often.
            <br />
            <b>What it can't do.</b> Nothing predicts memecoins reliably: insiders, bots and rugs dominate. Expect many
            losing trades even from a good model; the question is whether the winners pay for them.
          </div>
        )}

        <div className="kpis bot-kpis">
          <Stat k="Snapshots learned from" v={ml.samples.toLocaleString()} hint="outcome known" />
          <Stat k="Being followed" v={ml.pending.toLocaleString()} hint="waiting on their hour" />
          <Stat k="Saved in total" v={ml.stored != null ? ml.stored.toLocaleString() : '—'} hint="kept 14 days" />
          <Stat k="Data since" v={ml.dataFrom ? fmtAge(ml.dataFrom) : '—'} hint="span of history" />
          <Stat k="Last trained" v={ml.trainedAt ? fmtAgo(ml.trainedAt) : 'not yet'} />
          <Stat k="Next training" v={ml.state === 'training' ? 'now' : until(ml.nextTrainingAt)} />
        </div>

        {m && <ModelResults m={m} />}
      </div>
    </section>
  );
}

function ModelResults({ m }: { m: MlModelInfo }) {
  const maxImp = Math.max(...m.topFeatures.map((f) => f.importance), 0.001);
  return (
    <div className="bot-model">
      <div className="col" style={{ gap: 10, minWidth: 0 }}>
        <div className="dim" style={{ fontSize: 12.5 }}>
          Target it trades for: <b className="up">+{m.target.tp}%</b> take-profit, <b className="down">−{m.target.sl}%</b> stop-loss, sell after{' '}
          {m.target.holdMin} min. Tested on {fmtWhen(m.testFrom)} to {fmtWhen(m.testTo)} ({m.testRows.toLocaleString()} snapshots it never
          saw).
        </div>
        <StrategyLine label="AI model (test period)" r={m.test} />
        {m.scoreFiltered && (
          <StrategyLine label={`MemeRadar score ${m.scoreFiltered.threshold}+ with the crash filter (same period)`} r={m.scoreFiltered} />
        )}
        {m.baseline && <StrategyLine label={`Plain MemeRadar score ${m.baseline.threshold}+ (same period)`} r={m.baseline} />}
        {m.crash && (
          <div className="dim" style={{ fontSize: 12.5 }}>
            <b>Crash filter:</b> a second model rates each coin's chance of falling 50%+ (or vanishing) within the hour. In the test period{' '}
            {pct1(m.crash.rate)} of coins crashed, and its crash-spotting skill was {m.crash.auc.toFixed(2)} (0.5 is a coin flip).{' '}
            {m.crash.maxRisk != null
              ? `The bot skips any coin with more than a ${Math.round(m.crash.maxRisk * 100)}% crash chance.`
              : 'It did not improve results yet, so it is not filtering trades.'}
          </div>
        )}
        <div className="dim" style={{ fontSize: 12.5 }}>
          Ranking skill {m.auc.toFixed(2)} (0.5 is a coin flip; it can be high just from spotting which coins will move at all, so the trade results above are what count) · {pct1(m.baseRate)} of all test snapshots hit the target ·
          learned from {m.trainRows.toLocaleString()} snapshots of {m.tokens.toLocaleString()} coins
        </div>
        {m.problems.length > 0 && (
          <ul className="bot-problems">
            {m.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="col" style={{ gap: 6, minWidth: 0 }}>
        <div className="dim" style={{ fontSize: 12, fontWeight: 650 }}>
          What it pays most attention to
        </div>
        <div className="bars">
          {m.topFeatures.map((f) => (
            <div key={f.label} className="bar-row">
              <span className="muted truncate">{f.label}</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ left: 0, width: `${(f.importance / maxImp) * 100}%`, background: 'var(--accent-2)' }} />
              </div>
              <span className="num" style={{ textAlign: 'right' }}>
                {Math.round(f.importance * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- picks

function Picks({ ml }: { ml: MlStatus | null }) {
  const tokenList = useStore((s) => s.tokenList);
  const proven = ml?.model?.proven ?? false;
  const rows = useMemo(
    () =>
      tokenList
        .filter((t) => t.ai && (proven ? t.ai.pick : (t.liquidity ?? 0) >= 10_000))
        .sort((a, b) => (b.ai!.ev ?? -99) - (a.ai!.ev ?? -99) || b.ai!.win - a.ai!.win)
        .slice(0, 10),
    [tokenList, proven],
  );
  if (!ml?.model) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="target" size={15} /> {proven ? 'AI picks right now' : 'Highest rated right now'}
        </h2>
        <span className="sub">{proven ? 'coins the bot would buy' : 'unproven model: for information only'}</span>
      </div>
      <div className="feed">
        {rows.map((t) => (
          <PickRow key={t.mint} t={t} />
        ))}
        {!rows.length && <Empty>{proven ? 'Nothing clears the bar right now. The bot waits for strong setups.' : 'No rated coins yet.'}</Empty>}
      </div>
    </section>
  );
}

function PickRow({ t }: { t: TokenView }) {
  return (
    <div className="feed-item" onClick={() => openToken(t.mint)}>
      <TokenIcon src={t.icon} symbol={t.symbol} />
      <div className="main-col">
        <div className="title">
          <span className="truncate">{t.symbol}</span>
          {t.ai?.pick && <span className="badge green">pick</span>}
        </div>
        <div className="meta truncate">
          {fmtUsd(t.mcap)} mcap · liq {fmtUsd(t.liquidity)} · 5m <Pct v={t.change.m5} />
        </div>
      </div>
      <AiChip t={t} />
    </div>
  );
}

// ---------------------------------------------------------------- the paper bot

function useAccount() {
  const auth = useStore((s) => s.auth.status);
  const bot = useStore((s) => s.bot);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (auth !== 'user') return;
    botApi.load().catch((e) => setError((e as Error).message));
    // Refresh the full history occasionally; live changes arrive over the stream.
    const id = setInterval(() => botApi.load().catch(() => undefined), 60_000);
    return () => clearInterval(id);
  }, [auth]);
  return { auth, bot, error };
}

function PaperBot() {
  const { auth, bot, error } = useAccount();
  if (auth === 'loading') return null;
  if (auth === 'disabled')
    return (
      <section className="panel">
        <div className="panel-body">
          <Empty>Accounts are switched off on this server, so the paper bot isn't available.</Empty>
        </div>
      </section>
    );
  if (auth === 'guest')
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>
            <Icon name="bot" size={15} /> Paper trading bot
          </h2>
        </div>
        <div className="panel-body col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div>
            Give the bot fake SOL and it trades the live market around the clock, even with this site closed, so you can see
            how the strategy really does before risking anything. Your bot is tied to your account.
          </div>
          <button className="btn primary" onClick={() => useStore.setState({ authModal: 'login' })}>
            Log in to start a paper bot
          </button>
        </div>
      </section>
    );
  if (bot === undefined) return <section className="panel"><div className="panel-body"><Empty>{error ?? 'Loading your bot…'}</Empty></div></section>;
  if (bot === null) return <StartForm />;
  return <BotDashboard a={bot} />;
}

const DEFAULTS: PaperSettings = { sizePct: 10, maxOpen: 5, mode: 'auto', scoreMin: 75, minLiquidity: 20_000, paused: false };

function SettingsFields({ s, onChange }: { s: PaperSettings; onChange: (s: PaperSettings) => void }) {
  const num = (key: keyof PaperSettings, label: string, hint: string, min: number, max: number, step: number, suffix: string) => (
    <label className="field">
      {label}
      <span className="row" style={{ gap: 6 }}>
        <input
          className="input num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={s[key] as number}
          onChange={(e) => onChange({ ...s, [key]: Number(e.target.value) })}
        />
        <span className="muted">{suffix}</span>
      </span>
      <span className="dim" style={{ fontWeight: 400 }}>
        {hint}
      </span>
    </label>
  );
  return (
    <div className="bot-settings">
      {num('sizePct', 'Trade size', 'Share of the bot’s balance per trade', 1, 50, 1, '%')}
      {num('maxOpen', 'Open trades at once', 'Spreads risk across coins', 1, 20, 1, 'max')}
      {num('minLiquidity', 'Minimum liquidity', 'Skip coins thinner than this', 10_000, 5_000_000, 5_000, 'USD')}
      {num('scoreMin', 'Score needed (before the model is proven)', 'MemeRadar score the bot buys at meanwhile', 60, 95, 1, '/100')}
      <label className="field">
        Strategy
        <span className="seg">
          <button type="button" className={s.mode === 'auto' ? 'on' : ''} onClick={() => onChange({ ...s, mode: 'auto' })}>
            Score now, AI when proven
          </button>
          <button type="button" className={s.mode === 'model' ? 'on' : ''} onClick={() => onChange({ ...s, mode: 'model' })}>
            AI only
          </button>
        </span>
        <span className="dim" style={{ fontWeight: 400 }}>
          {s.mode === 'auto'
            ? 'Starts trading right away on the MemeRadar score and switches to the AI once it proves itself.'
            : 'Waits and trades nothing until the AI model passes its test.'}
        </span>
      </label>
    </div>
  );
}

function StartForm({ restart, onDone }: { restart?: PaperAccountView; onDone?: () => void }) {
  const [balance, setBalance] = useState(String(restart?.startBalance ?? 10));
  const [s, setS] = useState<PaperSettings>(restart?.settings ?? DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    const b = Number(balance);
    if (!(b >= 0.1 && b <= 10_000)) return setErr('Starting balance must be between 0.1 and 10,000 SOL.');
    if (restart && !confirm('Start over? This wipes the current paper bot, its open trades and its history.')) return;
    setBusy(true);
    setErr(null);
    try {
      await botApi.start(b, { ...s, paused: false });
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="bot" size={15} /> {restart ? 'Start over' : 'Start a paper trading bot'}
        </h2>
        <span className="sub">fake money, real live prices</span>
      </div>
      <div className="panel-body col" style={{ gap: 14 }}>
        <label className="field" style={{ maxWidth: 260 }}>
          Fake SOL to start with
          <span className="row" style={{ gap: 6 }}>
            <input className="input num" type="number" min={0.1} max={10000} step={0.1} value={balance} onChange={(e) => setBalance(e.target.value)} />
            <span className="muted">SOL</span>
          </span>
        </label>
        <SettingsFields s={s} onChange={setS} />
        {err && <div className="notice red">{err}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" disabled={busy} onClick={start}>
            {busy ? 'Starting…' : restart ? 'Wipe and start over' : 'Start paper trading'}
          </button>
          {restart && (
            <button className="btn" onClick={onDone}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function EquityChart({ a }: { a: PaperAccountView }) {
  const pts = [...a.curve, [Date.now(), a.equity] as [number, number]];
  if (pts.length < 2) return null;
  const W = 600;
  const H = 150;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const vals = pts.map((p) => p[1]).concat(a.startBalance);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || a.startBalance * 0.02 || 1;
  const y = (v: number) => H - 4 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 8);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const line = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = a.equity >= a.startBalance;
  return (
    <svg className="bot-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Paper bot balance over time">
      <line x1={0} x2={W} y1={y(a.startBalance)} y2={y(a.startBalance)} stroke="var(--border-2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <polyline points={line} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function PositionRow({ p }: { p: PaperPosition }) {
  const live = useStore((s) => s.tokens[p.mint]?.priceUsd);
  const solPrice = useStore((s) => s.solPrice);
  const [busy, setBusy] = useState(false);
  const price = live ?? p.lastPrice;
  const move = (price / p.entryPrice - 1) * 100;
  const value = solPrice ? (p.qty * price) / solPrice : null;
  const left = Math.max(0, p.closeBy - Date.now());
  return (
    <div className="feed-item" onClick={() => openToken(p.mint)}>
      <TokenIcon src={p.icon} symbol={p.symbol} />
      <div className="main-col">
        <div className="title">
          <span className="truncate">{p.symbol}</span>
          <span className={`badge ${p.strategy === 'model' ? 'accent' : ''}`}>{p.strategy === 'model' ? 'AI' : `score ${p.signal}`}</span>
        </div>
        <div className="meta truncate">
          in at {fmtPrice(p.entryPrice)} · {fmtSol(p.costSol)} · +{p.target.tp}% / −{p.target.sl}% · sells in {Math.ceil(left / 60_000)}m
        </div>
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
        <div>
          <Pct v={move} />
        </div>
        <div className="dim">{value != null ? `≈ ${fmtSol(value)}` : '—'}</div>
      </div>
      <button
        className="btn xs"
        disabled={busy}
        onClick={async (e) => {
          e.stopPropagation();
          setBusy(true);
          await botApi.close(p.id).catch((err) => alert((err as Error).message));
          setBusy(false);
        }}
      >
        Sell
      </button>
    </div>
  );
}

const REASON: Record<PaperTrade['reason'], string> = {
  tp: 'target hit',
  sl: 'stop hit',
  time: 'time limit',
  manual: 'sold by you',
  gone: 'rugged / no price',
  reset: 'reset',
};

function TradeRow({ t }: { t: PaperTrade }) {
  return (
    <div className="feed-item" onClick={() => openToken(t.mint)}>
      <TokenIcon src={t.icon} symbol={t.symbol} size="sm" />
      <div className="main-col">
        <div className="title">
          <span className="truncate">{t.symbol}</span>
          <span className={`badge ${t.reason === 'tp' ? 'green' : t.reason === 'sl' || t.reason === 'gone' ? 'red' : ''}`}>{REASON[t.reason]}</span>
        </div>
        <div className="meta truncate">
          {fmtAgo(t.closedAt)} · held {fmtAge(t.openedAt, t.closedAt)} · {t.strategy === 'model' ? 'AI pick' : `score ${t.signal}`}
        </div>
      </div>
      <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
        <div>
          <Pct v={t.pnlPct} />
        </div>
        <div className={pctClass(t.pnlSol)}>
          {t.pnlSol > 0 ? '+' : ''}
          {fmtSol(t.pnlSol)}
        </div>
      </div>
    </div>
  );
}

function BotDashboard({ a }: { a: PaperAccountView }) {
  useTick(10_000);
  const solPrice = useStore((s) => s.solPrice);
  const [edit, setEdit] = useState<PaperSettings | null>(null);
  const [restart, setRestart] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const s = a.stats;
  if (restart) return <StartForm restart={a} onDone={() => setRestart(false)} />;

  const save = async (settings: Partial<PaperSettings>) => {
    try {
      await botApi.settings(settings);
      setEdit(null);
      setMsg(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>
            <Icon name="bot" size={15} /> Your paper trading bot
          </h2>
          <span className="badge">fake money</span>
          <span className="spacer" />
          <button className="btn xs" onClick={() => save({ paused: !a.settings.paused })}>
            <Icon name={a.settings.paused ? 'play' : 'pause'} size={13} /> {a.settings.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div className="panel-body col" style={{ gap: 12 }}>
          <div className={`notice ${a.settings.paused ? 'amber' : ''}`}>{a.activity}</div>
          <div className="kpis bot-kpis">
            <Stat k="Balance" v={fmtSol(a.equity)} hint={solPrice ? `≈ ${fmtUsd(a.equity * solPrice)} · started ${fmtSol(a.startBalance)}` : `started ${fmtSol(a.startBalance)}`} />
            <Stat k="Profit / loss" v={`${s.pnlSol >= 0 ? '+' : ''}${fmtSol(s.pnlSol)}`} cls={pctClass(s.pnlSol)} hint={fmtPct(s.pnlPct)} />
            <Stat k="Win rate" v={s.winRate != null ? `${Math.round(s.winRate * 100)}%` : '—'} hint={`${s.wins} of ${s.closed} trades`} />
            <Stat k="Average trade" v={s.avgTradePct != null ? fmtPct(s.avgTradePct) : '—'} cls={pctClass(s.avgTradePct)} hint="after fees" />
            <Stat k="Profit factor" v={s.profitFactor != null ? s.profitFactor.toFixed(2) : '—'} hint="won ÷ lost (over 1 = profit)" />
            <Stat k="Worst drawdown" v={`${s.maxDrawdownPct}%`} hint={`fees paid ${fmtSol(s.feesSol)}`} />
          </div>
          <EquityChart a={a} />
          <div className="dim" style={{ fontSize: 12 }}>
            Running since {fmtWhen(a.createdAt)}. Cash {fmtSol(a.cash)}. Every fill pays a 1% fee, slippage based on the coin's liquidity
            and a network fee; stops fill at the price actually seen.
          </div>
        </div>
      </section>

      <div className="grid bot-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>
              <Icon name="zap" size={15} /> Open trades
            </h2>
            <span className="sub">
              {a.positions.length} of {a.settings.maxOpen}
            </span>
          </div>
          <div className="feed">
            {a.positions.map((p) => (
              <PositionRow key={p.id} p={p} />
            ))}
            {!a.positions.length && <Empty>No open trades. The bot buys when a coin clears its bar.</Empty>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>
              <Icon name="clock" size={15} /> Closed trades
            </h2>
            <span className="sub">{s.closed} total</span>
          </div>
          <div className="feed" style={{ maxHeight: 520, overflowY: 'auto' }}>
            {(showAll ? a.trades : a.trades.slice(0, 25)).map((t) => (
              <TradeRow key={t.id} t={t} />
            ))}
            {!a.trades.length && <Empty>No finished trades yet.</Empty>}
            {!showAll && a.trades.length > 25 && (
              <div style={{ padding: 10, textAlign: 'center' }}>
                <button className="btn sm" onClick={() => setShowAll(true)}>
                  Show all {a.trades.length}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>
            <Icon name="settings" size={15} /> Bot settings
          </h2>
          <span className="spacer" />
          {!edit && (
            <button className="btn xs" onClick={() => setEdit(a.settings)}>
              Change
            </button>
          )}
        </div>
        <div className="panel-body col" style={{ gap: 12 }}>
          {edit ? (
            <>
              <SettingsFields s={edit} onChange={setEdit} />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => save(edit)}>
                  Save
                </button>
                <button className="btn" onClick={() => setEdit(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="dim">
              {a.settings.sizePct}% of the balance per trade · up to {a.settings.maxOpen} at once · coins with {fmtUsd(a.settings.minLiquidity)}+
              liquidity · {a.settings.mode === 'auto' ? `score ${a.settings.scoreMin}+ until the AI is proven, then the AI` : 'AI picks only'}
            </div>
          )}
          {msg && <div className="notice red">{msg}</div>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => setRestart(true)}>
              Start over with a new balance
            </button>
            <button
              className="btn sm danger"
              onClick={async () => {
                if (!confirm('Delete your paper bot and its whole history?')) return;
                await botApi.remove().catch((e) => setMsg((e as Error).message));
              }}
            >
              Delete bot
            </button>
          </div>
        </div>
      </section>

      <Readiness a={a} />
    </>
  );
}

function Readiness({ a }: { a: PaperAccountView }) {
  const passed = a.readiness.filter((r) => r.ok).length;
  const all = passed === a.readiness.length;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="lock" size={15} /> Real-money trading
        </h2>
        <span className={`badge ${all ? 'green' : ''}`}>
          {passed}/{a.readiness.length} checks passed
        </span>
      </div>
      <div className="panel-body col" style={{ gap: 10 }}>
        <div className="dim">
          Real trades stay locked until the paper bot has shown it makes money on the live market. Until then, you can still trade
          yourself from any coin's page with Phantom.
        </div>
        <div className="bot-checks">
          {a.readiness.map((r) => (
            <div key={r.label} className={`bot-check ${r.ok ? 'ok' : ''}`}>
              <Icon name={r.ok ? 'check' : 'x'} size={14} strokeWidth={3} />
              <span>{r.label}</span>
              <span className="dim">{r.detail}</span>
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12.5 }}>
          Phantom asks you to approve every transaction, so a bot can't trade your main wallet while you're away. When all checks pass,
          automatic trading would use a separate wallet made just for the bot (you can add it to Phantom to watch it), holding only what
          you're prepared to lose, with hard limits per trade and per day.
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- page

export function Bot() {
  const ml = useStore((s) => s.ml);
  return (
    <>
      <PageTitle
        title="AI trading bot"
        sub="A model that learns from live market data, and a bot that trades fake SOL with it until it proves it can make money."
      />
      <div className="col" style={{ gap: 14 }}>
        <ModelPanel ml={ml} />
        <PaperBot />
        <Picks ml={ml} />
        <p className="dim" style={{ fontSize: 11.5, margin: 0 }}>
          Not financial advice. Past results, paper or tested, don't guarantee future ones; memecoins can go to zero in minutes.
        </p>
      </div>
    </>
  );
}
