import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Holding, HoldingsResponse, Snapshot, TokenDetail } from '../../shared/types';
import { config, SOL_MINT } from './config';
import {
  ensureToken,
  getSolPrice,
  getView,
  launchList,
  marketPayload,
  migrationList,
  keepWatching,
  onMigration,
  startMarket,
} from './engine/market';
import {
  addTrader,
  leaderboardState,
  removeTrader,
  startTraders,
  tradesForMint,
  traderFeed,
  traderViews,
  updateTrader,
} from './engine/traders';
import { addClient, broadcast, canAcceptClient, clientCount, send } from './lib/bus';
import { errMessage } from './lib/http';
import { allStatus } from './lib/status';
import { saveNow, state } from './lib/store';
import { jupSearch, jupShield, jupTokens, ultraExecute, ultraHoldings, ultraOrder } from './sources/jupiter';
import { newsList, onNews, startNews } from './sources/news';
import { rugcheckSummary } from './sources/rugcheck';

const indexHtml = path.join(config.webDist, 'index.html');
/** e.g. "index-QxZedPTv.js": changes on every web build. */
const webVersion = existsSync(indexHtml) ? (/assets\/(index-[\w-]+\.js)/.exec(readFileSync(indexHtml, 'utf8'))?.[1] ?? null) : null;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (v: unknown): v is string => typeof v === 'string' && BASE58.test(v);

function snapshot(): Snapshot {
  const lb = leaderboardState();
  return {
    version: webVersion,
    market: marketPayload(),
    launches: launchList(),
    migrations: migrationList(),
    news: newsList(),
    traders: traderViews(),
    traderTrades: traderFeed(),
    leaderboard: lb.leaderboard,
    leaderboardUpdated: lb.leaderboardUpdated,
    status: allStatus(),
  };
}

const app = express();
app.disable('x-powered-by');
// Behind a hosting proxy, the visitor's IP is in X-Forwarded-For.
app.set('trust proxy', 1);
// Gzip everything, including the live stream (bus.ts flushes after each event).
app.use(compression());
app.use(express.json({ limit: '256kb' }));

/**
 * Per-visitor rate limit for endpoints that call upstream APIs, so one visitor can't
 * exhaust the shared Jupiter / RugCheck limits. 90 requests, refilling 1.5 per second.
 */
const buckets = new Map<string, { tokens: number; at: number }>();
app.use('/api', (req, res, next) => {
  if (req.path === '/stream' || req.path === '/health') return next();
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: 90, at: now };
  b.tokens = Math.min(90, b.tokens + ((now - b.at) / 1000) * 1.5);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return void res.status(429).json({ error: 'Too many requests. Slow down for a few seconds.' });
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  next();
});
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip);
}, 60_000).unref();

// ---------------------------------------------------------------- live stream

app.get('/api/stream', (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (!canAcceptClient(ip)) return void res.status(503).json({ error: 'Too many open connections' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  send(res, 'snapshot', snapshot());
  addClient(res, ip);
});

app.get('/api/snapshot', (_req, res) => {
  res.json(snapshot());
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clientCount(), status: allStatus() });
});

// ---------------------------------------------------------------- tokens

const detailCache = new Map<string, { at: number; security: TokenDetail['security'] }>();

app.get('/api/token/:mint', async (req, res) => {
  const mint = req.params.mint;
  if (!isAddress(mint)) return void res.status(400).json({ error: 'Invalid token address' });
  const view = await ensureToken(mint);
  if (!view) return void res.status(404).json({ error: 'No market data found for this token yet' });

  let cached = detailCache.get(mint);
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    const [rug, shield] = await Promise.allSettled([rugcheckSummary(mint), jupShield(mint)]);
    const r = rug.status === 'fulfilled' ? rug.value : null;
    cached = {
      at: Date.now(),
      security: {
        rugcheckScore: r?.score ?? null,
        rugcheckRisks: r?.risks ?? [],
        lpLockedPct: r?.lpLockedPct ?? null,
        shieldWarnings: shield.status === 'fulfilled' ? shield.value : [],
      },
    };
    detailCache.set(mint, cached);
    if (detailCache.size > 300) detailCache.delete(detailCache.keys().next().value as string);
  }
  const detail: TokenDetail = { token: view, security: cached.security, watchedTraderTrades: tradesForMint(mint) };
  res.json(detail);
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return void res.json([]);
  const rows = await jupSearch(q.slice(0, 64));
  res.json(
    rows.slice(0, 20).map((j) => ({
      mint: j.id,
      symbol: j.symbol ?? '???',
      name: j.name ?? '',
      icon: j.icon ?? null,
      mcap: j.mcap ?? null,
      liquidity: j.liquidity ?? null,
      verified: Boolean(j.isVerified),
    })),
  );
});

// ---------------------------------------------------------------- watchlist

// Each browser keeps its own watchlist and re-announces it every few minutes so the
// server keeps tracking those coins. Nothing is stored server-side.
app.post('/api/watching', (req, res) => {
  const mints = req.body?.mints;
  if (!Array.isArray(mints) || mints.length > 100 || !mints.every(isAddress))
    return void res.status(400).json({ error: 'Send up to 100 token addresses' });
  keepWatching(mints);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- traders

app.post('/api/traders', (req, res) => {
  const { address, label, source } = req.body ?? {};
  if (!isAddress(address)) return void res.status(400).json({ error: 'That is not a valid Solana wallet address' });
  if (state.traders.length >= 40 && !state.traders.some((t) => t.address === address))
    return void res.status(400).json({ error: 'Watching 40 wallets already. Remove one first.' });
  addTrader(address, typeof label === 'string' ? label.trim().slice(0, 40) : '', source === 'kolscan' ? 'kolscan' : 'manual');
  res.json({ ok: true });
});

app.patch('/api/traders/:address', (req, res) => {
  const ok = updateTrader(req.params.address, { label: req.body?.label, alerts: req.body?.alerts });
  if (!ok) return void res.status(404).json({ error: 'Not watching that wallet' });
  res.json({ ok: true });
});

app.delete('/api/traders/:address', (req, res) => {
  removeTrader(req.params.address);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- wallet & swaps (Jupiter Ultra)

app.get('/api/holdings/:address', async (req, res) => {
  const address = req.params.address;
  if (!isAddress(address)) return void res.status(400).json({ error: 'Invalid wallet address' });
  const h = await ultraHoldings(address);
  const solPrice = getSolPrice();

  const tokens: Holding[] = [];
  for (const [mint, accounts] of Object.entries(h.tokens ?? {})) {
    if (mint === SOL_MINT || !accounts?.length) continue;
    const raw = accounts.reduce((s, a) => s + BigInt(a.amount || '0'), 0n);
    if (raw === 0n) continue;
    const decimals = accounts[0].decimals;
    tokens.push({
      mint,
      amountRaw: raw.toString(),
      uiAmount: accounts.reduce((s, a) => s + (a.uiAmount ?? 0), 0),
      decimals,
      symbol: null,
      name: null,
      icon: null,
      priceUsd: null,
      valueUsd: null,
    });
  }

  // Names and prices: use tracked data where we have it, fetch the rest from Jupiter.
  const unknown = tokens.filter((t) => !getView(t.mint)).map((t) => t.mint);
  const fetched = unknown.length ? await jupTokens(unknown.slice(0, 100), 'trade').catch(() => []) : [];
  const byMint = new Map(fetched.map((j) => [j.id, j]));
  for (const t of tokens) {
    const v = getView(t.mint);
    const j = byMint.get(t.mint);
    t.symbol = v?.symbol ?? j?.symbol ?? null;
    t.name = v?.name ?? j?.name ?? null;
    t.icon = v?.icon ?? j?.icon ?? null;
    t.priceUsd = v?.priceUsd ?? j?.usdPrice ?? null;
    t.valueUsd = t.priceUsd != null ? t.priceUsd * t.uiAmount : null;
  }
  tokens.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const sol = h.uiAmount ?? 0;
  const out: HoldingsResponse = { address, sol, solValueUsd: solPrice ? sol * solPrice : null, tokens, time: Date.now() };
  res.json(out);
});

app.get('/api/swap/order', async (req, res) => {
  const { inputMint, outputMint, amount, taker } = req.query;
  if (!isAddress(inputMint) || !isAddress(outputMint)) return void res.status(400).json({ error: 'Invalid token address' });
  if (typeof amount !== 'string' || !/^[1-9]\d{0,24}$/.test(amount)) return void res.status(400).json({ error: 'Invalid amount' });
  if (taker !== undefined && !isAddress(taker)) return void res.status(400).json({ error: 'Invalid wallet address' });
  const r = await ultraOrder({ inputMint, outputMint, amount, taker: taker as string | undefined });
  res.status(r.status).json(r.data);
});

app.post('/api/swap/execute', async (req, res) => {
  const { signedTransaction, requestId } = req.body ?? {};
  if (typeof signedTransaction !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(signedTransaction) || signedTransaction.length > 20_000)
    return void res.status(400).json({ error: 'Invalid signed transaction' });
  if (typeof requestId !== 'string' || requestId.length > 200) return void res.status(400).json({ error: 'Invalid request id' });
  const r = await ultraExecute(signedTransaction, requestId);
  res.status(r.status).json(r.data);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------- web app

if (existsSync(indexHtml)) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
  app.use((_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
} else {
  app.use((_req, res) => {
    res
      .status(503)
      .type('text')
      .send('The web app has not been built. Run "npm start" (build + serve) or "npm run dev" (development).');
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api]', err);
  if (res.headersSent) return;
  res.status(502).json({ error: errMessage(err) });
});

// ---------------------------------------------------------------- start

onNews((items) => broadcast('news', items));
onMigration((item) => broadcast('event', { type: 'migration', item }));
startMarket();
startTraders();
startNews();

setInterval(() => broadcast('status', allStatus()), 10_000).unref();

const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  MemeRadar is live at http://${host}:${config.port}\n`);
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other process or set PORT in .env.`);
    process.exit(1);
  }
  throw e;
});

const shutdown = () => {
  saveNow();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
