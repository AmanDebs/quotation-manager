import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { User, TeamRole } from '../types';
import { TEAM_ROLES, teamRoleLabel } from '../types';
import { useUser } from '../App';
import { Button, Input, Select, Field, PageHeader, EmptyState, ErrorText, Modal, Card } from '../components/ui';

interface Draft { id?: number; name: string; email: string; password: string; team_role: TeamRole }

export default function TeamPage() {
  const me = useUser();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id
        ? api.put<User>(`/api/users/${d.id}`, { name: d.name, email: d.email, team_role: d.team_role, ...(d.password ? { password: d.password } : {}) })
        : api.post<User>('/api/users', d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditing(null);
    },
  });

  const toggleActive = useMutation({
    mutationFn: (u: User) => api.put(`/api/users/${u.id}`, { active: !u.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const set = (patch: Partial<Draft>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="Employees see only the customers assigned to them; managers see everything and approve documents"
        actions={
          <Button onClick={() => { save.reset(); setEditing({ name: '', email: '', password: '', team_role: 'sales' }); }}>
            + Add Employee
          </Button>
        }
      />
      <ErrorText error={toggleActive.error ?? remove.error} />
      <Card className="overflow-x-auto">
        {users.length === 0 ? (
          <EmptyState message="No users yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Email</th>
                <th className="pb-2 pr-3">Role</th>
                <th className="pb-2 pr-3 text-right">Customers</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={`border-b border-slate-100 last:border-0 ${u.active ? '' : 'opacity-50'}`}>
                  <td className="py-2 pr-3 font-medium">
                    {u.name}{u.id === me.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}
                  </td>
                  <td className="py-2 pr-3">{u.email}</td>
                  <td className="py-2 pr-3">{teamRoleLabel(u.team_role)}</td>
                  <td className="py-2 pr-3 text-right">{u.customer_count ?? 0}</td>
                  <td className="py-2 pr-3">{u.active ? 'Active' : 'Deactivated'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button variant="ghost" onClick={() => { save.reset(); setEditing({ id: u.id, name: u.name, email: u.email, password: '', team_role: u.team_role ?? 'sales' }); }}>
                      Edit
                    </Button>
                    {u.id !== me.id && (
                      <>
                        <Button variant="secondary" className="ml-1" onClick={() => toggleActive.mutate(u)}>
                          {u.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                        <Button
                          variant="danger"
                          className="ml-1 border-0"
                          onClick={() => { if (confirm(`Delete ${u.name}?`)) remove.mutate(u.id); }}
                        >
                          Delete
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
      <p className="mt-3 text-xs text-slate-400">
        Employees cannot open Settings, Team or Approvals, and can only see customers assigned to them. Assign a customer's owner on the customer's page.
      </p>

      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'Add Employee'} onClose={() => setEditing(null)}>
          <div className="space-y-3">
            <Field label="Name *"><Input value={editing.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Email *"><Input type="email" value={editing.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label={editing.id ? 'New Password (leave blank to keep current)' : 'Starting Password *'}>
              <Input type="text" value={editing.password} onChange={(e) => set({ password: e.target.value })} placeholder="At least 6 characters" />
            </Field>
            <Field label="Role">
              <Select value={editing.team_role} onChange={(e) => set({ team_role: e.target.value as TeamRole })}>
                {TEAM_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-slate-400">Share the starting password privately; they can change it later from their own account.</p>
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                onClick={() => save.mutate(editing)}
                disabled={save.isPending || !editing.name.trim() || !editing.email.trim() || (!editing.id && editing.password.length < 6)}
              >
                {editing.id ? 'Save Changes' : 'Create Account'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
