import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { markError, markOk, registerSource } from '../lib/status';

const { smtp } = config;

const transport: Transporter | null =
  smtp.user && smtp.pass
    ? nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        requireTLS: smtp.port !== 465,
        auth: { user: smtp.user, pass: smtp.pass },
      })
    : null;

/** Email works on this server (or we're in local development, where codes go to the console). */
export const emailReady = Boolean(transport) || !config.isHosted;

// Shows on the Settings page (Data sources) whether the last code email was accepted for delivery.
if (transport) registerSource('email', 'Account emails');

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

  if (!transport) {
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
    const info = await transport.sendMail({
      from: smtp.from ?? `MemeRadar <${smtp.user}>`,
      to,
      subject: copy.subject(code),
      text,
      html,
    });
    if (!info.accepted?.length) throw new Error(`rejected by the mail server: ${String(info.response ?? '').slice(0, 120)}`);
    markOk('email');
    console.log(`[mail] ${purpose} email accepted (${String(info.response ?? '').slice(0, 60)})`);
  } catch (e) {
    markError('email', e);
    console.error('[mail] send failed:', e instanceof Error ? e.message : e);
    throw new EmailError("We couldn't send the email right now. Try again in a minute.");
  }
}
