const symbols: Record<string, string> = { INR: '₹', USD: '$', EUR: '€' };

export function fmtMoney(n: number | null | undefined, currency: string): string {
  if (n == null) return '—';
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${symbols[currency] ?? currency + ' '}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}`;
}

export function fmtQty(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * A stored timestamp, as a date and a time.
 *
 * The audit log writes `datetime('now')`, which is **UTC** and carries no zone
 * marker — hand that string to `new Date()` and JavaScript reads it as local,
 * putting an entry five and a half hours in the future on an Indian desk. The
 * Z is added so it is read as what it is and then shown in local time, which
 * is what somebody asking "when did this happen" means.
 */
export function fmtDateTime(stamp: string | null | undefined): string {
  if (!stamp) return '—';
  const iso = stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return stamp;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * `days` after an ISO date, as another ISO date.
 *
 * Built by parsing the string into digits and doing the arithmetic in UTC, so
 * no local timezone ever touches it — the trap the dashboard's date presets
 * already record, where `toISOString()` on a local midnight lands a day early
 * anywhere east of Greenwich. Taking the *string* rather than the clock is
 * also what keeps a default validity exactly seven days after the date on the
 * document, whatever `today()` happened to say.
 *
 * A blank or unparseable date gives a blank, so a caller can pass a field
 * straight through without checking it first.
 */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = String(iso ?? '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * How long a new quotation or proforma is offered for, unless somebody says
 * otherwise. Asked for on 2026-09-06; it is a **default, not a rule** — the
 * field is on the form and editable before the document is ever saved, and
 * nothing already raised is touched.
 */
export const DEFAULT_VALIDITY_DAYS = 7;
