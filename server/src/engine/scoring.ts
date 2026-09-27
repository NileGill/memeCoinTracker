import type { ScoreParts, TokenFlag, TokenView } from '../../../shared/types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;

type Input = Omit<TokenView, 'score' | 'scoreParts' | 'flags' | 'ai'>;

export interface ScoreResult {
  score: number | null;
  parts: ScoreParts | null;
  flags: TokenFlag[];
}

/** Net pressure in -1..1 from buy and sell amounts. */
function pressure(buy: number | null | undefined, sell: number | null | undefined): number | null {
  if (buy == null || sell == null) return null;
  const total = buy + sell;
  return total > 0 ? (buy - sell) / total : null;
}

/**
 * Momentum screen for memecoins. A score of 50 is neutral; 75+ means price, buy pressure,
 * volume pace and participation are all pointing up at once. It measures what is happening
 * now, not what will happen next.
 */
export function scoreToken(t: Input, now = Date.now()): ScoreResult {
  const flags: TokenFlag[] = [];
  const liq = t.liquidity ?? 0;
  const ageMin = t.createdAt ? (now - t.createdAt) / 60_000 : null;
  const m5 = t.change.m5;
  const h1 = t.change.h1;
  const h24 = t.change.h24;

  // ---- Risk flags (always computed) ----
  if (t.audit.freezeDisabled === false)
    flags.push({ code: 'freeze', label: 'Freeze authority active: the dev can freeze your tokens', severity: 'danger' });
  if (t.audit.mintDisabled === false)
    flags.push({ code: 'mint', label: 'Mint authority active: supply can be inflated', severity: 'danger' });
  if (t.audit.topHoldersPct != null && t.audit.topHoldersPct > 50)
    flags.push({ code: 'holders', label: `Top holders own ${t.audit.topHoldersPct.toFixed(0)}%`, severity: 'warn' });
  if (t.audit.devPct != null && t.audit.devPct > 10)
    flags.push({ code: 'dev', label: `Dev wallet holds ${t.audit.devPct.toFixed(0)}%`, severity: 'warn' });
  if (t.liquidity != null && liq < 10_000) flags.push({ code: 'lowliq', label: 'Low liquidity', severity: 'warn' });
  if (t.liquidity != null && t.mcap && t.mcap > 0 && liq / t.mcap < 0.03)
    flags.push({ code: 'thinliq', label: 'Liquidity is thin for its market cap', severity: 'warn' });
  if (ageMin !== null && ageMin < 15) flags.push({ code: 'new', label: 'Launched under 15 min ago', severity: 'info' });
  else if (ageMin !== null && ageMin < 60) flags.push({ code: 'young', label: 'Under 1 hour old', severity: 'info' });
  const parabolic = (h1 ?? 0) > 300 || (h24 ?? 0) > 1000;
  if (parabolic)
    flags.push({ code: 'parabolic', label: `Parabolic (${pct(Math.max(h1 ?? 0, h24 ?? 0))}): late-entry risk`, severity: 'warn' });
  if (m5 != null && m5 < -10) flags.push({ code: 'dumping', label: `Dumping now (${pct(m5)} in 5m)`, severity: 'warn' });
  const heavySelling =
    t.sellVolume.m5 != null && t.buyVolume.m5 != null && t.sellVolume.m5 > 1.5 * t.buyVolume.m5 && t.sellVolume.m5 > 2_000;
  if (heavySelling) flags.push({ code: 'selling', label: 'Sellers outweigh buyers (5m)', severity: 'warn' });
  const tx5 = t.txns.m5 ? t.txns.m5.buys + t.txns.m5.sells : 0;
  const botLike = tx5 >= 40 && t.volume.m5 != null && t.volume.m5 / tx5 < 10;
  if (botLike) flags.push({ code: 'bots', label: 'Mostly tiny trades: likely bot volume', severity: 'warn' });
  if (t.organicLabel === 'low') flags.push({ code: 'organic', label: 'Low organic activity', severity: 'info' });
  if (t.boosts && t.boosts > 0) flags.push({ code: 'boosted', label: `Paid DexScreener boost (${t.boosts})`, severity: 'info' });

  // ---- Eligibility for a score ----
  const volH1 = t.volume.h1 ?? 0;
  const hasPriceData = m5 != null || h1 != null;
  if (liq < 8_000 || volH1 < 2_000 || !hasPriceData) return { score: null, parts: null, flags };

  // Confidence: a price move or buy streak on a few hundred dollars of volume is noise.
  // 5m: $1k -> 0.23, $5k -> 0.59, $20k+ -> 1.   1h: $5k -> 0.23, $25k -> 0.59, $100k+ -> 1.
  const conf5 = clamp(Math.log10(1 + (t.volume.m5 ?? 0) / 1_000) / Math.log10(21), 0, 1);
  const conf1 = clamp(Math.log10(1 + volH1 / 5_000) / Math.log10(21), 0, 1);

  // Momentum: recent price move, damped so a single spike doesn't dominate.
  const momentum = clamp(
    0.55 * conf5 * Math.tanh((m5 ?? 0) / 12) + 0.45 * conf1 * Math.tanh((h1 ?? 0) / 35),
    -1,
    1,
  );

  // Flow: buy vs sell volume (fallback: trade counts, weighted lower as they are easy to fake).
  let f5 = pressure(t.buyVolume.m5, t.sellVolume.m5);
  let f1 = pressure(t.buyVolume.h1, t.sellVolume.h1);
  if (f5 === null && t.txns.m5 && tx5 >= 10) f5 = 0.6 * (pressure(t.txns.m5.buys, t.txns.m5.sells) ?? 0);
  if (f1 === null && t.txns.h1) f1 = 0.6 * (pressure(t.txns.h1.buys, t.txns.h1.sells) ?? 0);
  const w5 = f5 !== null ? 0.6 * conf5 : 0;
  const w1 = f1 !== null ? 0.4 * conf1 : 0;
  // Breadth: one whale buying looks like strong flow and a volume spike; 100+ wallets is a real move.
  // 10 traders -> 0.52, 30 -> 0.75, 100+ -> 1.
  const traders = t.traders5m ?? tx5;
  const confBreadth = clamp(Math.log10(1 + traders) / Math.log10(101), 0.25, 1);
  // Weighted by confidence; with little volume or few wallets, flow shrinks toward neutral.
  const flow = w5 + w1 > 0 ? (confBreadth * ((f5 ?? 0) * w5 + (f1 ?? 0) * w1)) / Math.max(w5 + w1, 0.6) : 0;

  // Acceleration: is the last 5 minutes busier than the hourly average?
  let acceleration = 0;
  if (t.volume.m5 != null && volH1 > 0) {
    const ratio = (t.volume.m5 * 12) / volH1;
    acceleration = conf5 * confBreadth * Math.tanh(Math.log2(Math.max(ratio, 0.01)));
  }

  // Participation: how many wallets are trading and whether holders are growing.
  const breadth = clamp(Math.log10(1 + traders) / 2, 0, 1);
  const netBuy = t.netBuyers5m != null && t.traders5m ? clamp(t.netBuyers5m / t.traders5m, -1, 1) : 0;
  const holderGrowth = t.holderChange1h != null ? Math.tanh(t.holderChange1h / 20) : 0;
  const participation = clamp(0.5 * breadth + 0.25 * ((netBuy + 1) / 2) + 0.25 * ((holderGrowth + 1) / 2), 0, 1);

  // Quality: depth of liquidity, organic activity, safe authorities, distribution.
  const liqScore = clamp(Math.log10(liq / 10_000) / 2, 0, 1);
  const organic = t.organicScore != null ? clamp(t.organicScore / 100, 0, 1) : 0.3;
  const authorities = t.audit.mintDisabled !== false && t.audit.freezeDisabled !== false ? 1 : 0;
  const distribution = t.audit.topHoldersPct != null ? clamp(1 - (t.audit.topHoldersPct - 15) / 50, 0, 1) : 0.5;
  const quality = 0.4 * liqScore + 0.25 * organic + 0.15 * authorities + 0.2 * distribution;

  let penalty = 0;
  if (t.audit.freezeDisabled === false) penalty += 30;
  if (t.audit.mintDisabled === false) penalty += 20;
  if (m5 != null && m5 < -10) penalty += 12;
  if (parabolic) penalty += 8;
  if (liq < 15_000) penalty += 8;
  if (t.mcap && liq / t.mcap < 0.03) penalty += 5;
  if (botLike) penalty += 12;
  if (t.audit.topHoldersPct != null && t.audit.topHoldersPct > 50) penalty += 8;
  if (heavySelling) penalty += 6;
  if (ageMin !== null && ageMin < 10) penalty += 5;

  const raw =
    0.32 * momentum + 0.25 * flow + 0.13 * acceleration + 0.15 * (2 * participation - 1) + 0.15 * (2 * quality - 1);
  const score = Math.round(clamp(50 + 50 * raw - penalty, 0, 100));

  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    score,
    parts: {
      momentum: r2(momentum),
      flow: r2(flow),
      acceleration: r2(acceleration),
      participation: r2(participation),
      quality: r2(quality),
      penalty,
    },
    flags,
  };
}
