import type { AccountData, AuthUser, MeResponse } from '../../../shared/types';
import { adoptAccountData, collectAccountData, myTradersListeners, useStore } from '../store';
import { restartStream } from './stream';

/** JSON request to the account API. All state-changing calls are same-origin JSON (CSRF-safe). */
export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    if (res.status === 401 && useStore.getState().auth.status === 'user' && path !== '/auth/login') signedOut();
    throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

type SessionResult = { user: AuthUser; data: AccountData } | { ok: true; next: 'verify' };

export const authApi = {
  signup: (email: string, password: string) => call<{ ok: true; next: 'verify' }>('POST', '/auth/signup', { email, password }),
  verify: (email: string, code: string) => call<{ user: AuthUser; data: AccountData }>('POST', '/auth/verify', { email, code }),
  resend: (email: string, purpose: 'verify' | 'reset') => call('POST', '/auth/resend', { email, purpose }),
  login: (email: string, password: string) => call<SessionResult>('POST', '/auth/login', { email, password }),
  forgot: (email: string) => call('POST', '/auth/forgot', { email }),
  reset: (email: string, code: string, password: string) =>
    call<{ user: AuthUser; data: AccountData }>('POST', '/auth/reset', { email, code, password }),
  changePassword: (current: string, next: string) => call('POST', '/auth/password', { current, next }),
  logout: () => call('POST', '/auth/logout'),
  logoutAll: () => call('POST', '/auth/logout-all'),
  deleteAccount: (password: string) => call('POST', '/auth/delete', { password }),
  walletChallenge: () => call<{ message: string }>('POST', '/account/wallet/challenge'),
  linkWallet: (address: string, signature: string) => call<{ wallet: string }>('POST', '/account/wallet', { address, signature }),
  unlinkWallet: () => call('DELETE', '/account/wallet'),
};

// ---------------------------------------------------------------- session state

let syncing = false; // true while applying account data, so it isn't immediately saved back

/** A successful login / verification / reset: merge this browser's data with the account's. */
export function signedIn(user: AuthUser, data: AccountData) {
  const wasGuest = useStore.getState().auth.status === 'guest';
  syncing = true;
  adoptAccountData(data);
  syncing = false;
  useStore.setState({ auth: { status: 'user', user }, authModal: null });
  scheduleSave(0); // upload anything this browser had that the account didn't
  // Just logged in: reconnect so this tab receives the account's private updates (paper bot).
  if (wasGuest) restartStream();
}

export function signedOut() {
  const wasUser = useStore.getState().auth.status === 'user';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  useStore.setState({ auth: { status: 'guest', user: null }, bot: null });
  if (wasUser) restartStream();
}

export function setLinkedWallet(wallet: string | null) {
  const { auth } = useStore.getState();
  if (auth.user) useStore.setState({ auth: { ...auth, user: { ...auth.user, wallet } } });
}

/** On page load: find out whether accounts are enabled and who (if anyone) is logged in. */
export async function initAuth() {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const me = (await res.json()) as MeResponse;
      if (!me.enabled) return void useStore.setState({ auth: { status: 'disabled', user: null } });
      if (res.ok) {
        if (me.user) signedIn(me.user, me.data ?? {});
        else signedOut();
        return;
      }
    } catch {
      /* server waking up */
    }
    await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
  }
  useStore.setState({ auth: { status: 'disabled', user: null } });
}

// ---------------------------------------------------------------- saving changes to the account

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(delay = 1_500) {
  if (syncing || useStore.getState().auth.status !== 'user') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await call('PUT', '/account/data', { data: collectAccountData() });
    } catch (e) {
      console.warn('[account] save failed:', (e as Error).message);
    }
  }, delay);
}

// Save when settings, watchlist, trade history or saved traders change.
useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings || s.watchlist !== prev.watchlist || s.swaps !== prev.swaps) scheduleSave();
});
myTradersListeners.add(() => scheduleSave());
