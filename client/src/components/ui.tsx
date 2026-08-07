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
      className={`w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 ${
        props.type === 'number' ? numberInputClass : ''
      } ${className}`}
    />
  );
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 ${className}`}
    />
  );
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 ${className}`}
    />
  );
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
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

export function EmptyState({ message }: { message: string }) {
  return <div className="py-10 text-center text-sm text-slate-400">{message}</div>;
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
