import { useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { CopyButton } from '../components/common';
import { authApi, setLinkedWallet, signedOut } from '../lib/auth';
import { shortAddr } from '../lib/format';
import { getPhantom, linkPhantomWallet, PHANTOM_DOWNLOAD } from '../lib/phantom';
import { useStore } from '../store';
import { PageTitle } from './shared';

function Section({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h2>
          <Icon name={icon} size={15} /> {title}
        </h2>
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const note = msg && <div className={`notice ${msg.ok ? 'green' : 'red'}`}>{msg.text}</div>;
  return { busy, run, note };
}

function WalletSection() {
  const user = useStore((s) => s.auth.user)!;
  const connected = useStore((s) => s.wallet.address);
  const { busy, run, note } = useAction();
  const hasPhantom = Boolean(getPhantom());

  return (
    <Section icon="wallet" title="Phantom wallet">
      {user.wallet ? (
        <>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="badge green">
              <Icon name="check" size={11} /> Linked
            </span>
            <span className="mono">{shortAddr(user.wallet, 8)}</span>
            <CopyButton text={user.wallet} />
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Your portfolio shows this wallet whenever you're logged in. To trade you still connect Phantom, and every trade
            needs your approval there.
          </p>
          {connected && connected !== user.wallet && (
            <div className="notice amber">
              Phantom is connected to a different wallet ({shortAddr(connected)}). Link it to replace the saved one.
            </div>
          )}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {connected && connected !== user.wallet && (
              <button className="btn primary sm" disabled={busy} onClick={() => run(async () => `Linked ${shortAddr(await linkPhantomWallet())}.`)}>
                Link connected wallet instead
              </button>
            )}
            <button
              className="btn sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await authApi.unlinkWallet();
                  setLinkedWallet(null);
                  return 'Wallet unlinked from your account.';
                })
              }
            >
              Unlink
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Link your Phantom wallet so your account remembers it. Phantom will ask you to <b>sign a message</b>. That only
            proves the wallet is yours: it is not a transaction and cannot move funds. Only your public address is saved.
          </p>
          {hasPhantom ? (
            <button
              className="btn primary"
              style={{ alignSelf: 'flex-start' }}
              disabled={busy}
              onClick={() => run(async () => `Linked ${shortAddr(await linkPhantomWallet())} to your account.`)}
            >
              <Icon name="wallet" size={15} /> {busy ? 'Waiting for Phantom…' : 'Link Phantom wallet'}
            </button>
          ) : (
            <a className="btn primary" style={{ alignSelf: 'flex-start' }} href={PHANTOM_DOWNLOAD} target="_blank" rel="noreferrer">
              Install Phantom
            </a>
          )}
        </>
      )}
      {note}
      <div className="notice" style={{ fontSize: 12.5 }}>
        <b>Stay safe:</b> MemeRadar will never ask for your seed phrase (the 12 or 24 secret words) or private key. Anyone
        who asks for them, including a site that looks like this one, is trying to steal your wallet.
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, run, note } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (next !== confirm) throw new Error("The new passwords don't match.");
      await authApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      return 'Password changed. Other devices have been signed out.';
    });
  };
  return (
    <Section icon="shield" title="Password">
      <form className="col" style={{ gap: 10, maxWidth: 420 }} onSubmit={submit}>
        <label className="field">
          Current password
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="field">
          New password <span className="dim">(at least 10 characters)</span>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required maxLength={128} />
        </label>
        <label className="field">
          Confirm new password
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required maxLength={128} />
        </label>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
      {note}
    </Section>
  );
}

function SessionsSection() {
  const { busy, run, note } = useAction();
  const [deleting, setDeleting] = useState(false);
  const [pw, setPw] = useState('');
  return (
    <Section icon="logout" title="Sessions & account">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await authApi.logoutAll();
              signedOut();
              location.hash = '#/';
            })
          }
        >
          Log out on all devices
        </button>
        <button className="btn ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleting((d) => !d)}>
          Delete account…
        </button>
      </div>
      {deleting && (
        <form
          className="notice red col"
          style={{ gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await authApi.deleteAccount(pw);
              signedOut();
              location.hash = '#/';
            });
          }}
        >
          <b>Delete your account permanently?</b>
          <span>
            Your saved settings, watchlist, traders, trade history and paper trading bot on the account are erased. This can't be undone. Your
            wallet and coins are not affected.
          </span>
          <input
            className="input"
            type="password"
            placeholder="Enter your password to confirm"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            required
          />
          <button className="btn sell" style={{ alignSelf: 'flex-start' }} disabled={busy || !pw}>
            Delete my account
          </button>
        </form>
      )}
      {note}
    </Section>
  );
}

export function Account() {
  const auth = useStore((s) => s.auth);

  if (auth.status !== 'user' || !auth.user) {
    return (
      <>
        <PageTitle title="Account" />
        <div className="panel">
          <div className="empty" style={{ padding: 40 }}>
            {auth.status === 'disabled' ? (
              'Accounts are not set up on this server yet.'
            ) : (
              <>
                <div style={{ marginBottom: 14, color: 'var(--text)' }}>Log in to save your settings, watchlist and wallet.</div>
                <button className="btn primary" onClick={() => useStore.setState({ authModal: 'login' })}>
                  Log in or create an account
                </button>
              </>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Account & security"
        sub={`${auth.user.email} · member since ${new Date(auth.user.createdAt).toLocaleDateString()}`}
      />
      <div className="notice green" style={{ marginBottom: 14 }}>
        Your settings, watchlist, saved traders and trade history sync to this account automatically, on every device you
        log in from.
      </div>
      <WalletSection />
      <PasswordSection />
      <SessionsSection />
    </>
  );
}
