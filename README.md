# MemeRadar

A live Solana memecoin terminal. It shows trending coins and brand-new launches, ranks the best current setups, tracks top traders' wallets, collects memecoin news, alerts you while the site is open, and trades through your Phantom wallet.

## Run it

You need [Node.js](https://nodejs.org) 20.19 or newer.

```bash
npm install
npm start
```

Then open **http://localhost:3000**. `npm start` builds the web app and starts the server. After the first build, `npm run serve` starts it without rebuilding.

For development with hot reload, run `npm run dev` and open http://localhost:5173.

## What's on each page

| Page | What it does |
| --- | --- |
| **Dashboard** | Everything at a glance: best setups, live alerts, fresh launches, top trader moves, graduations and news. |
| **Best trades** | Coins ranked by a 0-100 score, recalculated every few seconds. Hover a score for its breakdown. |
| **Trending** | Every tracked coin, filterable by source (trending, most traded, boosted, new pools, graduated, trader buys…) and sortable by any column. |
| **New launches** | Every new pump.fun coin the moment it's created, plus coins that just graduated to a DEX. |
| **Top traders** | Today's most profitable memecoin traders (from Kolscan), plus a live feed of the swaps of wallets you watch. The 8 most profitable are pre-loaded; add or remove any wallet. |
| **Watchlist** | Coins you starred, with alerts when they move fast. |
| **News** | Headlines from 14 crypto news sources and r/memecoins, filtered for memecoin stories. |
| **Portfolio** | Your Phantom balances with one-click selling, and a log of trades made here. |
| **Settings** | Alert types and thresholds, sound, desktop notifications, max trade size, quick-buy amounts, and data source health. |

Click any coin anywhere to open its chart, stats, score breakdown, safety checks (mint/freeze authority, holder concentration, RugCheck, Jupiter Shield), links and the trade panel.

## How the setup score works

50 is neutral and 75+ is a strong setup. The score combines:

- **Momentum**: price change over 5 minutes and 1 hour
- **Buy pressure**: buy volume vs sell volume
- **Volume pace**: is the last 5 minutes busier than the hourly average?
- **Participation**: wallets trading, net new buyers, holder growth
- **Quality**: liquidity depth, organic (non-bot) activity, revoked authorities, holder distribution

Moves on thin volume or driven by only a few wallets count for less. Points are subtracted for risk: freeze/mint authority still active, dumping, parabolic runs, bot volume, concentrated holders, copycat tickers and very new launches. The score describes what is happening now; it is not a prediction or financial advice.

## Alerts

Alerts only fire while the site is open in a browser tab, as requested. Nothing runs or notifies you when it's closed. You can get alerts for:

- a coin becoming a top setup
- sharp pumps
- volume spikes
- trades by watched traders
- two or more watched traders buying the same coin
- watchlist moves
- pump.fun graduations
- breaking memecoin news

Turn on desktop notifications in Settings to see them while you're in another tab.

## Trading

Connect Phantom with the button in the top right. Buying and selling uses [Jupiter](https://jup.ag) (best price across Solana DEXs, including pump.fun). For every trade:

- you see the quote first: amount received, price impact, route and fee
- a fresh quote is fetched right before signing, and the site checks it matches what you entered
- **you approve the transaction in Phantom**; your keys never touch this site or its server
- buys above your **max trade size** (Settings, default 2 SOL) are blocked, and ~0.01 SOL is always kept for fees
- trades with over 15% price impact need an extra confirmation

Memecoins are extremely risky. Most go to zero, and on-chain trades are final.

## Optional settings (`.env`)

Copy `.env.example` to `.env` to change:

- `SOLANA_RPC_URL`: a private RPC (for example a free [Helius](https://helius.dev) key). **Recommended.** The public RPC is rate-limited, so trader tracking polls every 20s instead of every 8s, and very spammed wallets may miss trades.
- `JUPITER_API_KEY`: a free key from [portal.jup.ag](https://portal.jup.ag) for higher Jupiter rate limits.
- `PORT` / `HOST`: the server listens on `127.0.0.1:3000` by default, so it's only reachable from your computer.

Your watchlist and watched traders are saved in `data/state.json`.

## Data sources

Jupiter (token stats, prices, audits, swaps), DexScreener (live pair data, boosts, profiles, charts), GeckoTerminal (trending and new pools), PumpPortal (real-time pump.fun launches and graduations), Kolscan (trader leaderboard), RugCheck (risk reports), Solana RPC (trader wallet activity), and RSS feeds from Cointelegraph, CoinDesk, Decrypt, The Block, CryptoSlate, Cryptonews, BeInCrypto, CryptoPotato, Bitcoinist, NewsBTC, U.Today, The Defiant and r/memecoins.

## Project layout

```
server/src/
  index.ts          HTTP server, live event stream (SSE), REST API, swap proxy
  engine/market.ts  merges all sources into one live token list, launches, graduations
  engine/scoring.ts setup score and risk flags
  engine/traders.ts wallet polling, swap decoding, leaderboard, convergence detection
  sources/          one client per data source
shared/types.ts     types shared by server and web app
web/src/
  App.tsx, pages/   the pages
  components/       header, tables, token drawer, trade panel, toasts
  lib/              live stream, alert engine, Phantom + Jupiter trading, formatting
```
