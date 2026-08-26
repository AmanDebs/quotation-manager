import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const styles = {
    primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-slate-300',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
    ghost: 'text-brand-600 hover:bg-brand-50',
  }[variant];
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

/**
 * These controls default to full width, which is right almost everywhere — a
 * field in a form should fill its column. But a default expressed as a class
 * cannot be overridden by another class: `w-full` and `w-48` are both width
 * utilities of equal specificity, so which one wins is decided by their order
 * in the generated stylesheet, not by the order they appear in the attribute.
 * Passing `className="w-48"` therefore did nothing reliable, and the only
 * reason nobody noticed for months is that a non-wrapping flex row squashes
 * its children anyway. Put the same controls in a *wrapping* row and every one
 * of them claims the full width and drops onto its own line — which is exactly
 * how the dashboard header broke.
 *
 * So the default is only applied when the caller has not set a width. A class
 * list is a string, and reading it is unglamorous but honest; the alternative
 * is a class-merging dependency, and the bar for those here is high.
 *
 * `max-w-*` deliberately does not count: `w-full max-w-sm` is a legitimate
 * pairing — fill the space, up to a limit — and suppressing `w-full` there
 * would break it.
 */
const setsWidth = (className: string) => /(?:^|\s)(?:[\w-]+:)*w-\S+/.test(className);

/** The shared field styling, with `w-full` unless the caller chose a width. */
const fieldClass = (className: string, extra = '') =>
  [
    setsWidth(className) ? '' : 'w-full',
    'rounded-md border border-slate-300 bg-white py-1.5 text-sm',
    'focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600',
    extra,
    className,
  ].filter(Boolean).join(' ');

/**
 * Number fields get the spinner arrows removed and their figures right-aligned.
 * The arrows are never used for quantities like 17,850 and cost ~16px of width,
 * which is enough to clip the value in a narrow column. Applied here so every
 * numeric field in the app behaves the same; a caller can still override.
 */
const numberInputClass =
  'text-right tabular-nums [appearance:textfield] ' +
  '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={fieldClass(className, `px-2.5 ${props.type === 'number' ? numberInputClass : ''}`)}
    />
  );
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={fieldClass(className, 'px-2')} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={fieldClass(className, 'px-2.5')} />;
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}

/**
 * A download link, styled as a secondary Button.
 *
 * An anchor rather than a fetch: the session is an httpOnly cookie on this
 * origin, so the browser fetches the file itself and nothing has to be held in
 * memory as a blob. The caller passes the list's own filters in the href, so
 * what downloads is what is on screen — the server ignores page and limit, so
 * it is the whole filtered set rather than the page being looked at.
 */
export function DownloadButton({ href, label = 'Download Excel', title }: { href: string; label?: string; title?: string }) {
  return (
    <a
      href={href}
      title={title ?? 'Download every row these filters match — not just this page'}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
    >
      {label}
    </a>
  );
}

export function Card({ title, children, actions, className = '' }: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 className="text-xl font-bold text-slate-800">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

const statusColors: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  sent: 'bg-blue-100 text-blue-700',
  negotiating: 'bg-amber-100 text-amber-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-slate-200 text-slate-500',
  open: 'bg-blue-100 text-blue-700',
  quoted: 'bg-indigo-100 text-indigo-700',
  lost: 'bg-red-100 text-red-700',
  order_confirmed: 'bg-green-100 text-green-700',
  advance_received: 'bg-emerald-100 text-emerald-700',
  in_production: 'bg-purple-100 text-purple-700',
  cancelled: 'bg-red-100 text-red-700',
  final: 'bg-blue-100 text-blue-700',
  dispatched: 'bg-purple-100 text-purple-700',
  paid: 'bg-green-100 text-green-700',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/** All | Export | Domestic filter used on every document list. */
export function ExportTabs({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tabs = [
    { key: '', label: 'All' },
    { key: '1', label: '🌍 Export' },
    { key: '0', label: '🇮🇳 Domestic' },
  ];
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`rounded px-3 py-1 text-sm transition-colors ${
            value === t.key ? 'bg-brand-700 font-medium text-white' : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * An underlined tab strip, for a page holding several views of one thing —
 * the masters page, and the order's Details / Production / Material / Dispatch.
 * Distinct from `ExportTabs`, which is a segmented *filter* over one list.
 */
export function Tabs<T extends string>({
  value, onChange, tabs, className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { key: T; label: string; badge?: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1 border-b border-slate-200 ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          aria-current={value === t.key ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            value === t.key
              ? 'border-brand-700 font-semibold text-brand-700'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
          }`}
        >
          {t.label}
          {t.badge != null && <span className="ml-1.5 text-xs text-slate-400">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="py-10 text-center text-sm text-slate-400">{message}</div>;
}

/**
 * The pager under a list.
 *
 * Draws nothing at all when there is only one page — most lists in a young
 * database have one, and a row of dead arrows under four invoices is noise.
 * It still says how many rows there are, because "1-50 of 412" is the number
 * people actually want and no other part of the page says it.
 *
 * Page numbers are windowed around the current page rather than printed in
 * full: a list five years into trading has 60 pages and nobody clicks page 37.
 */
/**
 * Which page numbers to draw: the current page and its neighbours, plus the
 * first and the last, at most seven in all. A list five years into trading has
 * sixty pages and nobody clicks page 37, but everybody clicks "last".
 *
 * Exported for its own sake — it is the one piece of arithmetic in this file,
 * and the browser is not where arithmetic should be checked.
 */
export function pageWindow(page: number, pages: number): number[] {
  // Short enough to print in full: an ellipsis standing in for a single page
  // is worse than the page, and at seven the budget is not yet spent.
  if (pages <= 7) return Array.from({ length: Math.max(0, pages) }, (_, i) => i + 1);
  const window = new Set<number>([1, pages, page, page - 1, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => window.add(n));
  if (page >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => window.add(n));
  return [...window].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
}

export function Pagination({ page, pages, total, limit, onPage, noun = 'rows' }: {
  page: number;
  pages: number;
  total: number;
  limit: number;
  onPage: (n: number) => void;
  /** What the rows are, for the count line: "412 invoices". */
  noun?: string;
}) {
  if (pages <= 1) {
    return total > 0
      ? <div className="pt-3 text-xs text-slate-400">{total} {noun}</div>
      : null;
  }
  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);
  const numbers = pageWindow(page, pages);

  const step = (n: number) => 'rounded-md px-2.5 py-1 text-sm ' + (
    n === page
      ? 'bg-brand-700 font-semibold text-white'
      : 'text-slate-600 hover:bg-slate-100'
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
      <div className="text-xs text-slate-400">
        {first}–{last} of {total} {noun}
      </div>
      <div className="flex items-center gap-1">
        <button
          className="rounded-md px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
        >
          ‹ Prev
        </button>
        {numbers.map((n, i) => (
          <span key={n} className="flex items-center">
            {i > 0 && numbers[i - 1] !== n - 1 && <span className="px-1 text-slate-300">…</span>}
            <button className={step(n)} onClick={() => onPage(n)}>{n}</button>
          </span>
        ))}
        <button
          className="rounded-md px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-12" onClick={onClose}>
      <div
        className={`max-h-[85vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-y-auto rounded-lg bg-white shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
