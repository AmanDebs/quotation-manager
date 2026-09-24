import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { usePatchUser } from '../App';
import type { Level, User } from '../types';
import { Button, Card, CAPTION_CLASS, EmptyState, ErrorText, PageHeader, TH_CLASS } from '../components/ui';

/**
 * Who may do what, as ticks.
 *
 * The client's own words (2026-09-24): *"i do not like the current user
 * matrix, can you create a module - user permission with checkboxes"*. The
 * matrix was the one in their ERP specification, written into the code — right
 * on the day it shipped and not something a business should have to ask for a
 * release to change.
 *
 * Four things decide how it is drawn.
 *
 * **The whole matrix is on one screen.** It is a matrix, and the question it
 * exists to answer — *who can approve an invoice?* — is a column read down,
 * which a page showing one team at a time cannot answer at all.
 *
 * **Two ticks per cell, not three levels.** *View* opens the screen, *Edit*
 * changes what is on it, and neither is *no access* — which is what the levels
 * `none`/`view`/`full` already mean, said in words somebody can act on.
 * Ticking Edit ticks View with it, because a level that could edit what it
 * cannot open would be a state the server has no way to store.
 *
 * **A tick that would do nothing is not drawn.** `team` is mounted at full and
 * nothing anywhere asks to merely *view* it, so a View box beside it would be
 * a control somebody ticks and then concludes the page is broken by. The
 * server says which levels a function has (`FUNCTION_META.levels`) and the
 * empty slot reads as a dash, the *Dest Port* rule — a blank cell looks like a
 * fault, a dash looks like an absence.
 *
 * **The Super Admin column is ticked and disabled.** That row is the way back
 * in: untick `team` on it and nobody can open this page again, including
 * whoever just did it. The server refuses it too — this is the explanation,
 * not the guard.
 */

type Fn = string;
type AccessMap = Record<string, Record<Fn, Level>>;

interface RoleRow {
  role: string;
  label: string;
  editable: boolean;
  customised: number;
}

interface FunctionRow {
  fn: Fn;
  label: string;
  group: string;
  levels: 'both' | 'view' | 'full';
  hint: string;
}

interface Matrix {
  roles: RoleRow[];
  functions: FunctionRow[];
  groups: string[];
  access: AccessMap;
  recommended: AccessMap;
}

/** Which box a single-level function draws, so the column still lines up. */
const SLOT: Record<FunctionRow['levels'], { view: boolean; edit: boolean }> = {
  both: { view: true, edit: true },
  view: { view: true, edit: false },
  full: { view: false, edit: true },
};

/** What a tick means for this function — `full` is all-or-nothing. */
const levelOf = (f: FunctionRow, view: boolean, edit: boolean): Level =>
  edit ? 'full' : view ? (f.levels === 'full' ? 'full' : 'view') : 'none';

const isTicked = (f: FunctionRow, level: Level) => ({
  view: level !== 'none',
  edit: level === 'full',
});

export default function PermissionsPage() {
  const queryClient = useQueryClient();
  const patchUser = usePatchUser();
  const [draft, setDraft] = useState<AccessMap | null>(null);

  const { data } = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.get<Matrix>('/api/permissions'),
  });

  // Memoised because it is a fallback object: rebuilt each render it would
  // make the comparison below run on every keystroke anywhere on the page.
  const live = useMemo<AccessMap>(() => data?.access ?? {}, [data]);
  const access = draft ?? live;

  /** Every cell that differs from what is saved, by team. */
  const pending = useMemo(() => {
    if (!draft || !data) return [] as { role: string; label: string; count: number }[];
    return data.roles
      .map((r) => ({
        role: r.role,
        label: r.label,
        count: data.functions.filter((f) => draft[r.role]?.[f.fn] !== live[r.role]?.[f.fn]).length,
      }))
      .filter((r) => r.count > 0);
  }, [draft, data, live]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      // One request per team that moved. They are independent rows, and a team
      // whose save fails must not take the others with it.
      for (const { role } of pending) {
        await api.put(`/api/permissions/${role}`, { access: draft[role] });
      }
    },
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['permissions'] });
      // The session is read once, on mount, so a change to your own team would
      // otherwise be right on the server and stale in the sidebar beside it.
      try {
        const me = await api.get<User>('/api/auth/me');
        patchUser({ can: me.can });
      } catch {
        // A refused /auth/me is the session's problem, not this save's; the
        // client's own 401 handler owns that.
      }
    },
  });

  if (!data) return null;
  if (!data.functions.length) return <EmptyState message="No permissions to show." />;

  const set = (role: string, fn: Fn, level: Level) =>
    setDraft((prev) => {
      const base = prev ?? live;
      return { ...base, [role]: { ...base[role], [fn]: level } };
    });

  const resetRole = (role: string) =>
    setDraft((prev) => ({ ...(prev ?? live), [role]: { ...data.recommended[role] } }));

  const changed = (role: string, fn: Fn) => access[role]?.[fn] !== live[role]?.[fn];

  return (
    <div className="pb-24">
      <PageHeader
        title="User Permissions"
        subtitle="What each team may open, and what it may change. Takes effect immediately — nobody has to sign in again."
      />
      <ErrorText error={save.error} />

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={TH_CLASS}>
              <th className="pb-2 pr-3 text-left">Permission</th>
              {data.roles.map((r) => (
                <th key={r.role} className="px-2 pb-2 text-center" colSpan={2}>
                  <div className="whitespace-nowrap">{r.label}</div>
                  <div className="mt-0.5 h-4 text-[10px] font-normal normal-case tracking-normal">
                    {!r.editable ? (
                      <span className="text-slate-400">every permission</span>
                    ) : r.customised > 0 ? (
                      <button
                        type="button"
                        className="text-brand-600 hover:underline"
                        onClick={() => resetRole(r.role)}
                        title="Put this team back on the recommended matrix"
                      >
                        {r.customised} changed · reset
                      </button>
                    ) : (
                      <span className="text-slate-300">as recommended</span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
            <tr className={`${CAPTION_CLASS} border-b border-slate-200`}>
              <th className="pb-1" />
              {data.roles.map((r) => (
                <Fragment key={r.role}>
                  <th className="px-1 pb-1 text-center font-medium text-slate-400">View</th>
                  <th className="px-1 pb-1 text-center font-medium text-slate-400">Edit</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.groups.map((group) => (
              <Fragment key={group}>
                <tr>
                  <td
                    colSpan={1 + data.roles.length * 2}
                    className="bg-slate-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {group}
                  </td>
                </tr>
                {data.functions.filter((f) => f.group === group).map((f) => (
                  <tr key={f.fn} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3">
                      <div className="font-medium text-slate-800">{f.label}</div>
                      <div className="text-xs text-slate-400">{f.hint}</div>
                    </td>
                    {data.roles.map((r) => {
                      const level = access[r.role]?.[f.fn] ?? 'none';
                      const on = isTicked(f, level);
                      const slot = SLOT[f.levels];
                      const cell = (which: 'view' | 'edit') => (
                        <td
                          key={`${r.role}-${f.fn}-${which}`}
                          className={`px-1 text-center ${changed(r.role, f.fn) ? 'bg-amber-50' : ''}`}
                        >
                          {slot[which] ? (
                            <input
                              type="checkbox"
                              /*
                               * The locked column keeps its tick at full
                               * strength, in grey rather than faded: at 40%
                               * opacity a ticked box washes out to an empty
                               * one, so the one column that means *everything*
                               * read as *nothing* — the opposite of the truth,
                               * on the column somebody checks first.
                               */
                              className={`h-4 w-4 ${r.editable ? 'accent-brand-600' : 'accent-slate-400 cursor-not-allowed'}`}
                              checked={r.editable ? on[which] : true}
                              disabled={!r.editable}
                              title={r.editable ? undefined : 'The Super Admin has every permission'}
                              onChange={(e) => {
                                const next = e.target.checked;
                                // Edit implies View, and losing View loses Edit:
                                // the levels are a ladder, not two flags.
                                const view = which === 'view' ? next : next || on.view;
                                const edit = which === 'edit' ? next : next && on.edit;
                                set(r.role, f.fn, levelOf(f, view, edit));
                              }}
                            />
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      );
                      return [cell('view'), cell('edit')];
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="mt-3 text-xs text-slate-500">
        A dash is a permission that has only one setting — the Dashboard and the Activity Log can only be read,
        while the Team, Settings, Backup and Purchase Orders pages are all-or-nothing. Logistics may only write
        <strong> export</strong> invoices, whatever is ticked here: that is a rule about which rows, not about access,
        and it cannot be said with a tick.
      </p>

      {/*
        Sticky rather than fixed: the sidebar has a collapsed rail, so a bar
        positioned against the viewport would have to know which width it is
        at. Inside the content column it simply follows it.
      */}
      {pending.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-4 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-slate-700">
              {pending.reduce((a, r) => a + r.count, 0)} change{pending.reduce((a, r) => a + r.count, 0) === 1 ? '' : 's'}
              {' · '}
              <span className="text-slate-500">{pending.map((r) => r.label).join(', ')}</span>
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>Discard</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save permissions'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
