import { fetchJson, Limiter } from '../lib/http';

const limiter = new Limiter(600);

interface Summary {
  score_normalised?: number;
  risks?: { name: string; level: string; description: string; value?: string }[];
  lpLockedPct?: number;
}

/** RugCheck's summary report. Lower normalised score = fewer detected risks. */
export async function rugcheckSummary(mint: string) {
  const s = await fetchJson<Summary>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
    limiter,
    timeoutMs: 8_000,
  });
  return {
    score: typeof s.score_normalised === 'number' ? s.score_normalised : null,
    risks: (s.risks ?? []).map((r) => ({ name: r.name, level: r.level, description: r.description })),
    lpLockedPct: typeof s.lpLockedPct === 'number' ? s.lpLockedPct : null,
  };
}

/**
 * Whether a coin's pool liquidity can be pulled by its creator. RugCheck flags pools whose LP tokens
 * are mostly unlocked ("Large Amount of LP Unlocked": the owner can remove the liquidity at any
 * point). On 2026-10-03 the freshly launched coins the AI kept picking carried this flag (100% of LP
 * unlocked) and nearly all had their pools emptied within hours, while pump.fun graduates show their
 * LP 100% locked (burned). Checked on first ask and cached; 'checking' until the answer arrives,
 * 'unknown' if RugCheck didn't answer.
 */
export type LpSafety = 'safe' | 'pullable' | 'checking' | 'unknown';
const LP_TTL_MS = 20 * 60_000;
const LP_RETRY_MS = 2 * 60_000;
const lpCache = new Map<string, { at: number; value: LpSafety }>();

export function lpSafety(mint: string): LpSafety {
  const now = Date.now();
  const hit = lpCache.get(mint);
  if (hit && (hit.value === 'checking' || now - hit.at < (hit.value === 'unknown' ? LP_RETRY_MS : LP_TTL_MS))) return hit.value;
  lpCache.set(mint, { at: now, value: 'checking' });
  void rugcheckSummary(mint)
    .then((s) => {
      const pullable = s.risks.some((r) => /lp unlocked/i.test(r.name) && r.level === 'danger');
      lpCache.set(mint, { at: Date.now(), value: pullable ? 'pullable' : 'safe' });
    })
    .catch(() => lpCache.set(mint, { at: Date.now(), value: 'unknown' }));
  if (lpCache.size > 2_000) for (const [m, v] of lpCache) if (now - v.at > LP_TTL_MS) lpCache.delete(m);
  return 'checking';
}
