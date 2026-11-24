import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useCan } from '../App';
import type { ProductionRun, RunSetup } from '../types';
import { PageHeader, Card, Input, EmptyState, Select, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import { fmtQty, fmtDate, today, addDays } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import RunDialog from '../components/RunDialog';

/**
 * The shift plan — a board of what every line is making, shift by shift
 * (2026-11-24, the brief's *"clear production scheduling calendar"*).
 *
 * **A cell is a run**, and a run is one product, one colour and one changeover
 * — which is why a cell can state what it is making in one line and why
 * clicking an empty one is how a run is planned. The hierarchy's bottom three
 * levels (date → line → shift) are the grid itself.
 *
 * It is deliberately **not the Work Orders grid with more columns**: that
 * screen is read down a list of jobs, and this one is read across a calendar.
 * The brief asked for both and asked that neither crowd the other.
 */

/** A fortnight, which is about what a planner can hold in view. */
const DEFAULT_DAYS = 14;

/** Every date from..to, so an empty day is drawn rather than skipped. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from, i = 0; d && d <= to && i < 120; d = addDays(d, 1), i++) out.push(d);
  return out;
}

export default function ShiftPlanPage() {
  const can = useCan();
  const mayPlan = can('work_order', 'full');
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [lineFilter, setLineFilter] = useUrlFilter('machine_id');
  const [editing, setEditing] = useState<
    { run: ProductionRun | null; seed: { date: string; machine_id: number; shift: string } } | null
  >(null);

  const start = from || today();
  const end = to || addDays(start, DEFAULT_DAYS - 1);

  const { data: setup } = useQuery<RunSetup>({
    queryKey: ['run-setup'],
    queryFn: () => api.get<RunSetup>('/api/production-runs/setup'),
  });

  const params = new URLSearchParams({ from: start, to: end });
  if (lineFilter) params.set('machine_id', lineFilter);
  const { data: runs = [], isPending } = useQuery<ProductionRun[]>({
    queryKey: ['production-runs', start, end, lineFilter],
    queryFn: () => api.get<ProductionRun[]>(`/api/production-runs?${params.toString()}`),
  });

  const lines = (setup?.lines ?? []).filter((l) => !lineFilter || l.id === Number(lineFilter));
  const shifts = setup?.shifts ?? [];
  const days = daysBetween(start, end);
  // Keyed on the cell, so drawing the grid is a lookup rather than a scan.
  const byCell = new Map(runs.map((r) => [`${r.date}|${r.machine_id}|${r.shift}`, r]));

  const planned = runs.reduce((sum, r) => sum + r.qty_planned, 0);
  const lineDays = runs.length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shift Plan"
        subtitle="What each line is making, shift by shift"
      />

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <div className={CAPTION_CLASS}>From</div>
          <Input type="date" className="w-40" value={start} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <div className={CAPTION_CLASS}>To</div>
          <Input type="date" className="w-40" value={end} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <div className={CAPTION_CLASS}>Line</div>
          <Select className="w-52" value={lineFilter} onChange={(e) => setLineFilter(e.target.value)}>
            <option value="">All lines</option>
            {(setup?.lines ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
        <div className="ml-auto text-xs text-slate-500">
          <strong className="text-slate-900">{runs.length}</strong> run{runs.length === 1 ? '' : 's'}
          {' · '}<strong className="tabular-nums text-slate-900">{fmtQty(planned)}</strong> pieces planned
          {' · '}{lineDays} shift{lineDays === 1 ? '' : 's'} committed
        </div>
      </div>

      <Card title={`${fmtDate(start)} — ${fmtDate(end)}`}>
        {isPending ? (
          <div className="py-6 text-sm text-slate-500">Reading the board…</div>
        ) : !lines.length ? (
          <EmptyState message="No production line on file. Add one under Production Masters → Machines." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="px-3 py-2 text-left">Line</th>
                  {shifts.map((s) => <th key={s.key} className="px-3 py-2 text-left">{s.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <Fragment key={day}>
                    <tr className="border-t border-slate-200 bg-slate-50">
                      <td colSpan={shifts.length + 1} className="px-3 py-1.5 font-semibold text-slate-700">
                        {fmtDate(day)}
                      </td>
                    </tr>
                    {lines.map((l) => (
                      <tr key={`${day}|${l.id}`} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 align-top">
                          <div className="font-medium text-slate-800">{l.name}</div>
                          {l.shifts_per_day === 0 && (
                            <div className="text-[10px] text-amber-700">not running</div>
                          )}
                        </td>
                        {shifts.map((s, i) => {
                          const run = byCell.get(`${day}|${l.id}|${s.key}`);
                          // A shift the line does not run is not a slot at
                          // all: a blank cell there would invite a click the
                          // server refuses, which is the dead control rule.
                          const runs_this = i < l.shifts_per_day;
                          return (
                            <td key={s.key} className="px-3 py-1.5 align-top">
                              {!runs_this ? (
                                <span className="text-slate-300" title={`${l.name} does not run ${s.label}`}>—</span>
                              ) : run ? (
                                <RunCell
                                  run={run}
                                  onOpen={mayPlan
                                    ? () => setEditing({ run, seed: { date: day, machine_id: l.id, shift: s.key } })
                                    : undefined}
                                />
                              ) : mayPlan ? (
                                <button
                                  type="button"
                                  className="rounded px-1.5 py-0.5 text-slate-300 hover:bg-brand-50 hover:text-brand-600"
                                  title={`Plan a run on ${l.name}, ${s.label}, ${fmtDate(day)}`}
                                  onClick={() => setEditing({ run: null, seed: { date: day, machine_id: l.id, shift: s.key } })}
                                >+ plan</button>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        One run is <strong>one product and one colour</strong> — a colour change is a second run.
        A run may serve several work orders, and each one&rsquo;s share is its own, so no piece is
        ever planned twice. <strong>Of</strong> is what that line can make of that product in one
        shift, measured from the shift book; a product nobody has run yet shows none and is
        planned anyway.
      </p>

      {editing && setup && (
        <RunDialog
          run={editing.run}
          seed={editing.seed}
          setup={setup}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** One planned run, as a cell reads it. */
function RunCell({ run, onOpen }: { run: ProductionRun; onOpen?: () => void }) {
  // Over capacity is a fact about the plan rather than a refusal here — the
  // server refuses one on the way in, but a line's rate can be corrected
  // afterwards, and a plan that quietly stopped saying so would be worse.
  const over = run.capacity !== null && run.qty_planned > run.capacity;
  const body = (
    <>
      <div className="font-medium text-slate-900">
        {run.product_name || 'Custom item'}
        {run.color && <span className="ml-1.5 font-normal text-slate-500">{run.color}</span>}
      </div>
      <div className={`tabular-nums ${over ? 'text-amber-700' : 'text-slate-600'}`}>
        {fmtQty(run.qty_planned)}
        {run.capacity !== null
          ? <span className="text-slate-400"> of {fmtQty(run.capacity)}</span>
          : <span className="text-slate-300" title="No output rate for this product yet"> · no rate</span>}
      </div>
      <div className="text-[10px] text-slate-400">
        {run.allocations.length} work order{run.allocations.length === 1 ? '' : 's'}
        {run.allocations.length > 0 && ` · ${run.allocations.map((a) => a.number).join(', ')}`}
      </div>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="w-full rounded px-1.5 py-1 text-left hover:bg-brand-50"
      onClick={onOpen}
      title="Open this run"
    >{body}</button>
  ) : (
    <div className="px-1.5 py-1">
      {body}
      <div className="text-[10px]">
        {run.allocations.map((a) => (
          <Link key={a.work_order_id} to={`/work-orders/${a.work_order_id}`} className="mr-2 text-brand-600 hover:underline">
            {a.number}
          </Link>
        ))}
      </div>
    </div>
  );
}
