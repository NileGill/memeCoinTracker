import type { PaperAccountView, PaperSettings } from '../../../shared/types';
import { useStore } from '../store';
import { call } from './auth';

type Reply = { account: PaperAccountView | null };

async function apply(p: Promise<Reply>) {
  const r = await p;
  useStore.setState({ bot: r.account });
  return r.account;
}

/** The logged-in user's paper trading bot (runs on the server around the clock). */
export const botApi = {
  load: () => apply(call<Reply>('GET', '/bot')),
  start: (startBalance: number, settings?: Partial<PaperSettings>) => apply(call<Reply>('POST', '/bot/start', { startBalance, settings })),
  settings: (settings: Partial<PaperSettings>) => apply(call<Reply>('PUT', '/bot/settings', { settings })),
  close: (positionId: string) => apply(call<Reply>('POST', '/bot/close', { positionId })),
  remove: async () => {
    await call('DELETE', '/bot');
    useStore.setState({ bot: null });
  },
};
