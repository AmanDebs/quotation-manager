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
