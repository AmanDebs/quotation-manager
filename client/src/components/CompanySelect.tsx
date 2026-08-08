import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company } from '../types';
import { Select } from './ui';

/** The group's active entities, cached once and shared by every form. */
export function useCompanies() {
  const { data = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/api/companies'),
  });
  return data;
}

/**
 * Who is selling.
 *
 * On a document this is fixed once the number exists — the number was drawn
 * from that company's series, so switching afterwards would leave one entity's
 * number on another entity's letterhead. `locked` says so rather than silently
 * dropping the change.
 *
 * With one company in the group the control renders nothing: there is no
 * choice to make, and an unnecessary dropdown on every form is just noise.
 */
export default function CompanySelect({
  value, onChange, locked, allowDefault, className,
}: {
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  /** Numbered already — show the company, do not let it change. */
  locked?: boolean;
  /** Offer a blank "group default" option (used on the customer record). */
  allowDefault?: boolean;
  className?: string;
}) {
  const companies = useCompanies();
  if (companies.length < 2) return null;

  if (locked) {
    const name = companies.find((c) => c.id === value)?.company_name ?? '—';
    return (
      <div className={`text-sm text-slate-700 ${className ?? ''}`} title="Fixed — the document number came from this company's series">
        {name}
      </div>
    );
  }

  return (
    <Select
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      {allowDefault && <option value="">— group default —</option>}
      {companies.map((c) => (
        <option key={c.id} value={c.id}>{c.company_name || `Company ${c.id}`}</option>
      ))}
    </Select>
  );
}
