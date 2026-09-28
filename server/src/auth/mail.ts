import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { markError, markOk, registerSource } from '../lib/status';

const { smtp, brevoKey } = config;

/*
 * Two ways to send: Brevo's HTTPS API, or plain SMTP. Free hosting (Render's free plan) blocks
 * outgoing SMTP connections entirely, so there only the HTTPS API works. Brevo wins when both
 * are set.
 */
const transport: Transporter | null =
  !brevoKey && smtp.user && smtp.pass
    ? nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        requireTLS: smtp.port !== 465,
        auth: { user: smtp.user, pass: smtp.pass },
        // Fail in seconds, not minutes, if the mail server can't be reached (a login waits on this).
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      })
    : null;

/** "Name <address>" or "address" from MAIL_FROM, falling back to the SMTP login. */
function sender(): { name: string; email: string } | null {
  const raw = smtp.from ?? smtp.user;
  if (!raw) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  return m ? { name: m[1].trim() || 'MemeRadar', email: m[2].trim() } : { name: 'MemeRadar', email: raw.trim() };
}

/** Email works on this server (or we're in local development, where codes go to the console). */
export const emailReady = Boolean(transport || (brevoKey && sender())) || !config.isHosted;

// Shows on the Settings page (Data sources) whether the last code email was accepted for delivery.
if (transport || brevoKey) registerSource('email', 'Account emails');

async function sendViaBrevo(to: string, subject: string, text: string, html: string): Promise<string> {
  const from = sender();
  if (!from) throw new Error('MAIL_FROM is not set (it must be a sender verified in Brevo)');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': brevoKey!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: from, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (res.status !== 201 && res.status !== 202) throw new Error(`Brevo HTTP ${res.status}: ${body.slice(0, 160)}`);
  return body.slice(0, 80);
}

export class EmailError extends Error {}

type Purpose = 'verify' | 'reset' | 'already-registered';

const COPY: Record<Purpose, { subject: (code: string) => string; lead: string }> = {
  verify: {
    subject: (code) => `${code} is your MemeRadar verification code`,
    lead: 'Enter this code to verify your email and finish creating your MemeRadar account:',
  },
  reset: {
    subject: (code) => `${code} is your MemeRadar password reset code`,
    lead: 'Enter this code to reset your MemeRadar password:',
  },
  'already-registered': {
    subject: () => 'Someone tried to sign up with your email on MemeRadar',
    lead: '',
  },
};

export async function sendAuthEmail(to: string, purpose: Purpose, code = '') {
  const copy = COPY[purpose];
  const text =
    purpose === 'already-registered'
      ? 'Someone just tried to create a MemeRadar account with this email address, but you already have one.\n\n' +
        'If it was you, log in instead (or use "Forgot password"). If it wasn\'t you, you can ignore this email; your account is safe.\n'
      : `${copy.lead}\n\n    ${code}\n\nThe code expires in 10 minutes. If you didn't request it, ignore this email. ` +
        'Nobody from MemeRadar will ever ask you for this code, your password, or your wallet seed phrase.\n';

  if (!transport && !brevoKey) {
    if (config.isHosted) throw new EmailError('Email is not configured on this server.');
    // Local development only: print the email instead of sending it.
    console.log(`\n[mail:dev] to=${to}  subject="${copy.subject(code)}"\n${text}`);
    return;
  }

  const html =
    purpose === 'already-registered'
      ? `<p>${text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '')}</p>`
      : `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
           <p>${copy.lead}</p>
           <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:18px 0">${code}</p>
           <p style="color:#555">The code expires in 10 minutes. If you didn't request it, ignore this email.</p>
           <p style="color:#555">Nobody from MemeRadar will ever ask you for this code, your password, or your wallet seed phrase.</p>
         </div>`;

  try {
    let response: string;
    if (brevoKey) response = await sendViaBrevo(to, copy.subject(code), text, html);
    else {
      const info = await transport!.sendMail({
        from: smtp.from ?? `MemeRadar <${smtp.user}>`,
        to,
        subject: copy.subject(code),
        text,
        html,
      });
      if (!info.accepted?.length) throw new Error(`rejected by the mail server: ${String(info.response ?? '').slice(0, 120)}`);
      response = String(info.response ?? '');
    }
    markOk('email');
    console.log(`[mail] ${purpose} email accepted (${response.slice(0, 60)})`);
  } catch (e) {
    markError('email', e);
    console.error('[mail] send failed:', e instanceof Error ? e.message : e);
    throw new EmailError("We couldn't send the email right now. Try again in a minute.");
  }
}
