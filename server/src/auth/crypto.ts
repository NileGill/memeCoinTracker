import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt with N=2^16, r=8, p=1: ~64 MB and ~100-200 ms per hash, which makes offline guessing
// of leaked hashes very expensive. At most two hashes run at once to bound memory use.
const N = 2 ** 16;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 160 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Format: scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await withSlot(() => scryptAsync(password, salt, { N, r: R, p: P, maxmem: MAXMEM }));
  return `scrypt$${Math.log2(N)}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await withSlot(() =>
    scryptAsync(password, Buffer.from(saltB64, 'base64'), {
      N: 2 ** Number(logN),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    }),
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A real hash of a random password, used so failed logins for unknown emails take the same time. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** 256-bit random session token (only its SHA-256 is stored). */
export const newSessionToken = () => randomBytes(32).toString('base64url');

/** Uniformly random 6-digit code. */
export const newCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

export const hashCode = (purpose: string, email: string, code: string) => sha256(`${purpose}|${email}|${code}`);

// ---------------------------------------------------------------- input validation

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

const COMMON = new Set([
  'password12', 'password123', 'password1234', '1234567890', '12345678910', 'qwertyuiop', 'qwerty1234',
  'iloveyou12', 'abcdefghij', 'abc1234567', '0987654321', '1q2w3e4r5t', 'passw0rd12', 'welcome123',
  'letmein123', 'football12', 'baseball12', 'princess12', 'sunshine12', 'dragon1234', 'monkey1234',
  'solana1234', 'bitcoin123', 'memecoin12', 'memeradar1', 'memeradar12', 'phantom123',
]);

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (/^(.)\1+$/.test(password)) return 'That password is too easy to guess.';
  if (COMMON.has(password.toLowerCase())) return 'That password is too common. Pick something less guessable.';
  if (email && password.toLowerCase().includes(email.split('@')[0]) && email.split('@')[0].length >= 4)
    return "Don't use your email address in your password.";
  return null;
}
