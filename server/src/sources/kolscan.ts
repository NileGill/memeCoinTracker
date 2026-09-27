import type { KolEntry } from '../../../shared/types';
import { fetchText } from '../lib/http';
import { decodeEntities } from './news';

/**
 * Kolscan publishes a daily leaderboard of the most profitable memecoin traders (KOLs).
 * The page is server-rendered, so we read name / wallet / wins / losses / profit from the HTML.
 * If the layout changes this returns [] and the UI falls back to manual wallets.
 */
export async function fetchKolLeaderboard(): Promise<KolEntry[]> {
  const html = await fetchText('https://kolscan.io/leaderboard', { timeoutMs: 20_000 });
  return parseKolscan(html);
}

export function parseKolscan(html: string): KolEntry[] {
  const re = /href="\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\?[^"]*)?"/g;
  const seen = new Map<string, KolEntry>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const address = m[1];
    if (seen.has(address)) continue;
    const text = decodeEntities(
      html
        .slice(m.index + m[0].length, m.index + m[0].length + 2500)
        .replace(/<[^>]+>/g, ' '),
    )
      .replace(/\s+/g, ' ')
      .replace(/^\s*>\s*/, '');
    // Rows read: "<name> <first 6 chars of wallet> <wins> / <losses> +<profit> Sol ( $<usd> )"
    const short = address.slice(0, 6);
    const at = text.indexOf(` ${short} `);
    if (at < 0) continue;
    const name = text.slice(0, at).trim();
    const rest = text.slice(at + short.length + 2);
    const r = /^(\d+)\s*\/\s*(\d+)\s+([+-]?[\d,]*\.?\d+)\s*Sol\s*\(\s*(-?)\$([\d,]*\.?\d+)\s*\)/i.exec(rest);
    if (!r || !name) continue;
    seen.set(address, {
      rank: seen.size + 1,
      address,
      name: name.slice(0, 40),
      wins: Number(r[1]),
      losses: Number(r[2]),
      profitSol: parseFloat(r[3].replace(/,/g, '')),
      profitUsd: (r[4] ? -1 : 1) * parseFloat(r[5].replace(/,/g, '')),
    });
  }
  return [...seen.values()];
}
