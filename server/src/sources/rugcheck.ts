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
