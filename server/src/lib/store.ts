import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface StoredTrader {
  address: string;
  label: string;
  source: 'manual' | 'kolscan';
  addedAt: number;
  alerts: boolean;
}

export interface StoredWatch {
  mint: string;
  addedAt: number;
}

interface State {
  version: 1;
  traders: StoredTrader[];
  watchlist: StoredWatch[];
  /** True once the trader list has been created, so an emptied list is not re-seeded. */
  tradersInitialised: boolean;
}

const FILE = path.join(config.dataDir, 'state.json');

function load(): State {
  const empty: State = { version: 1, traders: [], watchlist: [], tradersInitialised: false };
  if (!existsSync(FILE)) return empty;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<State>;
    return {
      version: 1,
      traders: Array.isArray(raw.traders) ? raw.traders : [],
      watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : [],
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

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 250);
}

export function saveNow() {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}
