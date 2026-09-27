import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { kvGet, kvSet } from './cache';

export interface StoredTrader {
  address: string;
  label: string;
  source: 'manual' | 'kolscan';
  addedAt: number;
  alerts: boolean;
}

interface State {
  version: 1;
  traders: StoredTrader[];
  /** True once the trader list has been created, so an emptied list is not re-seeded. */
  tradersInitialised: boolean;
}

const FILE = path.join(config.dataDir, 'state.json');

function load(): State {
  const empty: State = { version: 1, traders: [], tradersInitialised: false };
  if (!existsSync(FILE)) return empty;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<State>;
    return {
      version: 1,
      traders: Array.isArray(raw.traders) ? raw.traders : [],
      tradersInitialised: Boolean(raw.tradersInitialised),
    };
  } catch (e) {
    // Keep the unreadable file for inspection rather than overwriting the user's lists.
    const backup = `${FILE}.corrupt-${Date.now()}`;
    renameSync(FILE, backup);
    console.error(`[store] state.json was unreadable, moved to ${backup}:`, e);
    return empty;
  }
}

export const state: State = load();

let saveTimer: NodeJS.Timeout | null = null;

let dbTimer: NodeJS.Timeout | null = null;

export function save() {
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 250);
  }
  // Hosting disks are wiped on every deploy, so the trader list also lives in the database.
  // Written only when it changes, so the free database can stay asleep otherwise.
  if (!dbTimer) {
    dbTimer = setTimeout(() => {
      dbTimer = null;
      kvSet('state', state).catch((e) => console.warn('[store] database save failed:', e instanceof Error ? e.message : e));
    }, 2_000);
  }
}

/** At startup, prefer the copy in the database (the local file doesn't survive deploys). */
export async function restoreState() {
  try {
    const saved = await kvGet<Partial<State>>('state');
    if (!saved) return;
    if (Array.isArray(saved.traders)) state.traders = saved.traders;
    state.tradersInitialised = Boolean(saved.tradersInitialised);
  } catch (e) {
    console.warn('[store] could not load saved traders:', e instanceof Error ? e.message : e);
  }
}

export function saveNow() {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}
