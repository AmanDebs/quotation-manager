const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ones[n];
  return (tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '')).trim();
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return ((h ? ones[h] + ' Hundred' : '') + (rest ? (h ? ' ' : '') + twoDigits(rest) : '')).trim();
}

/** Indian system: crore/lakh/thousand. Used for INR. */
function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(indianWords(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/** Western system: million/thousand. Used for USD/EUR. */
function westernWords(n: number): string {
  if (n === 0) return 'Zero';
  const billion = Math.floor(n / 1e9);
  const million = Math.floor((n % 1e9) / 1e6);
  const thousand = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (billion) parts.push(threeDigits(billion) + ' Billion');
  if (million) parts.push(threeDigits(million) + ' Million');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

const currencyNames: Record<string, { major: string; minor: string; indian: boolean }> = {
  INR: { major: 'Rupees', minor: 'Paise', indian: true },
  USD: { major: 'US Dollars', minor: 'Cents', indian: false },
  EUR: { major: 'Euros', minor: 'Cents', indian: false },
};

export function amountInWords(amount: number, currency: string): string {
  const cfg = currencyNames[currency] ?? { major: currency, minor: 'Cents', indian: false };
  const toWords = cfg.indian ? indianWords : westernWords;

  /**
   * The sign is taken off before any of the arithmetic below.
   *
   * `Math.floor` rounds *down*, so on a negative amount it hands back -1 crore
   * for -500, and the recursion in `indianWords` never reaches zero: any
   * negative figure at all brought the whole PDF down with a stack overflow.
   * The client's number inputs carry min={0}, but that is a hint to a browser
   * and not a rule the API enforces, and a credit note is a real document
   * somebody may one day want.
   */
  const negative = amount < 0;
  const abs = Math.abs(amount);

  let whole = Math.floor(abs);
  let frac = Math.round((abs - whole) * 100);
  // Rounding up from .995 lands on a hundred, and the lookup table stops at
  // ninety-nine — which printed "and undefined Paise" on the document rather
  // than failing. A hundred of the minor unit is one of the major one.
  if (frac >= 100) { whole += Math.floor(frac / 100); frac %= 100; }

  let out = `${negative ? 'Minus ' : ''}${cfg.major} ${toWords(whole)}`;
  if (frac > 0) out += ` and ${twoDigits(frac)} ${cfg.minor}`;
  return out + ' Only';
}
