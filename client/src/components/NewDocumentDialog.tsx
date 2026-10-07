import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer } from '../types';
import { Button, Modal, Input, EmptyState } from './ui';

/**
 * Export vs domestic is chosen before anything else, because it decides the
 * numbering series, tax treatment, form fields and PDF layout.
 *
 * Except on an invoice, where the answer is settled: a domestic sale is
 * invoiced in Tally (the client, 2026-09-16), so this app raises commercial
 * invoices for exports alone and the dialog opens straight on the export
 * customers. `exportOnly` states that; the server refuses a domestic POST
 * regardless.
 */
export default function NewDocumentDialog({
  basePath, title, onClose, exportOnly,
}: {
  exportOnly?: boolean;
  basePath: '/quotations' | '/proformas' | '/invoices';
  title: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [type, setType] = useState<'export' | 'domestic' | null>(exportOnly ? 'export' : null);
  const [q, setQ] = useState('');

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', q, type],
    queryFn: () => api.get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}${type ? `&export=${type === 'export' ? 1 : 0}` : ''}`),
    enabled: !!type,
  });

  /**
   * What the *other* type holds, asked only when this one is empty.
   *
   * This list follows the customer's own Type, and nothing on this screen said
   * so — a buyer marked Domestic simply does not appear under Export, which
   * reads as the customer being missing. The old empty state then said to add
   * one on the Customers page, and following that literally creates a second
   * record for a customer already on file: every document, payment and order
   * hangs off the one row, so a duplicate is the expensive mistake here.
   *
   * It matters on this book in particular. The customer import reads Type from
   * a **Country** column — stated and not India is an export buyer — and the
   * client's own `Customers.xlsx` carries Customer, Address and GSTIN and no
   * country at all, so every imported row came in Domestic. Aglo also sells
   * abroad through Dubai and Mauritius intermediaries, who are ordinarily
   * registered in India, so the country is a poor signal for them twice over.
   */
  const other = type === 'export' ? 'domestic' : 'export';
  const { data: otherCustomers = [] } = useQuery({
    queryKey: ['customers', q, other],
    queryFn: () => api.get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}&export=${other === 'export' ? 1 : 0}`),
    enabled: !!type && customers.length === 0,
  });

  const go = (customerId: number) => {
    navigate(`${basePath}/new?type=${type}&customer=${customerId}`);
    onClose();
  };

  return (
    <Modal title={title} onClose={onClose} wide={!!type}>
      {!type ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Is this an export order or a domestic (India) sale?</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              onClick={() => setType('export')}
              className="rounded-lg border border-slate-300 p-4 text-left transition-colors hover:border-brand-600 hover:bg-brand-50"
            >
              <div className="text-lg">🌍 Export</div>
              <div className="mt-1 text-xs text-slate-500">
                No GST, export numbering series, INCO terms, ports, containers, consignee and notify parties.
              </div>
            </button>
            <button
              onClick={() => setType('domestic')}
              className="rounded-lg border border-slate-300 p-4 text-left transition-colors hover:border-brand-600 hover:bg-brand-50"
            >
              <div className="text-lg">🇮🇳 Domestic</div>
              <div className="mt-1 text-xs text-slate-500">
                GST (CGST+SGST or IGST), INR, domestic numbering series, simplified layout.
              </div>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {!exportOnly && <button onClick={() => setType(null)} className="text-sm text-brand-600 hover:underline">← Back</button>}
            <span className="text-sm font-medium capitalize">{type}</span>
            {exportOnly && <span className="text-xs text-slate-500">— domestic sales are invoiced in Tally</span>}
          </div>
          <Input placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
            {customers.length === 0 ? (
              otherCustomers.length > 0 ? (
                /*
                 * Says which fact is missing rather than inviting a duplicate:
                 * the customer is on file, under the other Type, and Type is
                 * what this list follows. The link lands on the Customers page
                 * already filtered and searched, so the row is one click away.
                 */
                <div className="px-4 py-8 text-center text-sm text-slate-500">
                  <p>
                    No {type} customers{q ? ' match that search' : ''} — but{' '}
                    <span className="font-medium text-slate-700">
                      {otherCustomers.length} {otherCustomers.length === 1 ? 'is' : 'are'} marked {other}
                    </span>
                    .
                  </p>
                  <p className="mt-1 text-xs">
                    This list follows the customer's own Type. Set it on the Customers page rather than
                    adding a second record for a buyer already on file.
                  </p>
                  <Link
                    to={`/customers?export=${other === 'export' ? 1 : 0}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                    onClick={onClose}
                    className="mt-3 inline-block text-xs text-brand-600 underline underline-offset-2 hover:text-brand-700"
                  >
                    Open the {other} customers
                  </Link>
                </div>
              ) : (
                <EmptyState message={`No ${type} customers found. Add one on the Customers page first.`} />
              )
            ) : (
              customers.map((c) => (
                <button
                  key={c.id}
                  onClick={() => go(c.id)}
                  className="flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50"
                >
                  <span>
                    <span className="font-medium">{c.name}</span>
                    <span className="ml-2 text-xs text-slate-500">{c.city ? `${c.city}, ` : ''}{c.country}</span>
                  </span>
                  <span className="text-xs text-slate-400">{c.currency}</span>
                </button>
              ))
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
