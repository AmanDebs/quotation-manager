import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { User, TeamRole } from '../types';
import { TEAM_ROLES, teamRoleLabel } from '../types';
import { useUser } from '../App';
import { Button, Input, Select, Field, PageHeader, EmptyState, ErrorText, Modal, Card, TH_CLASS } from '../components/ui';

interface Draft { id?: number; name: string; email: string; password: string; team_role: TeamRole }

/** What the reset hands back — the password exists here and nowhere else. */
interface ResetResult { name: string; email: string; active: boolean; password: string }

export default function TeamPage() {
  const me = useUser();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  /** Whose password is being reset. The dialog is the same one before and after. */
  const [resetting, setResetting] = useState<User | null>(null);
  const [copied, setCopied] = useState(false);

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

  /*
   * The password is generated on the server and returned **once**. It lives in
   * this mutation's result and nowhere else — not in the users list, not in the
   * database in clear — which is why the dialog says to copy it before closing
   * and why closing throws it away rather than offering to show it again.
   */
  const resetPassword = useMutation({
    mutationFn: (u: User) => api.post<ResetResult>(`/api/users/${u.id}/reset-password`, {}),
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
              <tr className={TH_CLASS}>
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
                        {/* Not on your own row: a reset signs every session on
                            the account out and hands back no fresh cookie, so
                            pressed here it would sign you out of the tab
                            showing the only copy of the new password. Your own
                            is *Change password* at the foot of the sidebar,
                            which asks for the current one and keeps you in. */}
                        <Button
                          variant="secondary"
                          className="ml-1"
                          onClick={() => { resetPassword.reset(); setCopied(false); setResetting(u); }}
                        >
                          Reset password
                        </Button>
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

      {resetting && (
        <Modal
          title={resetPassword.data ? 'New password' : `Reset password for ${resetting.name}`}
          onClose={() => setResetting(null)}
        >
          {resetPassword.data ? (
            <div className="space-y-3 text-sm">
              <p className="text-slate-600">
                {resetPassword.data.name}&rsquo;s password has been reset and every session on the
                account signed out. Give them this, privately:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-slate-50 px-3 py-2 text-base font-semibold tracking-wide text-slate-800 ring-1 ring-inset ring-slate-200">
                  {resetPassword.data.password}
                </code>
                <Button
                  variant="secondary"
                  onClick={() => {
                    // Best effort: the clipboard is refused outside a secure
                    // context, and the password is on screen to be read either
                    // way — so a failure says nothing rather than alarming.
                    navigator.clipboard?.writeText(resetPassword.data!.password).then(
                      () => setCopied(true),
                      () => setCopied(false)
                    );
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs text-slate-400">
                Shown once and stored nowhere — copy it before closing. They should change it under
                <strong> Change password</strong> at the foot of their own sidebar once they are in.
              </p>
              {!resetPassword.data.active && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
                  This account is deactivated, so sign-in is refused even with the right password.
                  Reactivate it first.
                </p>
              )}
              <div className="flex justify-end">
                <Button onClick={() => setResetting(null)}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-slate-600">
                A new password will be generated for <strong>{resetting.name}</strong> ({resetting.email})
                and shown to you once. Every session that account has open is signed out.
              </p>
              <p className="text-xs text-slate-400">
                Use this when somebody has forgotten theirs. To set a particular password instead,
                use <strong>Edit</strong>.
              </p>
              <ErrorText error={resetPassword.error} />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setResetting(null)}>Cancel</Button>
                <Button onClick={() => resetPassword.mutate(resetting)} disabled={resetPassword.isPending}>
                  Reset Password
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}

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
