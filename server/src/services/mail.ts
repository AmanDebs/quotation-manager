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
 * mean a client library — and the bar for a package here is high.
 *
 * **Two providers, because they verify different things** (2026-10-18, the
 * client, having been given the four DNS records to add: *"Is it possible
 * without DNS"*). Resend will only send from a **domain**, which means DKIM
 * and SPF records at whoever runs that domain's DNS; Brevo will also verify a
 * single **sender address**, by sending a link to it, which needs no DNS at
 * all. Which is right is a question about who controls the domain rather than
 * about this app, so both are here and `MAIL_PROVIDER` picks.
 *
 * **A provider is a table entry, not a branch through the callers.** The three
 * things that differ are the endpoint, the auth header and the shape of the
 * body; everything above `post()` is unchanged by adding one, and a third
 * (Mailjet, SendGrid, SES, Postmark) is one more entry.
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
 * Four environment variables, all on the service rather than in the database:
 * a secret in `settings` would be readable by anybody who can open the Backup
 * download, and this one can send mail in the company's name.
 *
 * - `MAIL_API_KEY` — the provider key. Absent means off.
 * - `MAIL_FROM` — `Aglo Polymers <no-reply@yourdomain.com>`, on a sender the
 *   provider has verified, or everything lands in spam (or is refused).
 * - `MAIL_PROVIDER` — `resend` (the default, so nothing already deployed
 *   moves) or `brevo`.
 * - `APP_URL` — where the app is, so an email can link to the document. Falls
 *   back to Render's own `RENDER_EXTERNAL_URL`.
 *
 * `MAIL_API_URL` overrides the endpoint. It is not a way to configure a
 * provider — a different provider wants a different body, which is what the
 * table below is for — but it is what let both of these be **measured**
 * before anybody had signed up for anything, against a local stub that
 * recorded what was posted. A relay speaking the same shape would work too.
 */

export interface MailResult {
  sent: boolean;
  /** Why not, in words — shown by the test button in Settings. */
  reason: string;
}

/**
 * The sender as the two pieces a provider may want separately.
 *
 * Resend takes the whole `Name <addr>` string and is handed it verbatim, so
 * nothing already working goes through this. Brevo wants the name and the
 * address as their own fields, and a sender with no name is `{ email }` alone
 * rather than a blank name, which it refuses.
 */
export function senderParts(from: string): { name: string; email: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/.exec(from);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
  return { name: '', email: from.trim() };
}

interface Provider {
  /** Where to post, unless `MAIL_API_URL` says otherwise. */
  endpoint: string;
  /** What this provider verifies, for the sentence the Settings card prints. */
  verifies: string;
  headers(key: string): Record<string, string>;
  body(from: string, to: string[], subject: string, text: string): unknown;
}

const PROVIDERS: Record<string, Provider> = {
  /** Resend: the whole sender string, a bearer token, `text`. */
  resend: {
    endpoint: 'https://api.resend.com/emails',
    verifies: 'a whole domain, through DNS records',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: (from, to, subject, text) => ({ from, to, subject, text }),
  },
  /** Brevo: the sender split in two, its own header, `textContent`. */
  brevo: {
    endpoint: 'https://api.brevo.com/v3/smtp/email',
    verifies: 'one sender address, by clicking a link sent to it — no DNS',
    headers: (key) => ({ 'api-key': key, Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: (from, to, subject, text) => {
      const { name, email } = senderParts(from);
      return {
        sender: name ? { name, email } : { email },
        to: to.map((email) => ({ email })),
        subject,
        textContent: text,
      };
    },
  },
};

/** Read per call rather than at import: a key set after boot still works. */
function config() {
  return {
    key: String(process.env.MAIL_API_KEY ?? '').trim(),
    from: String(process.env.MAIL_FROM ?? '').trim(),
    provider: String(process.env.MAIL_PROVIDER ?? 'resend').trim().toLowerCase(),
    url: String(process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').trim().replace(/\/+$/, ''),
    /** The override alone — the provider supplies its own default. */
    endpoint: String(process.env.MAIL_API_URL ?? '').trim(),
  };
}

/** Which provider is in force, for the Settings card to name. */
export function mailProvider(): string {
  return config().provider;
}

/** What that provider verifies, or '' where it is not one this build knows. */
export function mailVerifies(): string {
  return PROVIDERS[config().provider]?.verifies ?? '';
}

/**
 * Why mail cannot be sent, in words, or '' when it can.
 *
 * The guard shape this codebase uses for every rule somebody has to be told
 * about (`lockError`, `incompleteError`, `renameError`, `foreignBankError`):
 * a function returning the sentence, so the screen can **explain** it rather
 * than keep a copy. The Settings card and `sendMail` both read this, which is
 * what stops the card saying *On* over a setting that can never send.
 *
 * Commonest first: by far the usual state is nothing configured at all.
 */
export function mailProblem(): string {
  const c = config();
  if (!c.key || !c.from) {
    return 'Email is not set up: MAIL_API_KEY and MAIL_FROM are not both set on the server.';
  }
  if (!PROVIDERS[c.provider]) {
    return `MAIL_PROVIDER is set to "${c.provider}", which this build does not know. Set it to ${Object.keys(PROVIDERS).join(' or ')}.`;
  }
  // The rule `clean()` applies to a recipient, read for the sender: a typo'd
  // MAIL_FROM is one of the four failures that otherwise all look like silence.
  if (!senderParts(c.from).email.includes('@')) {
    return `MAIL_FROM does not contain an email address: ${c.from}`;
  }
  return '';
}

/** Whether mail is set up at all — what the Settings card reads. */
export function mailConfigured(): boolean {
  return !mailProblem();
}

/** A link into the app, or '' where nobody has said where the app is. */
export function appLink(path: string): string {
  const { url } = config();
  return url ? `${url}${path.startsWith('/') ? path : `/${path}`}` : '';
}

/**
 * The provider. One function over the table, so pointing this at a third is
 * an entry above rather than a search through the callers.
 */
async function post(to: string[], subject: string, text: string): Promise<MailResult> {
  const { key, from, provider, endpoint } = config();
  const p = PROVIDERS[provider];
  const res = await fetch(endpoint || p.endpoint, {
    method: 'POST',
    headers: p.headers(key),
    body: JSON.stringify(p.body(from, to, subject, text)),
    // A provider that hangs must not hold a Node process open for minutes.
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return { sent: true, reason: '' };
  // The provider's own words — a wrong key and an unverified sender are
  // different problems and the person fixing it needs to know which.
  const body = await res.text().catch(() => '');
  return { sent: false, reason: `${res.status} ${body.slice(0, 300)}` };
}

/**
 * Addresses this is willing to send to: non-blank, unique, and plausible.
 *
 * Exported since 2026-10-28 so `queueMail` can apply it at **queue** time: a
 * malformed address that reached the outbox would become a row nobody could
 * ever send, retried until it gave up.
 */
export function cleanAddresses(to: string[]): string[] {
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
  const problem = mailProblem();
  if (problem) return { sent: false, reason: problem };
  const addresses = cleanAddresses(to);
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
