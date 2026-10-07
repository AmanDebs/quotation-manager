import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { usePatchUser } from '../App';
import type { Level, User } from '../types';
import {
  Button, Card, CAPTION_CLASS, EmptyState, ErrorText, PageHeader, SegmentedTabs, Select, TH_CLASS,
} from '../components/ui';
import { useUrlFilter } from '../lib/useUrlFilter';

/**
 * Who may do what, as ticks.
 *
 * The client's own words (2026-09-24): *"i do not like the current user
 * matrix, can you create a module - user permission with checkboxes"*. The
 * matrix was the one in their ERP specification, written into the code — right
 * on the day it shipped and not something a business should have to ask for a
 * release to change. Then (2026-10-07): *"USER wise access rather than
 * department wise access"*.
 *
 * So the page has **two views over one grid**, and the order is the answer to
 * that second message: it opens on **By person**, and **By team** is the other
 * tab. Both are drawn by `AccessGrid` rather than by two copies of the tick
 * ladder, which is how the two would come to disagree about what a tick means.
 *
 * Four things decide how it is drawn.
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
 * **A person is shown beside their team, not instead of it.** Their own ticks
 * are stored only where they *differ*, so the team column is what the person
 * column means: untick everything of their own and they follow Sales again,
 * and a later correction to Sales reaches them. Drawing the person alone would
 * hide that, and somebody would wonder why a cell they never touched moved.
 *
 * **The Super Admin is ticked and disabled**, in both views. That account is
 * the way back in: untick `team` on it and nobody can open this page again,
 * including whoever just did it. The server refuses it too — this is the
 * explanation, not the guard.
 */

type Fn = string;
type AccessMap = Record<string, Record<Fn, Level>>;

interface RoleRow {
  role: string;
  label: string;
  editable: boolean;
  customised: number;
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  team_role: string;
  team_label: string;
  editable: boolean;
  access: Record<Fn, Level>;
  team_access: Record<Fn, Level>;
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
  users: UserRow[];
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

/**
 * One column of ticks: a team, a person, or a person's team shown read-only
 * beside them.
 *
 * `set` absent is a column somebody reads rather than edits, and `allOn` is the
 * Super Admin's — drawn ticked whatever the data says, because that account
 * holds everything by definition.
 */
interface GridColumn {
  key: string;
  label: string;
  caption: ReactNode;
  level: (fn: Fn) => Level;
  set?: (fn: Fn, level: Level) => void;
  changed?: (fn: Fn) => boolean;
  allOn?: boolean;
}

function AccessGrid({ functions, groups, columns }: {
  functions: FunctionRow[];
  groups: string[];
  columns: GridColumn[];
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-3 text-left">Permission</th>
            {columns.map((c) => (
              <th key={c.key} className="px-2 pb-2 text-center" colSpan={2}>
                <div className="whitespace-nowrap">{c.label}</div>
                <div className="mt-0.5 h-4 text-[10px] font-normal normal-case tracking-normal">{c.caption}</div>
              </th>
            ))}
          </tr>
          <tr className={`${CAPTION_CLASS} border-b border-slate-200`}>
            <th className="pb-1" />
            {columns.map((c) => (
              <Fragment key={c.key}>
                <th className="px-1 pb-1 text-center font-medium text-slate-400">View</th>
                <th className="px-1 pb-1 text-center font-medium text-slate-400">Edit</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group}>
              <tr>
                <td
                  colSpan={1 + columns.length * 2}
                  className="bg-slate-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                >
                  {group}
                </td>
              </tr>
              {functions.filter((f) => f.group === group).map((f) => (
                <tr key={f.fn} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3">
                    <div className="font-medium text-slate-800">{f.label}</div>
                    <div className="text-xs text-slate-400">{f.hint}</div>
                  </td>
                  {columns.map((c) => {
                    const on = isTicked(f, c.level(f.fn));
                    const slot = SLOT[f.levels];
                    const editable = !!c.set && !c.allOn;
                    const cell = (which: 'view' | 'edit') => (
                      <td
                        key={`${c.key}-${f.fn}-${which}`}
                        className={`px-1 text-center ${c.changed?.(f.fn) ? 'bg-amber-50' : ''}`}
                      >
                        {slot[which] ? (
                          <input
                            type="checkbox"
                            /*
                             * A locked column keeps its tick at full strength,
                             * in grey rather than faded: at 40% opacity a
                             * ticked box washes out to an empty one, so the one
                             * column that means *everything* read as *nothing*
                             * — the opposite of the truth, on the column
                             * somebody checks first.
                             */
                            className={`h-4 w-4 ${editable ? 'accent-brand-600' : 'accent-slate-400 cursor-not-allowed'}`}
                            checked={c.allOn ? true : on[which]}
                            disabled={!editable}
                            title={c.allOn ? 'The Super Admin has every permission' : undefined}
                            onChange={(e) => {
                              const next = e.target.checked;
                              // Edit implies View, and losing View loses Edit:
                              // the levels are a ladder, not two flags.
                              const view = which === 'view' ? next : next || on.view;
                              const edit = which === 'edit' ? next : next && on.edit;
                              c.set?.(f.fn, levelOf(f, view, edit));
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
  );
}

export default function PermissionsPage() {
  const queryClient = useQueryClient();
  const patchUser = usePatchUser();
  const [view, setView] = useUrlFilter('view', 'person');
  const [who, setWho] = useUrlFilter('who');
  const [roleDraft, setRoleDraft] = useState<AccessMap | null>(null);
  const [userDraft, setUserDraft] = useState<AccessMap | null>(null);

  const { data } = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.get<Matrix>('/api/permissions'),
  });

  // Memoised because they are fallback objects: rebuilt each render they would
  // make the comparisons below run on every keystroke anywhere on the page.
  const live = useMemo<AccessMap>(() => data?.access ?? {}, [data]);
  const liveUsers = useMemo<AccessMap>(() => {
    const out: AccessMap = {};
    for (const u of data?.users ?? []) out[String(u.id)] = u.access;
    return out;
  }, [data]);

  const access = roleDraft ?? live;
  const userAccess = userDraft ?? liveUsers;

  /** Every cell that differs from what is saved, by team. */
  const pendingRoles = useMemo(() => {
    if (!roleDraft || !data) return [] as { key: string; label: string; count: number }[];
    return data.roles
      .map((r) => ({
        key: r.role,
        label: r.label,
        count: data.functions.filter((f) => roleDraft[r.role]?.[f.fn] !== live[r.role]?.[f.fn]).length,
      }))
      .filter((r) => r.count > 0);
  }, [roleDraft, data, live]);

  /** And by person. */
  const pendingUsers = useMemo(() => {
    if (!userDraft || !data) return [] as { key: string; label: string; count: number }[];
    return data.users
      .map((u) => ({
        key: String(u.id),
        label: u.name,
        count: data.functions.filter((f) => userDraft[String(u.id)]?.[f.fn] !== liveUsers[String(u.id)]?.[f.fn]).length,
      }))
      .filter((u) => u.count > 0);
  }, [userDraft, data, liveUsers]);

  const byPerson = view !== 'team';
  /*
   * The bar counts **both** views, which the render corrected: it showed only
   * the view you were on, so editing a person and then switching to By team
   * hid the unsaved changes entirely — still in state, nothing on screen to
   * say so, and Discard on the other tab would have thrown them away silently.
   * One bar over both, and Save writes both.
   */
  const pending = [...pendingUsers, ...pendingRoles];

  const save = useMutation({
    mutationFn: async () => {
      // One request per row that moved. They are independent rows, and one
      // whose save fails must not take the others with it.
      if (userDraft) {
        for (const { key } of pendingUsers) await api.put(`/api/permissions/user/${key}`, { access: userDraft[key] });
      }
      if (roleDraft) {
        for (const { key } of pendingRoles) await api.put(`/api/permissions/${key}`, { access: roleDraft[key] });
      }
    },
    onSuccess: async () => {
      setRoleDraft(null);
      setUserDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['permissions'] });
      // The session is read once, on mount, so a change to your own row would
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

  const setRole = (role: string, fn: Fn, level: Level) =>
    setRoleDraft((prev) => {
      const base = prev ?? live;
      return { ...base, [role]: { ...base[role], [fn]: level } };
    });

  const setUser = (id: string, fn: Fn, level: Level) =>
    setUserDraft((prev) => {
      const base = prev ?? liveUsers;
      return { ...base, [id]: { ...base[id], [fn]: level } };
    });

  /*
   * The person the page is on. `who` lives in the URL so one person's access is
   * a link somebody can send; falling back to an account rather than to
   * nothing, because an empty grid under a picker reads as a page that failed.
   *
   * The fallback is the first **editable** one, which the render corrected: the
   * list is alphabetical and the super admin came first on the seed, so the
   * page opened on the one account whose every box is locked — 84 disabled
   * ticks, which reads as a page that does not work rather than as the one
   * account that may do everything.
   */
  const selected = data.users.find((u) => String(u.id) === who)
    ?? data.users.find((u) => u.editable)
    ?? data.users[0];

  const roleColumns: GridColumn[] = data.roles.map((r) => ({
    key: r.role,
    label: r.label,
    caption: !r.editable ? (
      <span className="text-slate-400">every permission</span>
    ) : r.customised > 0 ? (
      <button
        type="button"
        className="text-brand-600 hover:underline"
        onClick={() => setRoleDraft((prev) => ({ ...(prev ?? live), [r.role]: { ...data.recommended[r.role] } }))}
        title="Put this team back on the recommended matrix"
      >
        {r.customised} changed · reset
      </button>
    ) : (
      <span className="text-slate-300">as recommended</span>
    ),
    level: (fn) => access[r.role]?.[fn] ?? 'none',
    set: r.editable ? (fn, level) => setRole(r.role, fn, level) : undefined,
    changed: (fn) => access[r.role]?.[fn] !== live[r.role]?.[fn],
    allOn: !r.editable,
  }));

  const userColumns: GridColumn[] = selected ? [
    {
      // Read-only, and present for the reason the header note gives: a
      // person's ticks are stored only where they differ from this.
      key: 'team',
      label: selected.team_label || 'No team',
      caption: <span className="text-slate-400">their team</span>,
      level: (fn) => selected.team_access?.[fn] ?? 'none',
    },
    {
      key: String(selected.id),
      label: selected.name,
      caption: !selected.editable ? (
        <span className="text-slate-400">every permission</span>
      ) : selected.customised > 0 ? (
        <button
          type="button"
          className="text-brand-600 hover:underline"
          onClick={() => setUserDraft((prev) => ({
            ...(prev ?? liveUsers),
            [String(selected.id)]: { ...selected.team_access },
          }))}
          title="Put this person back on their team's permissions"
        >
          {selected.customised} of their own · reset
        </button>
      ) : (
        <span className="text-slate-300">follows their team</span>
      ),
      level: (fn) => userAccess[String(selected.id)]?.[fn] ?? 'none',
      set: selected.editable ? (fn, level) => setUser(String(selected.id), fn, level) : undefined,
      changed: (fn) => userAccess[String(selected.id)]?.[fn] !== liveUsers[String(selected.id)]?.[fn],
      allOn: !selected.editable,
    },
  ] : [];

  return (
    <div className="pb-24">
      <PageHeader
        title="User Permissions"
        subtitle="What each person may open, and what they may change. Takes effect immediately — nobody has to sign in again."
        actions={
          <SegmentedTabs
            value={byPerson ? 'person' : 'team'}
            onChange={(v) => setView(v)}
            tabs={[{ key: 'person', label: 'By person' }, { key: 'team', label: 'By team' }]}
          />
        }
      />
      <ErrorText error={save.error} />

      {byPerson && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Select
            className="max-w-xs"
            value={selected ? String(selected.id) : ''}
            onChange={(e) => setWho(e.target.value)}
          >
            {data.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.team_label || 'no team'}
                {u.customised > 0 ? ` (${u.customised} of their own)` : ''}
              </option>
            ))}
          </Select>
          {pendingUsers.length > 0 && (
            <span className="text-xs text-slate-500">
              Unsaved changes for {pendingUsers.map((u) => u.label).join(', ')}
            </span>
          )}
        </div>
      )}

      {byPerson && !selected ? (
        <EmptyState message="No active accounts to set permissions for." />
      ) : (
        <AccessGrid
          functions={data.functions}
          groups={data.groups}
          columns={byPerson ? userColumns : roleColumns}
        />
      )}

      <p className="mt-3 text-xs text-slate-500">
        {byPerson ? (
          <>
            A person follows their team until you tick something of their own, and only the differences are
            stored — so correcting the team still reaches everybody who was never moved off it, and
            <strong> reset</strong> puts this person back on it.{' '}
          </>
        ) : null}
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
              <Button
                variant="ghost"
                onClick={() => { setUserDraft(null); setRoleDraft(null); }}
                disabled={save.isPending}
              >
                Discard
              </Button>
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
