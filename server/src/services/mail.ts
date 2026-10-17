/**
 * Sending an email, which this deployment could not do at all until now.
 *
 * Asked for 2026-10-17 (*"Approval – no notification is coming. Is it possible
 * to issue notification on email / mobile for viewing and approval."*). Every
 * notification in this app has been a **badge** — the approvals queue, the
 * follow-ups count, the dispatch queues — and this file records why twice
 * over: there was no mail server, so *"a notification that reaches somebody
 * not looking at the app is not something this app can honestly offer."* That
 * is the sentence this withdraws, and only that one: the badges stay exactly
 * as they are, because a badge is right whenever somebody opens the page and
 * an email is right only if it was sent.
 *
 * **No dependency.** A provider's HTTP API is one `fetch`, where SMTP would
 * mean a client library — and the bar for a package here is high. Resend is
 * the default because its API is a single POST; another provider is the one
 * `post()` below and nothing else, since every caller goes through `sendMail`.
 *
 * **Unconfigured is silent, not broken.** With no key the app behaves exactly
 * as it did: `sendMail` reports why it did nothing and no caller treats that
 * as a failure. That is what makes this safe to deploy before anybody has
 * signed up for anything — and what keeps the whole test suite offline, since
 * nothing in `server/test` sets these.
 *
 * **It can never fail a save.** Callers fire and forget, the way the audit
 * middleware records after the response: a provider being down loses a
 * notification, never a quotation.
 *
 * Three environment variables, all on the service rather than in the database:
 * a secret in `settings` would be readable by anybody who can open the Backup
 * download, and this one can send mail in the company's name.
 *
 * - `MAIL_API_KEY` — the provider key. Absent means off.
 * - `MAIL_FROM` — `Aglo Polymers <no-reply@yourdomain.com>`, on a domain
 *   verified with the provider, or everything lands in spam.
 * - `APP_URL` — where the app is, so an email can link to the document. Falls
 *   back to Render's own `RENDER_EXTERNAL_URL`.
 *
 * `MAIL_API_URL` overrides the endpoint. It is not for configuring a provider
 * — a different provider wants a different body, not a different URL — but it
 * is what let this be **measured** before anybody had signed up for anything,
 * against a local stub that recorded what was posted. A relay that speaks the
 * same shape would work too.
 */

export interface MailResult {
  sent: boolean;
  /** Why not, in words — shown by the test button in Settings. */
  reason: string;
}

/** Read per call rather than at import: a key set after boot still works. */
function config() {
  return {
    key: String(process.env.MAIL_API_KEY ?? '').trim(),
    from: String(process.env.MAIL_FROM ?? '').trim(),
    url: String(process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').trim().replace(/\/+$/, ''),
    endpoint: String(process.env.MAIL_API_URL ?? 'https://api.resend.com/emails').trim(),
  };
}

/** Whether mail is set up at all — what the Settings card reads. */
export function mailConfigured(): boolean {
  const c = config();
  return !!c.key && !!c.from;
}

/** A link into the app, or '' where nobody has said where the app is. */
export function appLink(path: string): string {
  const { url } = config();
  return url ? `${url}${path.startsWith('/') ? path : `/${path}`}` : '';
}

/**
 * The provider. One function, so pointing this at SES, Postmark or Brevo is
 * one edit rather than a search through the callers.
 */
async function post(to: string[], subject: string, text: string): Promise<MailResult> {
  const { key, from, endpoint } = config();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
    // A provider that hangs must not hold a Node process open for minutes.
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return { sent: true, reason: '' };
  // The provider's own words — a wrong key and an unverified domain are
  // different problems and the person fixing it needs to know which.
  const body = await res.text().catch(() => '');
  return { sent: false, reason: `${res.status} ${body.slice(0, 300)}` };
}

/** Addresses this is willing to send to: non-blank, unique, and plausible. */
function clean(to: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of to) {
    const a = String(raw ?? '').trim();
    if (a.includes('@') && !a.includes(' ')) seen.add(a.toLowerCase());
  }
  // A cap rather than a crowd: a notification going to forty people is one
  // nobody reads, and a loop that grew would be a bill nobody noticed.
  return [...seen].slice(0, 25);
}

/**
 * Send one message, and never throw.
 *
 * Returns rather than throws because two callers want different things from a
 * failure: the approval hook logs it and carries on, and the test button in
 * Settings prints it.
 */
export async function sendMail(
  to: string[],
  subject: string,
  text: string,
): Promise<MailResult> {
  if (!mailConfigured()) {
    return { sent: false, reason: 'Email is not set up: MAIL_API_KEY and MAIL_FROM are not both set on the server.' };
  }
  const addresses = clean(to);
  if (!addresses.length) return { sent: false, reason: 'Nobody to send to.' };
  try {
    const out = await post(addresses, subject, text);
    if (!out.sent) console.error('[mail] send failed:', out.reason);
    return out;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[mail] send failed:', reason);
    return { sent: false, reason };
  }
}
