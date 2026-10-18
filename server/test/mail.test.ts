import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailConfigured, mailProblem, mailProvider, mailVerifies, senderParts, sendMail,
} from '../src/services/mail.js';
import type { MailResult } from '../src/services/mail.js';

/**
 * The transport, which is now two providers rather than one.
 *
 * Asked for 2026-10-18 (*"Is it possible without DNS"*): Resend sends only
 * from a verified **domain**, Brevo will verify a single sender **address** by
 * emailing a link to it. They want different bodies and different auth
 * headers, so what is worth pinning is that **each provider's own shape
 * reaches the wire** — a Resend body posted to Brevo is refused with a
 * sentence nobody can act on, and that failure looks exactly like the silence
 * this whole feature was built to end.
 *
 * `fetch` is stubbed per case, so this stays as offline as the rest of the
 * suite — and the two cases that assert **no request was made at all** are
 * what keep it that way.
 */

const KEYS = ['MAIL_API_KEY', 'MAIL_FROM', 'MAIL_PROVIDER', 'MAIL_API_URL'] as const;
type Key = (typeof KEYS)[number];

/** The environment, and nothing left over from the case before. */
function configure(env: Partial<Record<Key, string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Send one message against a stubbed provider and report what it posted. */
async function capture(
  env: Partial<Record<Key, string>>,
  to: string[] = ['approver@example.com'],
  status = 200,
): Promise<{ out: MailResult; posted: Posted | null }> {
  configure(env);
  const real = globalThis.fetch;
  let posted: Posted | null = null;
  globalThis.fetch = (async (url: unknown, init: { headers?: unknown; body?: unknown } = {}) => {
    posted = {
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    };
    return new Response(status === 200 ? '{"id":"x"}' : '{"message":"Sender not valid"}', { status });
  }) as unknown as typeof fetch;
  try {
    const out = await sendMail(to, 'Approval needed: Quotation QT/26-27/008', 'Body.');
    return { out, posted };
  } finally {
    globalThis.fetch = real;
    configure({});
  }
}

describe('the sender, split for a provider that wants it in two pieces', () => {
  test('a name and an address come apart', () => {
    assert.deepEqual(
      senderParts('Aglo Polymers <no-reply@aglopolymers.com>'),
      { name: 'Aglo Polymers', email: 'no-reply@aglopolymers.com' },
    );
  });

  test('a bare address has no name rather than a blank one', () => {
    /* Brevo refuses a sender carrying an empty name, so the difference
       between '' and absent is load-bearing rather than tidiness. */
    assert.deepEqual(senderParts('no-reply@aglopolymers.com'), { name: '', email: 'no-reply@aglopolymers.com' });
  });

  test('a quoted name is unquoted, and whitespace is dropped', () => {
    assert.deepEqual(
      senderParts('  "Aglo Polymers Pvt Ltd"  < no-reply@aglopolymers.com >  '),
      { name: 'Aglo Polymers Pvt Ltd', email: 'no-reply@aglopolymers.com' },
    );
  });
});

describe('nothing is sent until it is configured', () => {
  test('with nothing set, no request is made at all', async () => {
    const { out, posted } = await capture({});
    assert.equal(out.sent, false);
    assert.match(out.reason, /MAIL_API_KEY and MAIL_FROM/);
    // The assertion that keeps the whole suite offline.
    assert.equal(posted, null);
  });

  test('a key with no sender is still off', async () => {
    const { out, posted } = await capture({ MAIL_API_KEY: 'k' });
    assert.equal(out.sent, false);
    assert.equal(posted, null);
  });

  test('and `mailConfigured` agrees with it', () => {
    configure({});
    assert.equal(mailConfigured(), false);
    configure({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>' });
    assert.equal(mailConfigured(), true);
    configure({});
  });
});

describe('a provider is a table entry, and each gets its own shape', () => {
  test('resend is the default, so nothing already deployed moves', async () => {
    const { out, posted } = await capture({ MAIL_API_KEY: 'k', MAIL_FROM: 'Aglo Polymers <no-reply@x.com>' });
    assert.equal(out.sent, true);
    assert.equal(posted!.url, 'https://api.resend.com/emails');
    assert.equal(posted!.headers.Authorization, 'Bearer k');
    // The whole sender string, verbatim, and a flat list of addresses.
    assert.equal(posted!.body.from, 'Aglo Polymers <no-reply@x.com>');
    assert.deepEqual(posted!.body.to, ['approver@example.com']);
    assert.equal(posted!.body.text, 'Body.');
  });

  test('brevo splits the sender, objects the recipients and renames the body', async () => {
    const { out, posted } = await capture({
      MAIL_API_KEY: 'k', MAIL_FROM: 'Aglo Polymers <no-reply@x.com>', MAIL_PROVIDER: 'brevo',
    });
    assert.equal(out.sent, true);
    assert.equal(posted!.url, 'https://api.brevo.com/v3/smtp/email');
    // Its own header, not a bearer token.
    assert.equal(posted!.headers['api-key'], 'k');
    assert.equal(posted!.headers.Authorization, undefined);
    assert.deepEqual(posted!.body.sender, { name: 'Aglo Polymers', email: 'no-reply@x.com' });
    assert.deepEqual(posted!.body.to, [{ email: 'approver@example.com' }]);
    assert.equal(posted!.body.textContent, 'Body.');
  });

  test('neither body carries the other\'s keys', async () => {
    /* The point of the table: posting one provider's shape to the other is
       refused with a sentence about a missing field, which reads as the same
       silence the badge already had. */
    const resend = await capture({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>' });
    assert.equal(resend.posted!.body.sender, undefined);
    assert.equal(resend.posted!.body.textContent, undefined);
    const brevo = await capture({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'brevo' });
    assert.equal(brevo.posted!.body.from, undefined);
    assert.equal(brevo.posted!.body.text, undefined);
  });

  test('a brevo sender with no name sends no name', async () => {
    const { posted } = await capture({
      MAIL_API_KEY: 'k', MAIL_FROM: 'no-reply@x.com', MAIL_PROVIDER: 'brevo',
    });
    assert.deepEqual(posted!.body.sender, { email: 'no-reply@x.com' });
  });

  test('the provider name is read whatever its case, and padded', async () => {
    const { posted } = await capture({
      MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: '  Brevo ',
    });
    assert.equal(posted!.url, 'https://api.brevo.com/v3/smtp/email');
  });

  test('recipients are cleaned before either provider sees them', async () => {
    const { posted } = await capture(
      { MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'brevo' },
      ['One@Example.com', 'one@example.com', '', 'not an address'],
    );
    assert.deepEqual(posted!.body.to, [{ email: 'one@example.com' }]);
  });

  test('MAIL_API_URL wins over either default, which is what let this be measured', async () => {
    const a = await capture({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_API_URL: 'http://localhost:4199/emails' });
    assert.equal(a.posted!.url, 'http://localhost:4199/emails');
    const b = await capture({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'brevo', MAIL_API_URL: 'http://localhost:4199/emails' });
    assert.equal(b.posted!.url, 'http://localhost:4199/emails');
    // ...and the body is still that provider's own.
    assert.ok(b.posted!.body.sender);
  });

  test('a refusal is reported in the provider\'s own words', async () => {
    const { out } = await capture(
      { MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'brevo' },
      ['a@example.com'],
      400,
    );
    assert.equal(out.sent, false);
    assert.match(out.reason, /400/);
    assert.match(out.reason, /Sender not valid/);
  });

  test('each provider says what it verifies, and they differ', () => {
    configure({ MAIL_PROVIDER: 'resend' });
    const resend = mailVerifies();
    configure({ MAIL_PROVIDER: 'brevo' });
    const brevo = mailVerifies();
    configure({});
    assert.ok(resend && brevo);
    // The distinction the Settings card exists to draw.
    assert.notEqual(resend, brevo);
    assert.match(brevo, /no DNS/i);
  });
});

describe('a setting that can never send says so rather than reading On', () => {
  test('a provider this build does not know is named, with what it accepts', async () => {
    const { out, posted } = await capture({
      MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'mailgun',
    });
    assert.equal(out.sent, false);
    assert.match(out.reason, /mailgun/);
    assert.match(out.reason, /resend/);
    assert.match(out.reason, /brevo/);
    // Refused here rather than posted somewhere that would answer confusingly.
    assert.equal(posted, null);
  });

  test('and the card reads Off for it rather than On', () => {
    configure({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'mailgun' });
    assert.equal(mailConfigured(), false);
    assert.equal(mailProvider(), 'mailgun');
    assert.equal(mailVerifies(), '');
    configure({});
  });

  test('a MAIL_FROM with no address in it is refused by name', async () => {
    const { out, posted } = await capture({ MAIL_API_KEY: 'k', MAIL_FROM: 'Aglo Polymers' });
    assert.equal(out.sent, false);
    assert.match(out.reason, /MAIL_FROM/);
    assert.match(out.reason, /Aglo Polymers/);
    assert.equal(posted, null);
  });

  test('a working setting has no problem to report', () => {
    configure({ MAIL_API_KEY: 'k', MAIL_FROM: 'A <a@b.com>', MAIL_PROVIDER: 'brevo' });
    assert.equal(mailProblem(), '');
    configure({});
  });
});
