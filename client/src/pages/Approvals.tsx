import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PendingApproval } from '../types';
import { Button, Select, Textarea, Field, PageHeader, EmptyState, ErrorText, Card, Modal } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';

const routeFor: Record<PendingApproval['type'], string> = {
  quotation: '/quotations',
  proforma: '/proformas',
  invoice: '/invoices',
};
const apiFor: Record<PendingApproval['type'], string> = {
  quotation: '/api/quotations',
  proforma: '/api/proformas',
  invoice: '/api/invoices',
};
const labelFor: Record<PendingApproval['type'], string> = {
  quotation: 'Quotation',
  proforma: 'Proforma Invoice',
  invoice: 'Commercial Invoice',
};

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [rejecting, setRejecting] = useState<PendingApproval | null>(null);
  const [note, setNote] = useState('');

  const { data: rows = [] } = useQuery({
    queryKey: ['approvals', status],
    queryFn: () => api.get<PendingApproval[]>(`/api/approvals?status=${status}`),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['approvals'] });
    queryClient.invalidateQueries({ queryKey: ['approval-count'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const decide = useMutation({
    mutationFn: ({ row, approve, note }: { row: PendingApproval; approve: boolean; note: string }) =>
      api.post(`${apiFor[row.type]}/${row.id}/approve`, { approve, note }),
    onSuccess: () => {
      invalidate();
      setRejecting(null);
      setNote('');
    },
  });

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Documents waiting for you before they can be sent to customers"
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
            <option value="pending">Awaiting approval</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
        }
      />
      <ErrorText error={decide.error} />
      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState message={status === 'pending' ? 'Nothing is waiting for approval. 🎉' : `No ${status} documents.`} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Document</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Prepared by</th>
                <th className="pb-2 pr-3 text-right">Value</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.type}-${r.id}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-medium text-brand-600">
                    <Link to={`${routeFor[r.type]}/${r.id}`}>{r.number}</Link>
                  </td>
                  <td className="py-2 pr-3">
                    {labelFor[r.type]}
                    <span className="ml-1 text-xs text-slate-400">{r.is_export ? 'Export' : 'Domestic'}</span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(r.date)}</td>
                  <td className="py-2 pr-3">{r.customer_name}</td>
                  <td className="py-2 pr-3">{r.created_by_name ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(r.grand_total, r.currency)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <a href={`/api/pdf/${r.type}/${r.id}`} target="_blank" rel="noreferrer">
                      <Button variant="ghost">Preview</Button>
                    </a>
                    {status === 'pending' && (
                      <>
                        <Button
                          className="ml-1"
                          onClick={() => decide.mutate({ row: r, approve: true, note: '' })}
                          disabled={decide.isPending}
                        >
                          Approve
                        </Button>
                        <Button variant="danger" className="ml-1" onClick={() => { setNote(''); setRejecting(r); }}>
                          Reject
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {rejecting && (
        <Modal title={`Reject ${rejecting.number}`} onClose={() => setRejecting(null)}>
          <div className="space-y-3">
            <Field label="Reason (the preparer will see this)">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Price for item 2 is below the approved floor — revise and resubmit." />
            </Field>
            <ErrorText error={decide.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => decide.mutate({ row: rejecting, approve: false, note })} disabled={decide.isPending}>
                Reject Document
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
