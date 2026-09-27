import pg from 'pg';
import { config } from '../config';

/** Postgres pool, or null when no DATABASE_URL is set (accounts are then disabled). */
export const db: pg.Pool | null = config.databaseUrl
  ? new pg.Pool({
      connectionString: strictSsl(config.databaseUrl),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    })
  : null;

db?.on('error', (e) => console.error('[db] idle connection error:', e.message));

/** Always verify the server certificate (Neon URLs say sslmode=require). */
function strictSsl(url: string): string {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca') u.searchParams.set('sslmode', 'verify-full');
    return u.toString();
  } catch {
    return url;
  }
}

export function requireDb(): pg.Pool {
  if (!db) throw new Error('Accounts are not configured on this server');
  return db;
}

export async function migrate() {
  await requireDb().query(`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      password_hash text not null,
      email_verified_at timestamptz,
      failed_logins int not null default 0,
      locked_until timestamptz,
      wallet_address text,
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists sessions (
      token_hash text primary key,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      last_seen_at timestamptz not null default now(),
      user_agent text,
      ip text
    );
    create index if not exists sessions_user_idx on sessions (user_id);

    create table if not exists email_codes (
      id bigserial primary key,
      email text not null,
      purpose text not null,
      code_hash text not null,
      attempts int not null default 0,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    );
    create index if not exists email_codes_lookup_idx on email_codes (email, purpose, created_at desc);
  `);
}

/** Remove expired sessions and old codes. */
export async function cleanup() {
  const pool = requireDb();
  await pool.query(`delete from sessions where expires_at < now()`);
  await pool.query(`delete from email_codes where created_at < now() - interval '2 days'`);
}
