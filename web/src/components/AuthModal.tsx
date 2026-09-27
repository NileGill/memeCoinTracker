import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { authApi, signedIn } from '../lib/auth';
import { useStore } from '../store';
import { Icon } from './Icon';

type Step = 'login' | 'signup' | 'verify' | 'forgot' | 'reset';

function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="amount-box" style={{ padding: '2px 4px 2px 0' }}>
      <input
        className="input"
        style={{ border: 0, background: 'none', fontSize: 14, fontWeight: 400 }}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        maxLength={128}
      />
      <button type="button" className="btn ghost xs" onClick={() => setShow((s) => !s)}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

export function AuthModal() {
  const mode = useStore((s) => s.authModal);
  const [step, setStep] = useState<Step>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeFor = useRef<'verify' | 'reset'>('verify');

  useEffect(() => {
    if (!mode) return;
    setStep(mode);
    setError(null);
    setInfo(null);
    setPassword('');
    setConfirm('');
    setCode('');
  }, [mode]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useStore.setState({ authModal: null });
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  if (!mode) return null;
  const close = () => useStore.setState({ authModal: null });

  const go = (s: Step) => {
    setStep(s);
    setError(null);
    setInfo(null);
    setCode('');
    setPassword('');
    setConfirm('');
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toCode = (purpose: 'verify' | 'reset') => {
    codeFor.current = purpose;
    setStep(purpose === 'verify' ? 'verify' : 'reset');
    setCode('');
    setCooldown(60);
    setInfo(
      `We sent a 6-digit code to ${email.trim()}. It expires in 10 minutes. Not in your inbox? Check Spam, and if this is the same Gmail that sends MemeRadar's codes, look in Sent or All Mail.`,
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const addr = email.trim();
    if (step === 'login')
      return void run(async () => {
        const r = await authApi.login(addr, password);
        if ('user' in r) signedIn(r.user, r.data);
        else toCode('verify');
      });
    if (step === 'signup')
      return void run(async () => {
        if (password !== confirm) throw new Error("The passwords don't match.");
        await authApi.signup(addr, password);
        toCode('verify');
      });
    if (step === 'verify')
      return void run(async () => {
        const r = await authApi.verify(addr, code.trim());
        signedIn(r.user, r.data);
      });
    if (step === 'forgot')
      return void run(async () => {
        await authApi.forgot(addr);
        toCode('reset');
      });
    if (step === 'reset')
      return void run(async () => {
        if (password !== confirm) throw new Error("The passwords don't match.");
        const r = await authApi.reset(addr, code.trim(), password);
        signedIn(r.user, r.data);
      });
  };

  const titles: Record<Step, string> = {
    login: 'Log in',
    signup: 'Create your account',
    verify: 'Check your email',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  };

  const emailField = (
    <label className="field">
      Email
      <input
        className="input"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        required
        maxLength={254}
        autoFocus={step === 'login' || step === 'signup' || step === 'forgot'}
      />
    </label>
  );

  const codeField = (
    <label className="field">
      6-digit code
      <input
        className="input mono"
        style={{ fontSize: 22, letterSpacing: 8, textAlign: 'center' }}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        required
        autoFocus
      />
    </label>
  );

  const resend = (
    <button
      type="button"
      className="btn ghost sm"
      disabled={cooldown > 0 || busy}
      onClick={() =>
        run(async () => {
          await authApi.resend(email.trim(), codeFor.current);
          setCooldown(60);
          setInfo('If the address is right, a new code is on its way.');
        })
      }
    >
      {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
    </button>
  );

  let body: ReactNode;
  if (step === 'login') {
    body = (
      <>
        {emailField}
        <label className="field">
          Password
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" placeholder="" />
        </label>
        <button className="btn primary lg wide" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn ghost sm" onClick={() => go('forgot')}>
            Forgot password?
          </button>
          <button type="button" className="btn ghost sm" onClick={() => go('signup')}>
            Create an account
          </button>
        </div>
      </>
    );
  } else if (step === 'signup') {
    body = (
      <>
        {emailField}
        <label className="field">
          Password <span className="dim">(at least 10 characters)</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" placeholder="" />
        </label>
        <label className="field">
          Confirm password
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="" />
        </label>
        <button className="btn primary lg wide" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => go('login')}>
          Already have an account? Log in
        </button>
      </>
    );
  } else if (step === 'verify') {
    body = (
      <>
        {codeField}
        <button className="btn primary lg wide" disabled={busy || code.length !== 6}>
          {busy ? 'Checking…' : 'Verify email'}
        </button>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {resend}
          <button type="button" className="btn ghost sm" onClick={() => go('signup')}>
            Use a different email
          </button>
        </div>
      </>
    );
  } else if (step === 'forgot') {
    body = (
      <>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Enter your account email and we'll send you a code to set a new password.
        </p>
        {emailField}
        <button className="btn primary lg wide" disabled={busy}>
          {busy ? 'Sending…' : 'Send code'}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => go('login')}>
          Back to log in
        </button>
      </>
    );
  } else {
    body = (
      <>
        {codeField}
        <label className="field">
          New password <span className="dim">(at least 10 characters)</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" placeholder="" />
        </label>
        <label className="field">
          Confirm new password
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="" />
        </label>
        <button className="btn primary lg wide" disabled={busy || code.length !== 6}>
          {busy ? 'Saving…' : 'Reset password'}
        </button>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {resend}
          <button type="button" className="btn ghost sm" onClick={() => go('login')}>
            Back to log in
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={close} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={titles[step]}>
        <div className="row" style={{ marginBottom: 14 }}>
          <span style={{ color: 'var(--accent-2)', display: 'inline-flex' }}>
            <Icon name="radar" size={22} />
          </span>
          <h2 style={{ margin: 0, fontSize: 18 }}>{titles[step]}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto', width: 32, height: 32 }} onClick={close} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <form className="col" style={{ gap: 12 }} onSubmit={submit} noValidate={false}>
          {info && <div className="notice blue">{info}</div>}
          {error && <div className="notice red">{error}</div>}
          {body}
        </form>
        <p className="dim" style={{ fontSize: 11.5, margin: '14px 0 0', lineHeight: 1.5 }}>
          Your account saves your settings, watchlist, traders and trade history. MemeRadar never asks for your seed
          phrase or private key.
        </p>
      </div>
    </>
  );
}
