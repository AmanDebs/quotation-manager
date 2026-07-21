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
  const whole = Math.floor(amount);
  const frac = Math.round((amount - whole) * 100);
  const toWords = cfg.indian ? indianWords : westernWords;
  let out = `${cfg.major} ${toWords(whole)}`;
  if (frac > 0) out += ` and ${twoDigits(frac)} ${cfg.minor}`;
  return out + ' Only';
}
