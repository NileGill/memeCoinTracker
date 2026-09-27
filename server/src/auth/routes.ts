import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import bs58 from 'bs58';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AccountData, AuthUser } from '../../../shared/types';
import { config } from '../config';
import {
  dummyHash,
  hashCode,
  hashPassword,
  newCode,
  newSessionToken,
  normalizeEmail,
  passwordProblem,
  safeEqualHex,
  sha256,
  verifyPassword,
} from './crypto';
import { cleanup, db, migrate, requireDb } from './db';
import { EmailError, emailReady, sendAuthEmail } from './mail';

const COOKIE = 'mr_session';
const SESSION_DAYS = 30;
const SESSION_MAX_DAYS = 180;
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const CODE_COOLDOWN_S = 60;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/** Accounts work when there is a database and a way to deliver codes. */
export const authEnabled = Boolean(db) && emailReady;
/** Set once the database schema is confirmed; until then account routes answer 503. */
let ready = false;

/** At most one "already registered" notice per address per 30 minutes, so it can't be used to spam someone. */
const noticeSent = new Map<string, number>();

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  failed_logins: number;
  locked_until: Date | null;
  wallet_address: string | null;
  data: AccountData;
  created_at: Date;
}

export type AuthedRequest = Request & { user?: UserRow; sessionHash?: string };

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const toUser = (u: UserRow): AuthUser => ({
  email: u.email,
  createdAt: u.created_at.getTime(),
  wallet: u.wallet_address,
});

// ---------------------------------------------------------------- cookies & sessions

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieAttrs(req: Request, maxAgeS: number) {
  const secure = req.secure || config.isHosted;
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

async function startSession(req: Request, res: Response, userId: string) {
  const token = newSessionToken();
  await requireDb().query(
    `insert into sessions (token_hash, user_id, expires_at, user_agent, ip)
     values ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [sha256(token), userId, SESSION_DAYS, (req.get('user-agent') ?? '').slice(0, 300), req.ip ?? null],
  );
  res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req, SESSION_DAYS * 86_400)}`);
}

function clearSessionCookie(req: Request, res: Response) {
  res.append('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req, 0)}`);
}

/** Called after an account is deleted, so other modules can drop what they keep for it. */
export const userDeletedListeners: ((userId: string) => Promise<void> | void)[] = [];

/** The logged-in user's id for a request, or null (never throws). */
export async function sessionUserId(req: Request): Promise<string | null> {
  if (!authEnabled || !ready) return null;
  const r = req as AuthedRequest;
  try {
    await loadSession(r);
  } catch {
    return null;
  }
  return r.user?.id ?? null;
}

/** Attach req.user when the request carries a valid session cookie. */
async function loadSession(req: AuthedRequest) {
  const token = readCookie(req, COOKIE);
  if (!token || token.length > 100) return;
  const hash = sha256(token);
  const { rows } = await requireDb().query<UserRow & { last_seen_at: Date }>(
    `select u.*, s.last_seen_at from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()
       and s.created_at > now() - make_interval(days => $2)`,
    [hash, SESSION_MAX_DAYS],
  );
  const row = rows[0];
  if (!row || !row.email_verified_at) return;
  req.user = row;
  req.sessionHash = hash;
  // Sliding expiry, written at most once an hour.
  if (Date.now() - row.last_seen_at.getTime() > 3_600_000) {
    await requireDb().query(
      `update sessions set last_seen_at = now(), expires_at = now() + make_interval(days => $2) where token_hash = $1`,
      [hash, SESSION_DAYS],
    );
  }
}

// ---------------------------------------------------------------- rate limiting & codes

/** Per-IP limiter for auth endpoints: bursts of 12, then one request every 15 seconds. */
const ipBuckets = new Map<string, { tokens: number; at: number }>();
function authRateLimit(req: Request) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const b = ipBuckets.get(ip) ?? { tokens: 12, at: now };
  b.tokens = Math.min(12, b.tokens + (now - b.at) / 15_000);
  b.at = now;
  ipBuckets.set(ip, b);
  if (b.tokens < 1) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
  b.tokens -= 1;
}
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [ip, b] of ipBuckets) if (b.at < cutoff) ipBuckets.delete(ip);
}, 10 * 60_000).unref();

/** Issue and email a code. Silently skips if one was sent very recently or the hourly cap is hit. */
async function issueCode(email: string, purpose: 'verify' | 'reset') {
  const pool = requireDb();
  const { rows } = await pool.query<{ recent: string; last: Date | null }>(
    `select count(*) filter (where created_at > now() - interval '1 hour') as recent, max(created_at) as last
     from email_codes where email = $1 and purpose = $2`,
    [email, purpose],
  );
  const recent = Number(rows[0]?.recent ?? 0);
  const last = rows[0]?.last;
  if (recent >= CODES_PER_HOUR) return;
  if (last && Date.now() - last.getTime() < CODE_COOLDOWN_S * 1000) return;

  const code = newCode();
  await pool.query(`update email_codes set used_at = now() where email = $1 and purpose = $2 and used_at is null`, [
    email,
    purpose,
  ]);
  await pool.query(
    `insert into email_codes (email, purpose, code_hash, expires_at)
     values ($1, $2, $3, now() + make_interval(mins => $4))`,
    [email, purpose, hashCode(purpose, email, code), CODE_TTL_MIN],
  );
  await sendAuthEmail(email, purpose, code);
}

/** Check a code; throws a user-facing error when it's wrong, used up or expired. */
async function consumeCode(email: string, purpose: 'verify' | 'reset', code: unknown) {
  const bad = new HttpError(400, 'That code is incorrect or has expired. Request a new one if needed.');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) throw bad;
  const pool = requireDb();
  const { rows } = await pool.query<{ id: string; code_hash: string; attempts: number }>(
    `select id, code_hash, attempts from email_codes
     where email = $1 and purpose = $2 and used_at is null and expires_at > now()
     order by created_at desc limit 1`,
    [email, purpose],
  );
  const row = rows[0];
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) throw bad;
  if (!safeEqualHex(hashCode(purpose, email, code.trim()), row.code_hash)) {
    await pool.query(`update email_codes set attempts = attempts + 1 where id = $1`, [row.id]);
    throw bad;
  }
  await pool.query(`update email_codes set used_at = now() where id = $1`, [row.id]);
}

// ---------------------------------------------------------------- account data validation

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

function cleanData(input: unknown): AccountData {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid data');
  const d = input as Record<string, unknown>;
  const out: AccountData = {};
  if (d.settings !== undefined) {
    if (typeof d.settings !== 'object' || d.settings === null || Array.isArray(d.settings) || JSON.stringify(d.settings).length > 8_000)
      throw new HttpError(400, 'Invalid settings');
    out.settings = d.settings as Record<string, unknown>;
  }
  if (d.watchlist !== undefined) {
    if (!Array.isArray(d.watchlist) || d.watchlist.length > 100 || !d.watchlist.every((m) => typeof m === 'string' && BASE58.test(m)))
      throw new HttpError(400, 'Invalid watchlist');
    out.watchlist = d.watchlist as string[];
  }
  if (d.myTraders !== undefined) {
    if (
      !Array.isArray(d.myTraders) ||
      d.myTraders.length > 40 ||
      !d.myTraders.every(
        (t) => t && typeof t.address === 'string' && BASE58.test(t.address) && typeof t.label === 'string' && t.label.length <= 40,
      )
    )
      throw new HttpError(400, 'Invalid trader list');
    out.myTraders = (d.myTraders as { address: string; label: string }[]).map((t) => ({ address: t.address, label: t.label }));
  }
  if (d.swaps !== undefined) {
    if (!Array.isArray(d.swaps) || d.swaps.length > 100 || JSON.stringify(d.swaps).length > 40_000)
      throw new HttpError(400, 'Invalid trade history');
    out.swaps = d.swaps.filter(
      (s) =>
        s &&
        typeof s.signature === 'string' &&
        BASE58.test(s.signature) &&
        (s.side === 'buy' || s.side === 'sell') &&
        typeof s.mint === 'string' &&
        BASE58.test(s.mint) &&
        typeof s.symbol === 'string' &&
        typeof s.time === 'number' &&
        typeof s.inAmount === 'number' &&
        typeof s.outAmount === 'number',
    );
  }
  return out;
}

// ---------------------------------------------------------------- wallet linking

/** Pending wallet-ownership challenges (single use, 5 minutes). */
const challenges = new Map<string, { message: string; expires: number }>();

function verifyWalletSignature(address: string, message: string, signatureB64: string): boolean {
  try {
    const pub = bs58.decode(address);
    const sig = Buffer.from(signatureB64, 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') }, format: 'jwk' });
    return verifySignature(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- router

type Handler = (req: AuthedRequest, res: Response) => Promise<unknown>;

/** Wrap a handler: turn HttpErrors into JSON responses and hide internal errors. */
export const route =
  (fn: Handler, opts: { auth?: boolean; limit?: boolean } = {}) =>
  async (req: AuthedRequest, res: Response) => {
    try {
      if (!authEnabled) throw new HttpError(503, 'Accounts are not set up on this server yet.');
      if (!ready) throw new HttpError(503, 'Accounts are starting up. Try again in a moment.');
      if (opts.limit) authRateLimit(req);
      await loadSession(req);
      if (opts.auth && !req.user) throw new HttpError(401, 'Please log in.');
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
      if (e instanceof EmailError) return void res.status(503).json({ error: e.message });
      console.error('[auth]', e);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };

/** Block cross-site form posts: state-changing requests must be same-origin JSON. */
export function sameOriginJson(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    if (host !== req.get('host')) return void res.status(403).json({ error: 'Cross-site request blocked' });
  }
  if (!req.is('application/json')) return void res.status(415).json({ error: 'Expected JSON' });
  next();
}

export function authRouter() {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  r.use(sameOriginJson);

  r.get(
    '/auth/me',
    async (req: AuthedRequest, res) => {
      if (!authEnabled) return void res.json({ enabled: false, user: null });
      if (!ready) return void res.status(503).json({ enabled: true, user: null, error: 'Account service starting' });
      try {
        await loadSession(req);
      } catch (e) {
        console.error('[auth] session lookup failed', e);
        return void res.status(503).json({ enabled: true, user: null, error: 'Account service unavailable' });
      }
      if (!req.user) return void res.json({ enabled: true, user: null });
      res.json({ enabled: true, user: toUser(req.user), data: req.user.data ?? {} });
    },
  );

  r.post(
    '/auth/signup',
    route(
      async (req) => {
        const email = normalizeEmail(req.body?.email);
        if (!email) throw new HttpError(400, 'Enter a valid email address.');
        const problem = passwordProblem(req.body?.password, email);
        if (problem) throw new HttpError(400, problem);
        const pool = requireDb();
        const { rows } = await pool.query<UserRow>(`select * from users where email = $1`, [email]);
        const existing = rows[0];
        if (existing?.email_verified_at) {
          // Don't reveal that the account exists; tell the real owner instead.
          const last = noticeSent.get(email) ?? 0;
          if (Date.now() - last > 30 * 60_000) {
            noticeSent.set(email, Date.now());
            await sendAuthEmail(email, 'already-registered').catch(() => undefined);
          }
        } else {
          const hash = await hashPassword(req.body.password);
          // An unverified account can be re-registered: only whoever controls the inbox can finish.
          await pool.query(
            `insert into users (email, password_hash) values ($1, $2)
             on conflict (email) do update set password_hash = excluded.password_hash, updated_at = now()
             where users.email_verified_at is null`,
            [email, hash],
          );
          await issueCode(email, 'verify');
        }
        return { ok: true, next: 'verify' };
      },
      { limit: true },
    ),
  );

  r.post(
    '/auth/verify',
    route(
      async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        if (!email) throw new HttpError(400, 'Enter a valid email address.');
        await consumeCode(email, 'verify', req.body?.code);
        const pool = requireDb();
        const { rows } = await pool.query<UserRow>(
          `update users set email_verified_at = coalesce(email_verified_at, now()), failed_logins = 0, locked_until = null, updated_at = now()
           where email = $1 returning *`,
          [email],
        );
        const user = rows[0];
        if (!user) throw new HttpError(400, 'That code is incorrect or has expired.');
        await startSession(req, res, user.id);
        return { user: toUser(user), data: user.data ?? {} };
      },
      { limit: true },
    ),
  );

  r.post(
    '/auth/resend',
    route(
      async (req) => {
        const email = normalizeEmail(req.body?.email);
        const purpose = req.body?.purpose === 'reset' ? 'reset' : 'verify';
        if (!email) throw new HttpError(400, 'Enter a valid email address.');
        const { rows } = await requireDb().query<UserRow>(`select * from users where email = $1`, [email]);
        const u = rows[0];
        if (u && (purpose === 'verify' ? !u.email_verified_at : Boolean(u.email_verified_at))) await issueCode(email, purpose);
        return { ok: true };
      },
      { limit: true },
    ),
  );

  r.post(
    '/auth/login',
    route(
      async (req, res) => {
        const generic = new HttpError(401, 'Email or password is incorrect.');
        const email = normalizeEmail(req.body?.email);
        const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
        if (!email || !password) throw generic;
        const pool = requireDb();
        const { rows } = await pool.query<UserRow>(`select * from users where email = $1`, [email]);
        const user = rows[0];
        if (!user) {
          await verifyPassword(password, await dummyHash()); // same timing as a real check
          throw generic;
        }
        if (user.locked_until && user.locked_until.getTime() > Date.now()) {
          const mins = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
          throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.`);
        }
        if (!(await verifyPassword(password, user.password_hash))) {
          const fails = user.failed_logins + 1;
          await pool.query(
            fails >= MAX_FAILED_LOGINS
              ? `update users set failed_logins = 0, locked_until = now() + make_interval(mins => ${LOCK_MINUTES}) where id = $1`
              : `update users set failed_logins = failed_logins + 1 where id = $1`,
            [user.id],
          );
          throw generic;
        }
        await pool.query(`update users set failed_logins = 0, locked_until = null where id = $1`, [user.id]);
        if (!user.email_verified_at) {
          await issueCode(email, 'verify');
          return { ok: true, next: 'verify' };
        }
        await startSession(req, res, user.id);
        return { user: toUser(user), data: user.data ?? {} };
      },
      { limit: true },
    ),
  );

  r.post(
    '/auth/logout',
    route(async (req, res) => {
      if (req.sessionHash) await requireDb().query(`delete from sessions where token_hash = $1`, [req.sessionHash]);
      clearSessionCookie(req, res);
      return { ok: true };
    }),
  );

  r.post(
    '/auth/logout-all',
    route(
      async (req, res) => {
        await requireDb().query(`delete from sessions where user_id = $1`, [req.user!.id]);
        clearSessionCookie(req, res);
        return { ok: true };
      },
      { auth: true },
    ),
  );

  r.post(
    '/auth/forgot',
    route(
      async (req) => {
        const email = normalizeEmail(req.body?.email);
        if (!email) throw new HttpError(400, 'Enter a valid email address.');
        const { rows } = await requireDb().query<UserRow>(`select * from users where email = $1`, [email]);
        if (rows[0]?.email_verified_at) await issueCode(email, 'reset');
        return { ok: true }; // same answer whether or not the account exists
      },
      { limit: true },
    ),
  );

  r.post(
    '/auth/reset',
    route(
      async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        if (!email) throw new HttpError(400, 'Enter a valid email address.');
        const problem = passwordProblem(req.body?.password, email);
        if (problem) throw new HttpError(400, problem);
        await consumeCode(email, 'reset', req.body?.code);
        const pool = requireDb();
        const hash = await hashPassword(req.body.password);
        const { rows } = await pool.query<UserRow>(
          `update users set password_hash = $2, failed_logins = 0, locked_until = null,
             email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
           where email = $1 returning *`,
          [email, hash],
        );
        const user = rows[0];
        if (!user) throw new HttpError(400, 'That code is incorrect or has expired.');
        // A reset signs out every device, in case the old password was compromised.
        await pool.query(`delete from sessions where user_id = $1`, [user.id]);
        await startSession(req, res, user.id);
        return { user: toUser(user), data: user.data ?? {} };
      },
      { limit: true },
    ),
  );

  r.post(
    '/auth/password',
    route(
      async (req) => {
        const user = req.user!;
        const current = typeof req.body?.current === 'string' ? req.body.current : '';
        if (!(await verifyPassword(current, user.password_hash))) throw new HttpError(400, 'Your current password is incorrect.');
        const problem = passwordProblem(req.body?.next, user.email);
        if (problem) throw new HttpError(400, problem);
        const pool = requireDb();
        await pool.query(`update users set password_hash = $2, updated_at = now() where id = $1`, [
          user.id,
          await hashPassword(req.body.next),
        ]);
        // Keep this device signed in; sign out all others.
        await pool.query(`delete from sessions where user_id = $1 and token_hash <> $2`, [user.id, req.sessionHash]);
        return { ok: true };
      },
      { auth: true, limit: true },
    ),
  );

  r.post(
    '/auth/delete',
    route(
      async (req, res) => {
        const user = req.user!;
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(400, 'Password is incorrect.');
        const pool = requireDb();
        await pool.query(`delete from users where id = $1`, [user.id]);
        for (const fn of userDeletedListeners) await fn(user.id);
        await pool.query(`delete from email_codes where email = $1`, [user.email]);
        clearSessionCookie(req, res);
        return { ok: true };
      },
      { auth: true, limit: true },
    ),
  );

  r.put(
    '/account/data',
    route(
      async (req) => {
        const data = cleanData(req.body?.data);
        const merged = { ...(req.user!.data ?? {}), ...data };
        await requireDb().query(`update users set data = $2, updated_at = now() where id = $1`, [req.user!.id, merged]);
        return { ok: true };
      },
      { auth: true },
    ),
  );

  r.post(
    '/account/wallet/challenge',
    route(
      async (req) => {
        const nonce = randomBytes(16).toString('hex');
        const message =
          'MemeRadar: link this wallet to my account.\n\n' +
          'This signature only proves I own this wallet. It cannot move funds or approve any transaction.\n\n' +
          `Account: ${req.user!.email}\nSite: ${req.get('host')}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
        challenges.set(req.user!.id, { message, expires: Date.now() + 5 * 60_000 });
        return { message };
      },
      { auth: true },
    ),
  );

  r.post(
    '/account/wallet',
    route(
      async (req) => {
        const address = req.body?.address;
        const signature = req.body?.signature;
        const challenge = challenges.get(req.user!.id);
        challenges.delete(req.user!.id); // single use
        if (!challenge || challenge.expires < Date.now()) throw new HttpError(400, 'The request expired. Try linking again.');
        if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || typeof signature !== 'string')
          throw new HttpError(400, 'Invalid wallet or signature.');
        if (!verifyWalletSignature(address, challenge.message, signature))
          throw new HttpError(400, "That signature doesn't match the wallet. Nothing was linked.");
        await requireDb().query(`update users set wallet_address = $2, updated_at = now() where id = $1`, [req.user!.id, address]);
        return { ok: true, wallet: address };
      },
      { auth: true, limit: true },
    ),
  );

  r.delete(
    '/account/wallet',
    route(
      async (req) => {
        await requireDb().query(`update users set wallet_address = null, updated_at = now() where id = $1`, [req.user!.id]);
        return { ok: true };
      },
      { auth: true },
    ),
  );

  return r;
}

/** Resolves true once accounts are usable (false if they're switched off on this server). */
export async function startAuth(): Promise<boolean> {
  if (!db) {
    console.log('[auth] no DATABASE_URL: accounts disabled');
    return false;
  }
  if (!emailReady) {
    console.log('[auth] no SMTP settings: accounts disabled until email is configured');
    return false;
  }
  // Retry until the database is reachable (Neon can take a moment to wake up).
  for (let attempt = 1; !ready; attempt++) {
    try {
      await migrate();
      ready = true;
    } catch (e) {
      console.error(`[auth] database not ready (attempt ${attempt}):`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, Math.min(60_000, 5_000 * attempt)));
    }
  }
  console.log(`[auth] accounts enabled${config.smtp.user ? '' : ' (dev mode: emails are printed to this console)'}`);
  // Twice a day is plenty, and lets the free database sleep in between.
  setInterval(() => void cleanup().catch((e) => console.error('[auth] cleanup', e)), 12 * 3_600_000).unref();
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [email, at] of noticeSent) if (at < cutoff) noticeSent.delete(email);
  }, 10 * 60_000).unref();
  return true;
}
