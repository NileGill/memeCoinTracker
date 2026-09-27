import type { TokenSource, TokenView } from '../../../shared/types';

/**
 * A snapshot of one coin at one moment: the raw numbers the model learns from.
 * Snapshots are stored raw (not as model features) so features can be improved later
 * without throwing away the data already collected.
 */
export interface Obs {
  t: number;
  mint: string;
  price: number;
  mcap: number | null;
  fdv: number | null;
  liq: number | null;
  holders: number | null;
  age: number | null; // minutes since launch
  c5: number | null;
  c1h: number | null;
  c6h: number | null;
  c24h: number | null;
  v5: number | null;
  v1h: number | null;
  v6h: number | null;
  v24h: number | null;
  bv5: number | null;
  bv1h: number | null;
  sv5: number | null;
  sv1h: number | null;
  b5: number | null;
  s5: number | null;
  b1h: number | null;
  s1h: number | null;
  tr5: number | null;
  nb5: number | null;
  nb1h: number | null;
  hc1h: number | null;
  org: number | null;
  mintOff: number | null; // 1 revoked, 0 active
  frzOff: number | null;
  top: number | null;
  dev: number | null;
  boosts: number | null;
  ver: number;
  pad: string | null;
  dex: string | null;
  soc: number;
  src: number; // bitmask of SOURCES
  score: number | null;
  sMom: number | null;
  sFlow: number | null;
  sAcc: number | null;
  sPart: number | null;
  sQual: number | null;
  sPen: number | null;
  flags: number; // bitmask of FLAGS
  tracked: number; // minutes since MemeRadar first saw it
  r1: number | null; // our own price tape: % move over the last 1 / 3 / 10 minutes
  r3: number | null;
  r10: number | null;
  sol1h: number | null; // SOL's own 1h move
  l1h: number; // pump.fun launches in the last hour
  g1h: number; // graduations in the last hour
  breadth: number | null; // share of tracked coins that are up over 5m
}

/** Field order used when snapshots are stored as arrays. Stored batches carry their own copy. */
export const OBS_FIELDS: (keyof Obs)[] = [
  't', 'mint', 'price', 'mcap', 'fdv', 'liq', 'holders', 'age', 'c5', 'c1h', 'c6h', 'c24h', 'v5', 'v1h', 'v6h', 'v24h',
  'bv5', 'bv1h', 'sv5', 'sv1h', 'b5', 's5', 'b1h', 's1h', 'tr5', 'nb5', 'nb1h', 'hc1h', 'org', 'mintOff', 'frzOff',
  'top', 'dev', 'boosts', 'ver', 'pad', 'dex', 'soc', 'src', 'score', 'sMom', 'sFlow', 'sAcc', 'sPart', 'sQual', 'sPen',
  'flags', 'tracked', 'r1', 'r3', 'r10', 'sol1h', 'l1h', 'g1h', 'breadth',
];

// Order matters: stored bitmasks depend on it. Only ever append.
const SOURCES: TokenSource[] = ['trending', 'traded', 'organic', 'boosted', 'profile', 'cto', 'newpool', 'launch', 'graduated', 'trader'];
const FLAGS = ['freeze', 'mint', 'holders', 'dev', 'lowliq', 'thinliq', 'new', 'young', 'parabolic', 'dumping', 'selling', 'bots', 'organic', 'boosted', 'copycat'];

export interface ObsContext {
  now: number;
  /** % price move over the last `minutes` from the recorder's tape, or null. */
  tapeReturn: (mint: string, minutes: number) => number | null;
  sol1h: number | null;
  launches1h: number;
  grads1h: number;
  breadth: number | null;
}

/** Round to 5 significant digits: plenty for learning, and it roughly halves storage. */
const sig = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Number.isInteger(v) ? v : Number(v.toPrecision(5));

const bool = (v: boolean | null) => (v == null ? null : v ? 1 : 0);

export function makeObs(v: TokenView, ctx: ObsContext): Obs | null {
  if (v.priceUsd == null || !(v.priceUsd > 0)) return null;
  let src = 0;
  SOURCES.forEach((s, i) => {
    if (v.sources.includes(s)) src |= 1 << i;
  });
  let flags = 0;
  for (const f of v.flags) {
    const i = FLAGS.indexOf(f.code);
    if (i >= 0) flags |= 1 << i;
  }
  const p = v.scoreParts;
  return {
    t: ctx.now,
    mint: v.mint,
    price: v.priceUsd,
    mcap: sig(v.mcap),
    fdv: sig(v.fdv),
    liq: sig(v.liquidity),
    holders: sig(v.holders),
    age: v.createdAt ? sig(Math.max(0, (ctx.now - v.createdAt) / 60_000)) : null,
    c5: sig(v.change.m5),
    c1h: sig(v.change.h1),
    c6h: sig(v.change.h6),
    c24h: sig(v.change.h24),
    v5: sig(v.volume.m5),
    v1h: sig(v.volume.h1),
    v6h: sig(v.volume.h6),
    v24h: sig(v.volume.h24),
    bv5: sig(v.buyVolume.m5),
    bv1h: sig(v.buyVolume.h1),
    sv5: sig(v.sellVolume.m5),
    sv1h: sig(v.sellVolume.h1),
    b5: v.txns.m5?.buys ?? null,
    s5: v.txns.m5?.sells ?? null,
    b1h: v.txns.h1?.buys ?? null,
    s1h: v.txns.h1?.sells ?? null,
    tr5: sig(v.traders5m),
    nb5: sig(v.netBuyers5m),
    nb1h: sig(v.netBuyers1h),
    hc1h: sig(v.holderChange1h),
    org: sig(v.organicScore),
    mintOff: bool(v.audit.mintDisabled),
    frzOff: bool(v.audit.freezeDisabled),
    top: sig(v.audit.topHoldersPct),
    dev: sig(v.audit.devPct),
    boosts: sig(v.boosts),
    ver: v.verified ? 1 : 0,
    pad: v.launchpad,
    dex: v.dexId,
    soc: (v.links.website ? 1 : 0) + (v.links.twitter ? 1 : 0) + (v.links.telegram ? 1 : 0),
    src,
    score: v.score,
    sMom: p?.momentum ?? null,
    sFlow: p?.flow ?? null,
    sAcc: p?.acceleration ?? null,
    sPart: p?.participation ?? null,
    sQual: p?.quality ?? null,
    sPen: p?.penalty ?? null,
    flags,
    tracked: sig(Math.max(0, (ctx.now - v.firstSeen) / 60_000)) ?? 0,
    r1: sig(ctx.tapeReturn(v.mint, 1)),
    r3: sig(ctx.tapeReturn(v.mint, 3)),
    r10: sig(ctx.tapeReturn(v.mint, 10)),
    sol1h: sig(ctx.sol1h),
    l1h: ctx.launches1h,
    g1h: ctx.grads1h,
    breadth: sig(ctx.breadth),
  };
}

export const encodeObs = (o: Obs): unknown[] => OBS_FIELDS.map((k) => o[k]);

/** Rebuild a snapshot from a stored array using that batch's field list (missing fields become null). */
export function decodeObs(fields: string[], row: unknown[]): Obs {
  const o: Record<string, unknown> = {};
  fields.forEach((k, i) => (o[k] = row[i] ?? null));
  for (const k of OBS_FIELDS) if (!(k in o)) o[k] = null;
  return o as unknown as Obs;
}

// ---------------------------------------------------------------- model features

const n = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? NaN : v);
const log10p = (v: number | null) => (v == null || !Number.isFinite(v) || v < 0 ? NaN : Math.log10(1 + v));
const logp = (v: number | null) => (v == null || !Number.isFinite(v) || v < 0 ? NaN : Math.log1p(v));
const ratio = (a: number | null, b: number | null) => (a == null || b == null || !(b > 0) ? NaN : a / b);
const share = (a: number | null, b: number | null) =>
  a == null || b == null || !(a + b > 0) ? NaN : (a - b) / (a + b);
const signedLog = (v: number | null) => (v == null || !Number.isFinite(v) ? NaN : Math.sign(v) * Math.log1p(Math.abs(v)));
const bit = (mask: number, list: string[], name: string) => ((mask >> list.indexOf(name)) & 1 ? 1 : 0);
const has = (s: string | null, part: string) => (s == null ? NaN : s.toLowerCase().includes(part) ? 1 : 0);

interface FeatureDef {
  label: string;
  get: (o: Obs) => number;
}

/** What the model sees. Labels are what the site shows when explaining a prediction. */
export const FEATURES: FeatureDef[] = [
  { label: 'Coin age', get: (o) => logp(o.age) },
  { label: 'Market cap', get: (o) => log10p(o.mcap) },
  { label: 'Liquidity', get: (o) => log10p(o.liq) },
  { label: 'Liquidity vs market cap', get: (o) => ratio(o.liq, o.mcap) },
  { label: 'Price change 5m', get: (o) => n(o.c5) },
  { label: 'Price change 1h', get: (o) => n(o.c1h) },
  { label: 'Price change 6h', get: (o) => n(o.c6h) },
  { label: 'Price change 24h', get: (o) => n(o.c24h) },
  { label: 'Volume 5m', get: (o) => log10p(o.v5) },
  { label: 'Volume 1h', get: (o) => log10p(o.v1h) },
  { label: 'Volume 6h', get: (o) => log10p(o.v6h) },
  { label: 'Volume 24h', get: (o) => log10p(o.v24h) },
  { label: 'Volume pace (5m vs 1h)', get: (o) => (o.v5 != null && o.v1h != null && o.v1h > 0 ? (o.v5 * 12) / o.v1h : NaN) },
  { label: 'Hourly volume vs liquidity', get: (o) => ratio(o.v1h, o.liq) },
  { label: 'Daily volume vs market cap', get: (o) => ratio(o.v24h, o.mcap) },
  { label: 'Buy pressure 5m', get: (o) => share(o.bv5, o.sv5) },
  { label: 'Buy pressure 1h', get: (o) => share(o.bv1h, o.sv1h) },
  { label: 'Buy count vs sells 5m', get: (o) => share(o.b5, o.s5) },
  { label: 'Buy count vs sells 1h', get: (o) => share(o.b1h, o.s1h) },
  { label: 'Trades 5m', get: (o) => (o.b5 == null || o.s5 == null ? NaN : Math.log1p(o.b5 + o.s5)) },
  {
    label: 'Average trade size',
    get: (o) => (o.v5 == null || o.b5 == null || o.s5 == null || o.b5 + o.s5 === 0 ? NaN : Math.log10(1 + o.v5 / (o.b5 + o.s5))),
  },
  { label: 'Wallets trading 5m', get: (o) => logp(o.tr5) },
  { label: 'Net new buyers 5m', get: (o) => ratio(o.nb5, o.tr5) },
  { label: 'Net new buyers 1h', get: (o) => signedLog(o.nb1h) },
  { label: 'Holders', get: (o) => logp(o.holders) },
  { label: 'Holder growth 1h', get: (o) => n(o.hc1h) },
  { label: 'Organic activity', get: (o) => n(o.org) },
  { label: 'Mint authority revoked', get: (o) => n(o.mintOff) },
  { label: 'Freeze authority revoked', get: (o) => n(o.frzOff) },
  { label: 'Top holders share', get: (o) => n(o.top) },
  { label: 'Dev wallet share', get: (o) => n(o.dev) },
  { label: 'Paid boosts', get: (o) => logp(o.boosts) },
  { label: 'Verified', get: (o) => o.ver },
  { label: 'Launched on pump.fun', get: (o) => (o.pad == null ? NaN : o.pad === 'pump.fun' ? 1 : 0) },
  { label: 'Trading on PumpSwap', get: (o) => has(o.dex, 'pump') },
  { label: 'Trading on Raydium', get: (o) => has(o.dex, 'raydium') },
  { label: 'Trading on Meteora', get: (o) => has(o.dex, 'meteora') },
  { label: 'Social links', get: (o) => o.soc },
  { label: 'Trending lists', get: (o) => bit(o.src, SOURCES, 'trending') },
  { label: 'Most-traded lists', get: (o) => bit(o.src, SOURCES, 'traded') },
  { label: 'Organic-volume lists', get: (o) => bit(o.src, SOURCES, 'organic') },
  { label: 'DexScreener boost', get: (o) => bit(o.src, SOURCES, 'boosted') },
  { label: 'New DexScreener profile', get: (o) => bit(o.src, SOURCES, 'profile') },
  { label: 'Community takeover', get: (o) => bit(o.src, SOURCES, 'cto') },
  { label: 'New pool', get: (o) => bit(o.src, SOURCES, 'newpool') },
  { label: 'Fresh launch with traction', get: (o) => bit(o.src, SOURCES, 'launch') },
  { label: 'Graduated from pump.fun', get: (o) => bit(o.src, SOURCES, 'graduated') },
  { label: 'Bought by a watched trader', get: (o) => bit(o.src, SOURCES, 'trader') },
  { label: 'MemeRadar score', get: (o) => n(o.score) },
  { label: 'Score: momentum', get: (o) => n(o.sMom) },
  { label: 'Score: buy pressure', get: (o) => n(o.sFlow) },
  { label: 'Score: volume pace', get: (o) => n(o.sAcc) },
  { label: 'Score: participation', get: (o) => n(o.sPart) },
  { label: 'Score: quality', get: (o) => n(o.sQual) },
  { label: 'Score: risk penalty', get: (o) => n(o.sPen) },
  { label: 'Concentrated holders', get: (o) => bit(o.flags, FLAGS, 'holders') },
  { label: 'Thin liquidity', get: (o) => bit(o.flags, FLAGS, 'thinliq') },
  { label: 'Parabolic run', get: (o) => bit(o.flags, FLAGS, 'parabolic') },
  { label: 'Dumping', get: (o) => bit(o.flags, FLAGS, 'dumping') },
  { label: 'Sellers outweigh buyers', get: (o) => bit(o.flags, FLAGS, 'selling') },
  { label: 'Bot volume', get: (o) => bit(o.flags, FLAGS, 'bots') },
  { label: 'Copycat ticker', get: (o) => bit(o.flags, FLAGS, 'copycat') },
  { label: 'Time on MemeRadar', get: (o) => Math.log1p(o.tracked) },
  { label: 'Price move last 1m', get: (o) => n(o.r1) },
  { label: 'Price move last 3m', get: (o) => n(o.r3) },
  { label: 'Price move last 10m', get: (o) => n(o.r10) },
  { label: 'SOL price 1h', get: (o) => n(o.sol1h) },
  { label: 'Launches per hour', get: (o) => o.l1h },
  { label: 'Graduations per hour', get: (o) => o.g1h },
  { label: 'Market mood (coins up)', get: (o) => n(o.breadth) },
];

export const NUM_FEATURES = FEATURES.length;

/** Model inputs for one snapshot, written into `out` at `offset`. Missing values are NaN. */
export function featurize(o: Obs, out: Float32Array, offset = 0) {
  for (let f = 0; f < NUM_FEATURES; f++) {
    const v = FEATURES[f].get(o);
    out[offset + f] = Number.isFinite(v) ? v : NaN;
  }
}

/** Danger flags (mint or freeze authority still active): never traded. */
export const hasDanger = (o: Obs) => bit(o.flags, FLAGS, 'freeze') === 1 || bit(o.flags, FLAGS, 'mint') === 1;
