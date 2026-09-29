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
| **AI bot** | The AI model's status and test results, its current picks, and your paper trading bot (fake SOL, runs 24/7). |
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
- AI picks (once the model has proven itself)
- your paper bot buying or selling

Turn on desktop notifications in Settings to see them while you're in another tab.

## Trading

Connect Phantom with the button in the top right. Buying and selling uses [Jupiter](https://jup.ag) (best price across Solana DEXs, including pump.fun). For every trade:

- you see the quote first: amount received, price impact, route and fee
- a fresh quote is fetched right before signing, and the site checks it matches what you entered
- **you approve the transaction in Phantom**; your keys never touch this site or its server
- buys above your **max trade size** (Settings, default 2 SOL) are blocked, and ~0.01 SOL is always kept for fees
- trades with over 15% price impact need an extra confirmation

Memecoins are extremely risky. Most go to zero, and on-chain trades are final.

## AI model and paper trading bot

**What it predicts.** For any coin at any moment: if you bought now, would it hit a profit target (for example +30%) before a stop-loss (for example -15%) within an hour?

**Where the data comes from.** No free source offers the full history of a memecoin's buyers, sellers, liquidity and holders, so the server records its own. Every tracked coin with $5K+ liquidity is snapshotted when it appears and every 15 minutes after: about 55 numbers covering price moves, volume, buy pressure, wallets, holders, liquidity, safety checks, launchpad, how long it has been tracked, and the wider market. Each snapshot's price is then followed for an hour, recording when it first reached +10/20/30/50/100% and -10/15/20/30/50%. Coins that drop off the lists keep being followed in the background, so rugs count as losses instead of vanishing. Finished snapshots are saved to Postgres hourly (kept 14 days) and reloaded after a restart.

**How it learns.** Gradient-boosted decision trees (`server/src/ml/gbdt.ts`, written from scratch so the free server needs nothing extra), trained in short bursts so the site stays responsive. Every 4 hours it retrains on up to 100,000 recent snapshots, split by time:

- the oldest 70% to learn from
- the next 15% to choose the target (+20/-10, +30/-15 or +50/-20) and how picky to be
- the newest 15% as a test it never trained on

Test trades pay a 1.5% cost per side (1% fees plus the ~0.5% slippage of a trade sized at 0.25% of a pool), a stop fills at the price actually seen (often worse than the stop), a coin can't be re-bought for an hour after selling, and coins under $10K liquidity or with mint/freeze authority active are never bought. The model is only called **proven**, and only then used by the bot, when test trades averaged +1% or better after fees over at least 25 trades and its ranking skill (AUC) is at least 0.55. Its results are shown next to the plain MemeRadar score traded on the same period.

**Crash filter.** Predicting "target before stop" alone can't tell a -15% stop from a rug that falls straight to zero, and rugs gap right through stop-losses (the first real model won 58% of its test trades but still lost money because of them). So a second model learns which coins fall 50%+ or vanish within the hour, and the bot only buys coins the win model likes *and* the crash model doesn't flag. The tuning data picks the crash cutoff together with the target (+20/-10, +20/-20, +30/-15, +30/-30 or +50/-20) and the confidence bar; when two choices make about the same money, it takes the one with the higher win rate. Extra early-warning inputs come from the site's own tracking: liquidity and holder changes over the last 3-10 minutes, price choppiness, and the drop from the 10-minute high.

**Paper trading bot.** Logged-in users can start a bot with fake SOL. It runs on the server around the clock, including while the site is closed: it buys the model's picks once the model is proven (or, until then, coins at your chosen score, if you allow that), sells at the target, the stop or the time limit, and fills trades the way memecoin pools actually trade:

- **Slippage from pool math** (constant product): buying or selling a lot relative to a pool gets a much worse price, and you can never take out more than the pool holds.
- **Trade size is capped** at a share of the coin's pool (default 0.25%) and an absolute amount (default 2 SOL), so the bot never buys more than a coin can absorb.
- **Liquidity is the lower** of DexScreener's and Jupiter's readings; coins where they disagree by 3x or more, or whose pool is bigger than the coin's value, are skipped.
- **Orders land a moment later, like real ones.** A buy is placed when the signal is seen and fills at the next fresh price reading; a take-profit is triggered when the target is seen and sells at the next reading (capped at the target, so a brief spike never pays out in full); stops fill at the price actually seen. The model's test measures its trades the same way (snapshots record the price at the next reading after the snapshot and after each target is reached), and it won't call itself proven until most of its test period was measured like this.
- Every buy and sell pays a 1% fee and a 0.0005 SOL network fee, and a coin whose price feed dies counts as a total loss.

The first version capped slippage at 50%, which let big positions "sell" into nearly empty pools and turned 1 SOL into hundreds; accounts started before the fix are marked as overstated. The bot page lists the most profitable and worst trades ever, where the profit came from (by how trades ended and by strategy), and each trade's size and pool liquidity. Settings: trade size, max per trade, max share of a pool, open trades at once, minimum liquidity, strategy, pause.

**Real money** stays locked. The bot page shows a checklist: 100+ paper trades, profitable after fees, profit factor 1.3+, worst drawdown under 35%, 7+ days running, and a proven model. Phantom requires approving every transaction, so fully automatic trading would need a separate wallet made for the bot, holding only money you can afford to lose, with hard per-trade and daily limits. That part isn't built yet.

Local testing: `ML_FAST=1 npm run serve` shrinks every timescale from hours to minutes. Fast-mode data is stored separately and never mixes with real data.

## Accounts

With accounts on, people can sign up with an email and password and verify their email with a 6-digit code. Their settings, watchlist, saved traders, trade history and linked Phantom wallet then follow them to any device.

How logins are kept safe:

- **Passwords** are stored only as scrypt hashes (salted, deliberately slow), never in plain text. Minimum 10 characters, and common passwords are rejected.
- **Sessions** use a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on HTTPS) that page scripts can't read. The database stores only its SHA-256, and sessions expire after 30 days idle.
- **Email codes** expire after 10 minutes, allow 5 tries, and are limited to 5 per hour.
- **Brute force:** 5 wrong passwords lock the account for 15 minutes, and every auth endpoint has a per-IP rate limit.
- **No account discovery:** signup and "forgot password" answer the same way whether or not an email is registered, and failed logins take the same time.
- **Account changes:** resetting a password signs out every device; changing it signs out all other devices.
- **Cross-site requests** are blocked (same-origin JSON only), and the site can't be framed by other sites.
- **Wallets** are linked by signing a one-time message in Phantom, which proves ownership and can't move funds. Only the public address is stored. The site never asks for a seed phrase or private key.

Accounts turn on when `DATABASE_URL` and a way to send email are set: either `BREVO_API_KEY` + `MAIL_FROM` ([Brevo](https://www.brevo.com), free, sends over HTTPS) or `SMTP_USER` / `SMTP_PASS`. **Render's free plan blocks outgoing SMTP**, so on it only Brevo works. Without them the site works normally, just without logins. In local development, codes are printed to the server console instead of emailed.

## Optional settings (`.env`)

Copy `.env.example` to `.env` to change:

- `SOLANA_RPC_URL`: a private RPC (for example a free [Helius](https://helius.dev) key). **Recommended.** The public RPC is rate-limited, so trader tracking polls every 20s instead of every 8s, and very spammed wallets may miss trades.
- `JUPITER_API_KEY`: a free key from [portal.jup.ag](https://portal.jup.ag) for higher Jupiter rate limits.
- `PORT` / `HOST`: the server listens on `127.0.0.1:3000` by default, so it's only reachable from your computer.

Your watchlist is saved in your browser, so every visitor has their own. The shared list of watched traders is saved in `data/state.json`. Wallets you add yourself are also remembered in your browser and restored automatically if the server restarts.

## Hosting it online (free)

The repo includes a [Render](https://render.com) Blueprint (`render.yaml`), so the site runs on Render's free plan.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Click **New → Blueprint**, pick the `memeCoinTracker` repo, then **Apply**.
3. After the first build (~3 minutes), your address is shown at the top of the service page in Render. It looks like `https://memeradar-xxxx.onrender.com`. **Use that exact link.** Plain `memeradar.onrender.com` belongs to someone else's unrelated site.

**Automatic updates.** A GitHub Action (`.github/workflows/deploy.yml`) type-checks and builds every push to `main`, then tells Render to deploy, so broken code never goes live. It needs one secret:

1. In Render, open the service, go to **Settings**, and copy the **Deploy Hook** URL. Keep it private: anyone with it can trigger deploys.
2. In GitHub, open the repo's **Settings → Secrets and variables → Actions → New repository secret**. Set the name to `RENDER_DEPLOY_HOOK` and paste the URL as the value.

(If you instead connect Render to your GitHub account and turn on Auto-Deploy, leave the secret unset to avoid double deploys.)

Good to know about the free plan:

- **It sleeps after 15 minutes with no visitors.** The first visit after that takes about a minute to wake it, and then another minute to fill with live data. An open tab keeps it awake.
- **Restarts reset the server's memory.** That happens on every deploy and after sleeping: the launch feed and trader history start over, and the trader list goes back to today's top 8 plus any wallets your browser added.
- **Its IP is shared with other Render apps**, so free APIs may rate-limit it sooner. Adding `SOLANA_RPC_URL` (free Helius key) and `JUPITER_API_KEY` under the service's **Environment** tab fixes most of that.
- **On a phone**, tap **Open in Phantom** to use the site inside the Phantom app's browser so you can trade.

The site is public and has no login. Anyone with the link can view it and change the shared trader list. Trades always need the visitor's own Phantom approval.

## Data sources

Jupiter (token stats, prices, audits, swaps), DexScreener (live pair data, boosts, profiles, charts), GeckoTerminal (trending and new pools), PumpPortal (real-time pump.fun launches and graduations), Kolscan (trader leaderboard), RugCheck (risk reports), Solana RPC (trader wallet activity), and RSS feeds from Cointelegraph, CoinDesk, Decrypt, The Block, CryptoSlate, Cryptonews, BeInCrypto, CryptoPotato, Bitcoinist, NewsBTC, U.Today, The Defiant and r/memecoins.

## Project layout

```
server/src/
  index.ts          HTTP server, live event stream (SSE), REST API, swap proxy
  engine/market.ts  merges all sources into one live token list, launches, graduations
  engine/scoring.ts setup score and risk flags
  engine/traders.ts wallet polling, swap decoding, leaderboard, convergence detection
  ml/recorder.ts    coin snapshots and their outcomes (the training data)
  ml/model.ts       training, out-of-sample testing, live predictions
  ml/gbdt.ts        gradient-boosted decision trees
  bot/paper.ts      paper trading bots (fake SOL, runs 24/7)
  sources/          one client per data source
shared/types.ts     types shared by server and web app
web/src/
  App.tsx, pages/   the pages
  components/       header, tables, token drawer, trade panel, toasts
  lib/              live stream, alert engine, Phantom + Jupiter trading, formatting
```
