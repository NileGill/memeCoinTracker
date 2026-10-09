const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/** $0.0₅1234 style for tiny memecoin prices. */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(v >= 100 ? 2 : 3)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  const s = v.toFixed(20);
  const m = /^0\.(0+)(\d{4})/.exec(s);
  if (!m) return `$${v.toPrecision(4)}`;
  const zeros = m[1].length;
  if (zeros < 4) return `$${v.toFixed(zeros + 4)}`;
  const sub = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('');
  return `$0.0${sub}${m[2]}`;
}

export function fmtUsd(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = opts.sign && v > 0 ? '+' : v < 0 ? '-' : '';
  const a = Math.abs(v);
  let body: string;
  if (a >= 1e9) body = `${(a / 1e9).toFixed(2)}B`;
  else if (a >= 1e6) body = `${(a / 1e6).toFixed(2)}M`;
  else if (a >= 1e3) body = `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  else body = a.toFixed(a >= 100 ? 0 : 2);
  return `${sign}$${body}`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: digits });
  if (a === 0) return '0';
  return v.toPrecision(3);
}

export function fmtSol(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : a >= 0.0001 || a === 0 ? 4 : 6;
  return `${v.toFixed(d)} SOL`;
}

export function fmtPct(v: number | null | undefined, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = digits ?? (a >= 1000 ? 0 : a >= 100 ? 0 : a >= 10 ? 1 : 2);
  const s = a >= 10_000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(d);
  return `${v > 0 ? '+' : ''}${s}%`;
}

export function pctClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || Math.abs(v) < 0.005) return 'muted';
  return v > 0 ? 'up' : 'down';
}

export function fmtAge(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null) return 'never';
  const a = fmtAge(ms, now);
  return a === '—' ? a : `${a} ago`;
}

export function shortAddr(a: string, n = 4): string {
  return a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a;
}

/** Deterministic colour for fallback avatars. */
export function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 42%)`;
}

/** Parse a user-typed decimal string into integer base units without floating point error. */
export function toBaseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  const units = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return units;
}

/** Integer base units -> number for display. */
export function fromBaseUnits(raw: string | bigint, decimals: number): number {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = a % base;
  const n = Number(whole) + Number(frac) / Number(base);
  return neg ? -n : n;
}
