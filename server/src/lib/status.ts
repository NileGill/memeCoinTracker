import type { SourceStatus } from '../../../shared/types';
import { errMessage } from './http';

const sources = new Map<string, SourceStatus>();

export function registerSource(id: string, label: string) {
  if (!sources.has(id)) {
    sources.set(id, { id, label, ok: false, lastOk: null, lastError: null, lastErrorAt: null });
  }
}

export function markOk(id: string) {
  const s = sources.get(id);
  if (!s) return;
  s.ok = true;
  s.lastOk = Date.now();
}

export function markError(id: string, e: unknown) {
  const s = sources.get(id);
  if (!s) return;
  s.lastError = errMessage(e);
  s.lastErrorAt = Date.now();
  // A single failure after recent success is treated as a blip; stay green for 2 minutes.
  s.ok = s.lastOk !== null && Date.now() - s.lastOk < 120_000;
  console.warn(`[${id}] ${s.lastError}`);
}

export function allStatus(): SourceStatus[] {
  return [...sources.values()].map((s) => ({ ...s }));
}
