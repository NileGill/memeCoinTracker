// The Solana library is large, so it's only downloaded when you actually trade.
import type { VersionedTransaction } from '@solana/web3.js';
import type { UltraExecuteResult, UltraOrder } from '../../../shared/types';
import { setWallet, useStore } from '../store';
import { api } from './api';
import { authApi, setLinkedWallet } from './auth';

interface PublicKeyLike {
  toString(): string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PublicKeyLike | null;
  isConnected: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKeyLike }>;
  disconnect(): Promise<void>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array; publicKey: PublicKeyLike }>;
  on(event: 'connect' | 'disconnect' | 'accountChanged', handler: (arg?: unknown) => void): void;
}

export function getPhantom(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  return p?.isPhantom ? p : null;
}

export const PHANTOM_DOWNLOAD = 'https://phantom.com/download';

/** Phones have no browser extensions; this link reopens the site inside the Phantom app's browser. */
export function phantomAppLink(): string | null {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!mobile || location.protocol !== 'https:') return null;
  return `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
}

function errorText(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return 'Request cancelled in Phantom.';
  if (err?.code === -32002) return 'Phantom already has a pending request. Open the Phantom extension.';
  return err?.message || String(e);
}

let holdingsTimer: number | null = null;

export async function refreshHoldings() {
  const address = useStore.getState().wallet.address;
  if (!address) return;
  try {
    const holdings = await api.holdings(address);
    if (useStore.getState().wallet.address === address) setWallet({ holdings, holdingsError: null });
  } catch (e) {
    setWallet({ holdingsError: errorText(e) });
  }
}

function onConnected(address: string) {
  const prev = useStore.getState().wallet.address;
  setWallet({ address, connecting: false, holdings: prev === address ? useStore.getState().wallet.holdings : null });
  void refreshHoldings();
  if (holdingsTimer) window.clearInterval(holdingsTimer);
  holdingsTimer = window.setInterval(() => {
    if (!document.hidden) void refreshHoldings();
  }, 20_000);
}

function onDisconnected() {
  if (holdingsTimer) window.clearInterval(holdingsTimer);
  holdingsTimer = null;
  setWallet({ address: null, connecting: false, holdings: null, holdingsError: null });
}

let initialised = false;

/** Detect Phantom, reconnect silently if the site was approved before, and follow account switches. */
export function initWallet() {
  if (initialised) return;
  initialised = true;
  let tries = 0;
  const detect = () => {
    const p = getPhantom();
    if (!p) {
      if (++tries < 12) window.setTimeout(detect, 250);
      return;
    }
    setWallet({ available: true });
    p.on('connect', (pk) => {
      const key = (pk as PublicKeyLike | undefined) ?? p.publicKey;
      if (key) onConnected(key.toString());
    });
    p.on('disconnect', () => onDisconnected());
    p.on('accountChanged', (pk) => {
      if (pk) onConnected((pk as PublicKeyLike).toString());
      else p.connect({ onlyIfTrusted: true }).catch(() => onDisconnected());
    });
    p.connect({ onlyIfTrusted: true })
      .then((r) => onConnected(r.publicKey.toString()))
      .catch(() => {
        /* not approved yet: user connects manually */
      });
  };
  detect();
}

export async function connectWallet(): Promise<string> {
  const p = getPhantom();
  if (!p) {
    const appLink = phantomAppLink();
    if (appLink) {
      window.location.href = appLink;
      throw new Error('Opening this site in the Phantom app…');
    }
    window.open(PHANTOM_DOWNLOAD, '_blank', 'noopener');
    throw new Error('Phantom is not installed. Install it, then reload this page.');
  }
  setWallet({ connecting: true });
  try {
    const r = await p.connect();
    const address = r.publicKey.toString();
    onConnected(address);
    return address;
  } catch (e) {
    setWallet({ connecting: false });
    throw new Error(errorText(e));
  }
}

export async function disconnectWallet() {
  const p = getPhantom();
  try {
    await p?.disconnect();
  } finally {
    onDisconnected();
  }
}

// ------------------------------------------------------------------ swaps

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export interface SwapExpectation {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
}

/**
 * Check the order matches what the user asked for, have Phantom sign it (the user approves
 * in the Phantom popup), then let Jupiter land it. Keys never leave Phantom.
 */
export async function signAndExecute(order: UltraOrder, expect: SwapExpectation): Promise<UltraExecuteResult> {
  const p = getPhantom();
  if (!p) throw new Error('Phantom is not available.');
  if (!p.publicKey || p.publicKey.toString() !== expect.taker) throw new Error('The connected Phantom account changed. Reconnect and try again.');
  if (!order.transaction) throw new Error(order.errorMessage || order.error || 'Jupiter did not return a transaction for this trade.');
  if (order.inputMint !== expect.inputMint || order.outputMint !== expect.outputMint || order.inAmount !== expect.amount)
    throw new Error('The quote does not match the trade you entered. Nothing was signed.');

  const { VersionedTransaction } = await import('@solana/web3.js');
  const tx = VersionedTransaction.deserialize(b64ToBytes(order.transaction));
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (!signers.includes(expect.taker))
    throw new Error('This transaction is not for your connected wallet. Nothing was signed.');

  let signed: VersionedTransaction;
  try {
    signed = await p.signTransaction(tx);
  } catch (e) {
    throw new Error(errorText(e));
  }
  return api.execute(bytesToB64(signed.serialize()), order.requestId);
}

// ------------------------------------------------------------------ link wallet to account

/**
 * Prove this Phantom wallet belongs to the logged-in user: the server issues a one-time message,
 * Phantom signs it (a plain message, not a transaction: it cannot move funds), the server checks
 * the signature and saves the public address. No key ever leaves Phantom.
 */
export async function linkPhantomWallet(): Promise<string> {
  let address = useStore.getState().wallet.address;
  if (!address) address = await connectWallet();
  const p = getPhantom();
  if (!p) throw new Error('Phantom is not available.');
  const { message } = await authApi.walletChallenge();
  let signature: Uint8Array;
  try {
    ({ signature } = await p.signMessage(new TextEncoder().encode(message), 'utf8'));
  } catch (e) {
    throw new Error(errorText(e));
  }
  const { wallet } = await authApi.linkWallet(address, bytesToB64(signature));
  setLinkedWallet(wallet);
  return wallet;
}
