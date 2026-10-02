import type { BotEvent, NewsItem, ServerEvent, TokenView } from '../../../shared/types';
import { type AlertItem, type AlertKind, type AlertSeverity, useStore } from '../store';
import { fmtPct, fmtSol, fmtUsd } from './format';

/*
 * All alerting happens in the browser, so alerts only fire while the site is open.
 * Token alerts are derived from each live market update; trader, convergence and
 * graduation alerts come from server events.
 */

const cooldowns = new Map<string, number>();
let primed = false;
/** Tokens this page has already seen at least once. */
const known = new Set<string>();
const WARMUP_MS = 120_000;
/**
 * Setup alerts use hysteresis: a coin must drop clearly below the threshold (5 points)
 * before it can alert again, so a score wobbling 74 -> 75 -> 74 doesn't spam.
 */
const armed = new Map<string, boolean>();
const HYSTERESIS = 5;
/** AI picks re-arm once the model stops picking the coin. */
const aiArmed = new Map<string, boolean>();
const seenNews = new Set<string>();
let newsPrimed = false;
let newsPrimedAt = 0;

function onCooldown(key: string, ms: number): boolean {
  const now = Date.now();
  const until = cooldowns.get(key);
  if (until && until > now) return true;
  cooldowns.set(key, now + ms);
  return false;
}

function push(a: Omit<AlertItem, 'id' | 'time'>) {
  const item: AlertItem = { ...a, id: `${a.kind}:${a.mint ?? ''}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, time: Date.now() };
  const s = useStore.getState();
  const alerts = [item, ...s.alerts].slice(0, 200);
  const toasts = [item, ...s.toasts].slice(0, 5);
  useStore.setState({ alerts, toasts, unread: s.unread + 1 });

  const ttl = a.severity === 'high' || a.severity === 'danger' ? 12_000 : 8_000;
  setTimeout(() => {
    useStore.setState({ toasts: useStore.getState().toasts.filter((t) => t.id !== item.id) });
  }, ttl);

  if (s.settings.sound && a.severity !== 'low') beep(a.severity);
  if (s.settings.desktop && document.hidden) notify(item);
  updateTitle();
}

// ------------------------------------------------------------------ market-derived alerts

const hasDanger = (t: TokenView) => t.flags.some((f) => f.severity === 'danger');

export function checkMarket(tokens: TokenView[], serverStartedAt: number) {
  const { settings, watchlist } = useStore.getState();
  const now = Date.now();

  if (!primed) {
    // First update after opening the page: remember the current state, don't alert on it.
    for (const t of tokens) primeToken(t, settings, watchlist);
    primed = true;
    return;
  }

  for (const t of tokens) {
    if (!known.has(t.mint)) {
      // A token this page hasn't seen before only alerts if the server just discovered it live.
      // Tokens loaded while the server was warming up were already hot, not newly hot.
      const discoveredLive = t.firstSeen > serverStartedAt + WARMUP_MS && now - t.firstSeen < 90_000;
      if (!discoveredLive) {
        primeToken(t, settings, watchlist);
        continue;
      }
      known.add(t.mint);
      armed.set(t.mint, true);
    }
    const liq = t.liquidity ?? 0;
    const name = `$${t.symbol}`;
    const watched = watchlist.includes(t.mint);

    // New high-score setup: crossed the threshold after having been clearly below it.
    if (t.score == null || t.score < settings.setupThreshold - HYSTERESIS) armed.set(t.mint, true);
    if (settings.alertSetups && t.score != null && t.score >= settings.setupThreshold && liq >= settings.minAlertLiquidity && !hasDanger(t)) {
      if (armed.get(t.mint) && !onCooldown(`setup:${t.mint}`, 30 * 60_000)) {
        armed.set(t.mint, false);
        push({
          kind: 'setup',
          severity: 'high',
          mint: t.mint,
          title: `${name} is a top setup: score ${t.score}`,
          body: `5m ${fmtPct(t.change.m5)} · 1h ${fmtPct(t.change.h1)} · liq ${fmtUsd(t.liquidity)} · mcap ${fmtUsd(t.mcap)}`,
        });
      }
    }

    // The AI picked this coin at its latest check (the bot buys at that moment).
    if (!t.ai?.pick) aiArmed.set(t.mint, true);
    else if (settings.alertAi && aiArmed.get(t.mint) !== false && !onCooldown(`ai:${t.mint}`, 60 * 60_000)) {
      aiArmed.set(t.mint, false);
      const target = useStore.getState().ml?.model?.target;
      push({
        kind: 'ai',
        severity: 'high',
        mint: t.mint,
        title: `AI pick: ${name}`,
        body:
          (target ? `${Math.round(t.ai.win * 100)}% of similar trades made money in testing (target +${target.tp}%, stop -${target.sl}%)` : 'The model rates this a buy') +
          (t.ai.ev != null ? ` · avg ${t.ai.ev > 0 ? '+' : ''}${t.ai.ev}% after fees` : ''),
      });
    }

    // Sharp pump with real liquidity behind it.
    if (
      settings.alertPumps &&
      t.change.m5 != null &&
      t.change.m5 >= settings.pumpPct &&
      liq >= settings.minAlertLiquidity &&
      (t.volume.m5 ?? 0) >= 5_000 &&
      !hasDanger(t) &&
      !onCooldown(`pump:${t.mint}`, 20 * 60_000)
    ) {
      push({
        kind: 'pump',
        severity: 'normal',
        mint: t.mint,
        title: `${name} up ${fmtPct(t.change.m5)} in 5 minutes`,
        body: `Volume 5m ${fmtUsd(t.volume.m5)} · liq ${fmtUsd(t.liquidity)} · mcap ${fmtUsd(t.mcap)}`,
      });
    }

    // Volume spike: last 5 minutes running at 4x the hourly pace.
    const v5 = t.volume.m5 ?? 0;
    const v1 = t.volume.h1 ?? 0;
    if (
      settings.alertVolume &&
      v5 >= 25_000 &&
      v1 > 0 &&
      v5 * 12 >= 4 * v1 &&
      liq >= settings.minAlertLiquidity &&
      !hasDanger(t) &&
      !onCooldown(`volume:${t.mint}`, 30 * 60_000)
    ) {
      push({
        kind: 'volume',
        severity: 'normal',
        mint: t.mint,
        title: `Volume spike on ${name}`,
        body: `${fmtUsd(v5)} traded in 5m (${((v5 * 12) / v1).toFixed(1)}x the hourly pace) · 5m ${fmtPct(t.change.m5)}`,
      });
    }

    // Watchlist moves, both directions.
    if (settings.alertWatchlist && watched && t.change.m5 != null && Math.abs(t.change.m5) >= settings.watchPct) {
      const up = t.change.m5 > 0;
      if (!onCooldown(`watch:${up ? 'up' : 'down'}:${t.mint}`, 15 * 60_000)) {
        push({
          kind: up ? 'watch' : 'dump',
          severity: up ? 'high' : 'danger',
          mint: t.mint,
          title: `Watchlist: ${name} ${up ? 'pumping' : 'dumping'} ${fmtPct(t.change.m5)} (5m)`,
          body: `Price now ${t.priceUsd != null ? `$${t.priceUsd.toPrecision(4)}` : '—'} · liq ${fmtUsd(t.liquidity)}`,
        });
      }
    }
  }
}

/** Remember a token's current state without alerting on it. */
function primeToken(t: TokenView, settings: { pumpPct: number; setupThreshold: number; watchPct: number }, watchlist: string[]) {
  known.add(t.mint);
  armed.set(t.mint, t.score == null || t.score < settings.setupThreshold - HYSTERESIS);
  aiArmed.set(t.mint, !t.ai?.pick);
  const until = Date.now() + 20 * 60_000;
  const m5 = t.change.m5;
  if (m5 != null && m5 >= settings.pumpPct) cooldowns.set(`pump:${t.mint}`, until);
  const v5 = t.volume.m5 ?? 0;
  const v1 = t.volume.h1 ?? 0;
  if (v5 >= 25_000 && v1 > 0 && v5 * 12 >= 4 * v1) cooldowns.set(`volume:${t.mint}`, until);
  if (watchlist.includes(t.mint) && m5 != null && Math.abs(m5) >= settings.watchPct)
    cooldowns.set(`watch:${m5 > 0 ? 'up' : 'down'}:${t.mint}`, Date.now() + 15 * 60_000);
}

// ------------------------------------------------------------------ server events

export function handleServerEvent(ev: ServerEvent) {
  const { settings, traders, solPrice } = useStore.getState();
  if (ev.type === 'traderTrade') {
    const t = ev.trade;
    const trader = traders.find((x) => x.address === t.trader);
    if (!settings.alertTraders || (trader && !trader.alerts)) return;
    const sizeSol = t.quote === 'SOL' ? t.quoteAmount : solPrice ? t.quoteAmount / solPrice : 0;
    if (sizeSol < settings.traderMinSol) return;
    const sym = t.symbol ? `$${t.symbol}` : 'a token';
    push({
      kind: 'trader',
      severity: t.side === 'buy' ? 'high' : 'low',
      mint: t.mint,
      title: `${t.traderLabel} ${t.side === 'buy' ? 'bought' : 'sold'} ${sym}`,
      body: `${t.quote === 'SOL' ? fmtSol(t.quoteAmount) : fmtUsd(t.quoteAmount)}${t.usdValue ? ` (${fmtUsd(t.usdValue)})` : ''}`,
    });
  } else if (ev.type === 'convergence') {
    if (!settings.alertConvergence) return;
    push({
      kind: 'convergence',
      severity: 'high',
      mint: ev.mint,
      title: `${ev.traders.length} watched traders bought ${ev.symbol ? `$${ev.symbol}` : 'the same token'}`,
      body: `${ev.traders.join(', ')} within the last hour`,
    });
  } else if (ev.type === 'migration') {
    if (!settings.alertMigrations) return;
    push({
      kind: 'migration',
      severity: 'low',
      mint: ev.item.mint,
      title: `${ev.item.symbol ? `$${ev.item.symbol}` : 'A token'} graduated from pump.fun`,
      body: ev.item.mcapUsd ? `Market cap ${fmtUsd(ev.item.mcapUsd)}` : 'Now trading on a DEX pool',
    });
  }
}

/** The user's paper trading bot bought or sold something. */
export function handleBotEvent(ev: BotEvent) {
  if (!useStore.getState().settings.alertBot) return;
  if (ev.type === 'open') {
    const p = ev.position;
    push({
      kind: 'bot',
      severity: 'normal',
      mint: p.mint,
      title: `Paper bot bought ${p.symbol}`,
      body: `${fmtSol(p.costSol)} of fake SOL · target +${p.target.tp}% / stop -${p.target.sl}% · ${p.strategy === 'model' ? 'AI pick' : `score ${p.signal}`}`,
    });
  } else {
    const t = ev.trade;
    const why = { tp: 'hit its target', faded: 'touched its target, but the price fell back before the sale landed', sl: 'hit its stop', time: 'time limit reached', manual: 'sold by you', gone: 'price feed died: counted as a total loss', reset: 'account reset' }[t.reason];
    push({
      kind: 'bot',
      severity: t.pnlSol > 0 ? 'high' : 'normal',
      mint: t.mint,
      title: `Paper bot sold ${t.symbol}: ${fmtPct(t.pnlPct)}`,
      body: `${t.pnlSol >= 0 ? '+' : ''}${fmtSol(t.pnlSol)} · ${why}`,
    });
  }
}

export function checkNews(items: NewsItem[]) {
  const { settings } = useStore.getState();
  if (!newsPrimed) {
    items.forEach((n) => seenNews.add(n.id));
    newsPrimed = true;
    newsPrimedAt = Date.now();
    return;
  }
  const fresh = items.filter((n) => !seenNews.has(n.id));
  fresh.forEach((n) => seenNews.add(n.id));
  if (!settings.alertNews) return;
  // Only articles published around or after the time this page opened count as breaking.
  const cutoff = Math.max(newsPrimedAt - 10 * 60_000, Date.now() - 60 * 60_000);
  for (const n of fresh.filter((x) => x.meme && x.published >= cutoff).slice(0, 3)) {
    push({ kind: 'news', severity: 'low', title: n.title, body: n.source, url: n.url });
  }
}

/** A reconnect sends a fresh snapshot; don't treat it as a burst of new events. */
export function resetPriming() {
  primed = false;
}

// ------------------------------------------------------------------ sound, notifications, title

let audio: AudioContext | null = null;

export function beep(severity: AlertSeverity) {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const tones = severity === 'high' ? [880, 1320] : severity === 'danger' ? [520, 390] : [740];
    tones.forEach((freq, i) => {
      const ctx = audio!;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.13;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.25);
    });
  } catch {
    /* audio unavailable */
  }
}

function notify(a: AlertItem) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(a.title, { body: a.body, tag: a.id, silent: true });
    n.onclick = () => {
      window.focus();
      if (a.mint) useStore.setState({ selectedMint: a.mint, drawerSide: 'buy' });
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export async function requestDesktopPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

const BASE_TITLE = 'MemeRadar';
export function updateTitle() {
  const { unread } = useStore.getState();
  document.title = document.hidden && unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}
document.addEventListener('visibilitychange', updateTitle);

export const ALERT_ICONS: Record<AlertKind, string> = {
  setup: 'target',
  pump: 'trend',
  dump: 'down',
  volume: 'bars',
  trader: 'user',
  convergence: 'users',
  migration: 'grad',
  watch: 'star',
  news: 'news',
  ai: 'sparkles',
  bot: 'bot',
};
