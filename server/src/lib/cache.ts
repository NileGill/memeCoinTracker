import { db } from '../auth/db';

/*
 * Warm-restart cache. Free hosting restarts the server on every deploy, which used to mean
 * a minute of empty pages while data refilled. Each module registers what it wants kept;
 * everything is written to Postgres once at shutdown and read back at startup.
 * (Writing only at shutdown keeps the free database asleep the rest of the time.)
 */

interface Persisted {
  key: string;
  dump: () => unknown;
  restore: (value: unknown) => void;
}

const registry: Persisted[] = [];
let tableReady = false;

export function registerPersisted(key: string, dump: () => unknown, restore: (value: unknown) => void) {
  registry.push({ key, dump, restore });
}

async function ensureTable(): Promise<boolean> {
  if (!db) return false;
  if (tableReady) return true;
  await db.query(
    `create table if not exists kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`,
  );
  tableReady = true;
  return true;
}

export async function kvGet<T>(key: string, maxAgeMs = Infinity): Promise<T | null> {
  if (!(await ensureTable())) return null;
  const { rows } = await db!.query<{ value: T; updated_at: Date }>(`select value, updated_at from kv where key = $1`, [key]);
  const row = rows[0];
  if (!row || Date.now() - row.updated_at.getTime() > maxAgeMs) return null;
  return row.value;
}

export async function kvSet(key: string, value: unknown) {
  if (!(await ensureTable())) return;
  await db!.query(
    `insert into kv (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);

/** Restore everything saved by the previous run (if recent enough to still be useful). */
export async function restoreAll(maxAgeMs = 6 * 3_600_000) {
  if (!db) return;
  const started = Date.now();
  try {
    await withTimeout(
      (async () => {
        for (const p of registry) {
          const value = await kvGet(`warm:${p.key}`, maxAgeMs);
          if (value !== null) p.restore(value);
        }
      })(),
      10_000,
    );
    console.log(`[cache] restored previous state in ${Date.now() - started}ms`);
  } catch (e) {
    console.warn('[cache] restore skipped:', e instanceof Error ? e.message : e);
  }
}

/** Save everything; called on shutdown. */
export async function persistAll() {
  if (!db) return;
  const started = Date.now();
  try {
    await withTimeout(
      (async () => {
        for (const p of registry) await kvSet(`warm:${p.key}`, p.dump());
      })(),
      12_000,
    );
    console.log(`[cache] saved state in ${Date.now() - started}ms`);
  } catch (e) {
    console.warn('[cache] save failed:', e instanceof Error ? e.message : e);
  }
}
