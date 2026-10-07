import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useCan } from '../App';
import type { Level } from '../types';
import { Card, EmptyState, PageHeader } from '../components/ui';

/**
 * What you yourself may do.
 *
 * Your team's row, with your own ticks over it where somebody has set any
 * (2026-10-07) — and the two are drawn apart, because *"I have this because I
 * am on Sales"* and *"somebody set this for me"* are different answers to the
 * same question, and only the second has a person behind it to ask about it.
 *
 * The permissions page answers *who may do what* and is the administrator's;
 * this answers *what may I do*, which is the question somebody actually has —
 * usually the moment a screen is missing from their sidebar or a button is not
 * there. Before this the only answer was to ask whoever holds the Team cell.
 *
 * **It is the one page in the app with no gate**, which is deliberate and is
 * the whole point: a page that explains a refusal is no use if it can itself
 * be refused, and since the matrix became editable there is no function left
 * that everybody is guaranteed to hold. It reveals nothing — a team's own
 * permissions are what that team keeps running into all day.
 *
 * The levels come from `capabilities` on the server, the same function that
 * builds the map `/auth/me` hands the app to draw itself with, so this cannot
 * say one thing while the sidebar does another.
 */

interface FunctionRow {
  fn: string;
  label: string;
  group: string;
  levels: 'both' | 'view' | 'full';
  hint: string;
}

interface Mine {
  role: string;
  label: string;
  functions: FunctionRow[];
  groups: string[];
  access: Record<string, Level>;
  /** What the team alone says, so a cell set for this person can be marked. */
  team_access: Record<string, Level>;
  /** How many of them there are. */
  own: number;
}

type Tone = 'full' | 'view' | 'none';

/**
 * What a level means **for this function**, in words rather than in the
 * vocabulary of the table.
 *
 * `full` is not always "view and edit": the Activity Log has nothing to
 * change, and Backup is one act. Saying *Full access* against those would
 * describe a permission nobody holds.
 */
function stateOf(f: FunctionRow, level: Level): { label: string; tone: Tone } {
  if (level === 'none') return { label: 'No access', tone: 'none' };
  if (f.levels === 'view') return { label: 'Can open', tone: 'full' };
  if (f.levels === 'full') return { label: 'Allowed', tone: 'full' };
  return level === 'full'
    ? { label: 'View and edit', tone: 'full' }
    : { label: 'View only', tone: 'view' };
}

const PILL: Record<Tone, string> = {
  full: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  view: 'bg-sky-50 text-sky-700 ring-sky-200',
  none: 'bg-slate-50 text-slate-400 ring-slate-200',
};

const SUMMARY: { tone: Tone; label: string }[] = [
  { tone: 'full', label: 'you can use' },
  { tone: 'view', label: 'read only' },
  { tone: 'none', label: 'not yours' },
];

export default function MyAccessPage() {
  const can = useCan();
  const { data } = useQuery({
    queryKey: ['permissions', 'mine'],
    queryFn: () => api.get<Mine>('/api/permissions/mine'),
  });

  if (!data) return null;

  const tones = data.functions.map((f) => stateOf(f, data.access[f.fn] ?? 'none').tone);
  const count = (tone: Tone) => tones.filter((t) => t === tone).length;
  const mine = (fn: string) => (data.access[fn] ?? 'none') !== (data.team_access?.[fn] ?? 'none');
  /*
   * A person on no team at all used to be the end of the page — there was
   * nothing a team could grant them. There is now: somebody can tick a
   * function for them directly, so the page is empty only when nothing at all
   * is open, which is the honest condition and the one the pills already read.
   */
  const nothing = !data.label && data.own === 0;

  return (
    <div>
      <PageHeader
        title="My Access"
        subtitle={
          // Not "your administrator sets this": on the Super Admin's own
          // account that is the person reading it. Who sets it is the footnote
          // below, which knows whether that is them.
          data.label
            ? `What your account may open and change — a ${data.label} account, with ${
              data.own === 0 ? 'nothing' : `${data.own} permission${data.own === 1 ? '' : 's'}`
            } set for you personally.`
            : 'Your account is on no team, so it holds only what has been set for it directly.'
        }
      />

      {nothing ? (
        <Card>
          <EmptyState message="No team, and nothing set for you, so nothing is open yet. Whoever manages your accounts can put you on a team or tick what you need." />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {SUMMARY.map((s) => (
              <span
                key={s.tone}
                className={`inline-flex items-baseline gap-1.5 rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset ${PILL[s.tone]}`}
              >
                <strong className="text-base font-semibold">{count(s.tone)}</strong>
                <span>{s.label}</span>
              </span>
            ))}
          </div>

          <Card>
            {data.groups.map((group) => {
              const rows = data.functions.filter((f) => f.group === group);
              if (!rows.length) return null;
              return (
                <div key={group} className="mb-5 last:mb-0">
                  <div className="mb-2 border-b border-slate-200 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {group}
                  </div>
                  <div className="grid gap-x-8 lg:grid-cols-2">
                    {rows.map((f) => {
                      const state = stateOf(f, data.access[f.fn] ?? 'none');
                      return (
                        <div
                          key={f.fn}
                          className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 last:border-0 lg:last:border-b"
                        >
                          <div className="min-w-0">
                            <div className={`font-medium ${state.tone === 'none' ? 'text-slate-400' : 'text-slate-800'}`}>
                              {f.label}
                              {mine(f.fn) && (
                                <span
                                  className="ml-1.5 align-middle text-[10px] font-normal uppercase tracking-wide text-amber-600"
                                  title={`Set for you. ${data.label || 'Your team'} alone would be: ${stateOf(f, data.team_access?.[f.fn] ?? 'none').label.toLowerCase()}`}
                                >
                                  set for you
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400">{f.hint}</div>
                          </div>
                          <span
                            className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL[state.tone]}`}
                          >
                            {state.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </Card>

          <p className="mt-3 text-xs text-slate-500">
            {can('team', 'full') ? (
              <>
                You set these yourself on the <Link className="text-brand-600 hover:underline" to="/permissions">User Permissions</Link> page.
              </>
            ) : (
              'If you need something that is not open to you, ask whoever manages the accounts here — it is one tick on their side.'
            )}
          </p>
        </>
      )}
    </div>
  );
}
