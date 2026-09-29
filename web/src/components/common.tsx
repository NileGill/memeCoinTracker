import { useEffect, useState, type ReactNode } from 'react';
import type { TokenFlag, TokenView } from '../../../shared/types';
import { api } from '../lib/api';
import { fmtPct, hashColor, pctClass } from '../lib/format';
import { priceHistory, toggleWatch, useStore } from '../store';
import { Icon } from './Icon';

/** Shows initials immediately and fades the real image in once it loads (many icons live on slow IPFS gateways). */
export function TokenIcon({ src, symbol, size = 'md' }: { src: string | null | undefined; symbol: string; size?: 'sm' | 'md' | 'lg' }) {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  useEffect(() => setState('loading'), [src]);
  return (
    <span className={`ticon-wrap ${size}`}>
      <span className="ticon fallback" style={{ background: hashColor(symbol) }}>
        {symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
      </span>
      {src && state !== 'failed' && (
        <img
          className={`ticon ${state === 'ok' ? 'loaded' : ''}`}
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setState('ok')}
          onError={() => setState('failed')}
        />
      )}
    </span>
  );
}

export function TokenCell({ t, sub }: { t: Pick<TokenView, 'symbol' | 'name' | 'icon' | 'mint' | 'verified'>; sub?: ReactNode }) {
  return (
    <div className="token-cell">
      <TokenIcon src={t.icon} symbol={t.symbol} />
      <div className="names">
        <div className="sym">
          <span className="truncate" style={{ maxWidth: 130 }}>
            {t.symbol}
          </span>
          {t.verified && (
            <span title="Verified by Jupiter" className="up" style={{ display: 'inline-flex' }}>
              <Icon name="check" size={13} strokeWidth={3} />
            </span>
          )}
        </div>
        <div className="nm">{sub ?? t.name}</div>
      </div>
    </div>
  );
}

export function Pct({ v, digits }: { v: number | null | undefined; digits?: number }) {
  return <span className={`num ${pctClass(v)}`}>{fmtPct(v, digits)}</span>;
}

export function scoreClass(score: number | null) {
  if (score == null) return '';
  if (score >= 75) return 'hot';
  if (score >= 60) return 'good';
  if (score < 40) return 'weak';
  return '';
}

export function ScoreBadge({ t }: { t: TokenView }) {
  if (t.score == null) return <span className="score" title="Not enough liquidity or volume to score">—</span>;
  const p = t.scoreParts;
  return (
    <span className="tip" onClick={(e) => e.stopPropagation()}>
      <span className={`score ${scoreClass(t.score)}`}>{t.score}</span>
      {p && (
        <span className="tip-box">
          <b>Score {t.score}/100</b>
          <div className="bars" style={{ marginTop: 8 }}>
            <ScoreBar label="Momentum" v={p.momentum} signed />
            <ScoreBar label="Buy pressure" v={p.flow} signed />
            <ScoreBar label="Volume pace" v={p.acceleration} signed />
            <ScoreBar label="Participation" v={p.participation} />
            <ScoreBar label="Quality" v={p.quality} />
          </div>
          {p.penalty > 0 && <div className="warn" style={{ marginTop: 6 }}>−{p.penalty} for risk flags</div>}
        </span>
      )}
    </span>
  );
}

export function ScoreBar({ label, v, signed }: { label: string; v: number; signed?: boolean }) {
  const pctW = signed ? Math.abs(v) * 50 : v * 100;
  const left = signed ? (v >= 0 ? 50 : 50 - pctW) : 0;
  const color = signed ? (v >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--accent-2)';
  return (
    <div className="bar-row">
      <span className="muted">{label}</span>
      <div className="bar-track">
        {signed && <div className="mid" />}
        <div className="bar-fill" style={{ left: `${left}%`, width: `${pctW}%`, background: color }} />
      </div>
      <span className="num" style={{ textAlign: 'right' }}>
        {signed && v > 0 ? '+' : ''}
        {v.toFixed(2)}
      </span>
    </div>
  );
}

export function FlagIcons({ flags, hideEmpty = false }: { flags: TokenFlag[]; hideEmpty?: boolean }) {
  const shown = flags.filter((f) => f.severity !== 'info' || f.code === 'new' || f.code === 'boosted').slice(0, 4);
  if (!shown.length) return hideEmpty ? null : <span className="dim">—</span>;
  return (
    <span className="flags">
      {shown.map((f) => (
        <span key={f.code} className={`flag-dot ${f.severity}`} title={f.label}>
          <Icon
            name={f.severity === 'danger' ? 'shield' : f.code === 'new' ? 'clock' : f.code === 'boosted' ? 'zap' : 'alert'}
            size={12}
            strokeWidth={2.4}
          />
        </span>
      ))}
    </span>
  );
}

export function Pressure({ buy, sell }: { buy: number | null | undefined; sell: number | null | undefined }) {
  if (buy == null || sell == null || buy + sell === 0) return <span className="dim">—</span>;
  const pct = (buy / (buy + sell)) * 100;
  return (
    <span className="pressure" title={`${pct.toFixed(0)}% buys`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Sparkline({ mint, width = 72, height = 24 }: { mint: string; width?: number; height?: number }) {
  const h = priceHistory.get(mint);
  if (!h || h.length < 2) return <svg className="spark" width={width} height={height} />;
  const min = Math.min(...h);
  const max = Math.max(...h);
  const range = max - min || max || 1;
  const pts = h
    .map((v, i) => `${((i / (h.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`)
    .join(' ');
  const up = h[h.length - 1] >= h[0];
  return (
    <svg className="spark" width={width} height={height}>
      <polyline points={pts} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function StarButton({ mint, size = 16 }: { mint: string; size?: number }) {
  const on = useStore((s) => s.watchlist.includes(mint));
  return (
    <button
      className={`star ${on ? 'on' : ''}`}
      title={on ? 'Remove from watchlist' : 'Add to watchlist (saved in this browser)'}
      onClick={(e) => {
        e.stopPropagation();
        const next = toggleWatch(mint);
        if (!on) api.watching(next).catch(() => undefined);
      }}
    >
      <Icon name="star" size={size} className={on ? 'filled-star' : ''} />
    </button>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost xs"
      title="Copy"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={13} />
      {label}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Re-render every `ms` so relative times ("12s ago") stay current. */
export function useTick(ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** The AI model's rating: how often similar setups hit the profit target first in testing. */
export function AiChip({ t }: { t: TokenView }) {
  if (!t.ai) return null;
  const { win, ev, pick, risk } = t.ai;
  return (
    <span
      className={`ai-chip ${pick ? 'pick' : ev != null && ev > 0 ? 'good' : ''}`}
      title={`In testing, ${Math.round(win * 100)}% of similar setups hit the profit target before the stop${ev != null ? `; they averaged ${fmtPct(ev)} after fees` : ''}.${risk != null ? ` Crash chance (50%+ drop within the hour): ${Math.round(risk * 100)}%.` : ''}${pick ? ' The bot would buy this.' : ''}`}
    >
      {Math.round(win * 100)}%{ev != null && <small className={pctClass(ev)}>{fmtPct(ev, 1)}</small>}
    </span>
  );
}
