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

export const today = () => new Date().toISOString().slice(0, 10);
