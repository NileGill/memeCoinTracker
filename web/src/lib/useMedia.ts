import { useEffect, useState } from 'react';

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    // "change" isn't fired reliably on every browser/emulator when rotating or resizing, so also re-check on resize.
    mq.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      mq.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [query]);
  return matches;
}

/** Phone-sized screens: compact header search, card leaderboard. */
export const useIsPhone = () => useMedia('(max-width: 700px)');

/** Below laptop width the coin tables can't fit their columns, so they become cards. */
export const useCompactLists = () => useMedia('(max-width: 1199px)');
