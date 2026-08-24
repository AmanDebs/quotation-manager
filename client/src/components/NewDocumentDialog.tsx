import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer } from '../types';
import { Button, Modal, Input, EmptyState } from './ui';

/**
 * Export vs domestic is chosen before anything else, because it decides the
 * numbering series, tax treatment, form fields and PDF layout.
 */
export default function NewDocumentDialog({
  basePath, title, onClose,
}: {
  basePath: '/quotations' | '/proformas' | '/invoices';
  title: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [type, setType] = useState<'export' | 'domestic' | null>(null);
  const [q, setQ] = useState('');

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', q, type],
    queryFn: () => api.get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}${type ? `&export=${type === 'export' ? 1 : 0}` : ''}`),
    enabled: !!type,
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
            <button onClick={() => setType(null)} className="text-sm text-brand-600 hover:underline">← Back</button>
            <span className="text-sm font-medium capitalize">{type}</span>
          </div>
          <Input placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
            {customers.length === 0 ? (
              <EmptyState message={`No ${type} customers found. Add one on the Customers page first.`} />
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
