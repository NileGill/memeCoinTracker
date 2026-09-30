import express from 'express';
import type { PaperSettings } from '../../../shared/types';
import { HttpError, route, sameOriginJson, userDeletedListeners } from '../auth/routes';
import { ML } from '../ml/config';
import {
  accountView,
  closeManually,
  createAccount,
  DEFAULT_PAPER_SETTINGS,
  deleteAccount,
  getAccount,
  paperFull,
  paperReady,
  savePaper,
  updateSettings,
} from './paper';

/** Validate settings from the browser; anything missing keeps its current (or default) value. */
function cleanSettings(input: unknown, base: PaperSettings): PaperSettings {
  if (input === undefined) return base;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid bot settings');
  const s = input as Record<string, unknown>;
  const numIn = (key: keyof PaperSettings, min: number, max: number, label: string) => {
    const v = s[key];
    if (v === undefined) return base[key] as number;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
    return v;
  };
  const mode = s.mode === undefined ? base.mode : s.mode;
  if (mode !== 'auto' && mode !== 'model') throw new HttpError(400, 'Invalid strategy');
  const paused = s.paused === undefined ? base.paused : s.paused;
  if (typeof paused !== 'boolean') throw new HttpError(400, 'Invalid pause setting');
  return {
    sizePct: numIn('sizePct', 1, 50, 'Trade size'),
    maxOpen: Math.round(numIn('maxOpen', 1, 20, 'Open trades')),
    mode,
    scoreMin: Math.round(numIn('scoreMin', 60, 95, 'Score minimum')),
    minLiquidity: numIn('minLiquidity', ML.tradeMinLiquidity, 5_000_000, 'Minimum liquidity'),
    maxTradeSol: numIn('maxTradeSol', 0.01, 100, 'Max per trade'),
    maxPoolPct: numIn('maxPoolPct', 0.05, 2, 'Max share of a pool'),
    paused,
  };
}

function requireReady() {
  if (!paperReady()) throw new HttpError(503, 'Paper trading is starting up. Try again in a moment.');
}

export function botRouter() {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  r.use(sameOriginJson);

  r.get(
    '/bot',
    route(
      async (req) => {
        requireReady();
        const a = getAccount(req.user!.id);
        return { account: a ? accountView(a, 500) : null };
      },
      { auth: true },
    ),
  );

  // Start (or restart from scratch) with a fake balance.
  r.post(
    '/bot/start',
    route(
      async (req) => {
        requireReady();
        const start = req.body?.startBalance;
        if (typeof start !== 'number' || !Number.isFinite(start) || start < 0.1 || start > 10_000)
          throw new HttpError(400, 'Starting balance must be between 0.1 and 10,000 SOL.');
        const settings = cleanSettings(req.body?.settings, getAccount(req.user!.id)?.settings ?? DEFAULT_PAPER_SETTINGS);
        if (paperFull(req.user!.id)) throw new HttpError(503, 'The paper trading server is full right now. Try again later.');
        const a = createAccount(req.user!.id, Math.round(start * 1e4) / 1e4, settings);
        await savePaper(req.user!.id, { force: true });
        return { account: accountView(a) };
      },
      { auth: true },
    ),
  );

  r.put(
    '/bot/settings',
    route(
      async (req) => {
        requireReady();
        const a = getAccount(req.user!.id);
        if (!a) throw new HttpError(404, 'Start a paper account first.');
        updateSettings(a, cleanSettings(req.body?.settings, a.settings));
        await savePaper(req.user!.id, { force: true });
        return { account: accountView(a) };
      },
      { auth: true },
    ),
  );

  r.post(
    '/bot/close',
    route(
      async (req) => {
        requireReady();
        const a = getAccount(req.user!.id);
        const id = req.body?.positionId;
        if (!a || typeof id !== 'string' || !closeManually(a, id)) throw new HttpError(404, 'That position is already closed.');
        await savePaper(req.user!.id, { force: true });
        return { account: accountView(a) };
      },
      { auth: true },
    ),
  );

  r.delete(
    '/bot',
    route(
      async (req) => {
        requireReady();
        await deleteAccount(req.user!.id);
        return { ok: true };
      },
      { auth: true },
    ),
  );

  return r;
}

userDeletedListeners.push((userId) => deleteAccount(userId));
