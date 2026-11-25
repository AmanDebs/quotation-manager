import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useCan } from '../App';
import type { ProductionRun, RunSetup } from '../types';
import { PageHeader, Card, Input, Button, EmptyState, Select, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import { fmtQty, fmtDate, today, addDays } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import RunDialog from '../components/RunDialog';
import RunActualDialog from '../components/RunActualDialog';
import ShiftPlanModal from '../components/ShiftPlanModal';

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
  // Booking what was made is the floor's own cell, not the planner's — which
  // is exactly the split the access matrix draws: Production records its
  // shifts without being able to re-plan the board.
  const mayLog = can('output', 'full');
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [lineFilter, setLineFilter] = useUrlFilter('machine_id');
  const [editing, setEditing] = useState<
    { run: ProductionRun | null; seed: { date: string; machine_id: number; shift: string } } | null
  >(null);
  const [working, setWorking] = useState(false);
  /** The run whose actuals are being recorded, if any. */
  const [recording, setRecording] = useState<number | null>(null);

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
  const made = runs.reduce((sum, r) => sum + r.made, 0);
  const lineDays = runs.length;
  /*
   * Shifts that **ran and fell short** and nobody has signed off: the
   * planner's own to-do, since signing one off is what frees the balance.
   * Counted over the board in view, which is what the figures beside it
   * describe.
   *
   * It asks whether the shift started, not only whether `shortfall` is above
   * zero — on a shift nobody has booked anything against yet that figure is
   * the whole plan, so without this the count read as every future shift on
   * the board being behind. Found by rendering it.
   */
  const toSign = runs.filter(
    (r) => r.status !== 'done' && r.shortfall > 0
      && (r.made > 0 || r.rejected > 0 || r.downtime_mins > 0),
  ).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shift Plan"
        subtitle="What each line is making, shift by shift"
        actions={mayPlan ? (
          // The press that fills the board. Behind `work_order: full` like
          // every other control here, so a view-only login sees the plan and
          // no way to change it.
          <Button onClick={() => setWorking(true)}>Work out the plan…</Button>
        ) : undefined}
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
          {made > 0 && (
            <>{' · '}<strong className="tabular-nums text-slate-900">{fmtQty(made)}</strong> made</>
          )}
          {' · '}{lineDays} shift{lineDays === 1 ? '' : 's'} committed
          {toSign > 0 && (
            <>{' · '}<strong className="text-amber-700">{toSign}</strong> short and not signed off</>
          )}
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
                                  onRecord={mayLog ? () => setRecording(run.id) : undefined}
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
        planned anyway. What a shift <strong>made</strong> is read from the shift book too, so
        correcting a mis-keyed entry corrects the board. <strong>Signing a shift off</strong> is
        what hands anything it did not make back to the planner, which is why a shift that fell
        short stays on the board until somebody does.
      </p>

      {working && (
        <ShiftPlanModal onClose={() => setWorking(false)} onApplied={() => setWorking(false)} />
      )}

      {recording !== null && runs.some((r) => r.id === recording) && (
        <RunActualDialog
          /* Read from the board's own query rather than re-fetched, so the
             figures in the dialog and the figures in the cell behind it are
             one answer — and the dialog follows a booking without a refetch
             of its own, the list being invalidated by the press. */
          run={runs.find((r) => r.id === recording)!}
          mayLog={mayLog}
          onClose={() => setRecording(null)}
        />
      )}

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

/**
 * One run, as a cell reads it: what is being made, how it is going, and the
 * two acts that belong to it.
 *
 * The figures **switch from the plan to the record** the moment anything is
 * booked — before that the question is *can this shift take it*, so the cell
 * reads against capacity; afterwards it is *did it*, so the cell reads against
 * the plan. A cell showing both would be four numbers in an inch.
 */
function RunCell({ run, onOpen, onRecord }: {
  run: ProductionRun;
  onOpen?: () => void;
  onRecord?: () => void;
}) {
  // Over capacity is a fact about the plan rather than a refusal here — the
  // server refuses one on the way in, but a line's rate can be corrected
  // afterwards, and a plan that quietly stopped saying so would be worse.
  const over = run.capacity !== null && run.qty_planned > run.capacity;
  const started = run.made > 0 || run.rejected > 0 || run.downtime_mins > 0;
  const done = run.status === 'done';
  const body = (
    <>
      <div className="font-medium text-slate-900">
        {run.product_name || 'Custom item'}
        {run.color && <span className="ml-1.5 font-normal text-slate-500">{run.color}</span>}
      </div>
      {started ? (
        <div className="tabular-nums text-slate-600">
          {fmtQty(run.made)}
          <span className="text-slate-400"> of {fmtQty(run.qty_planned)}</span>
          {run.shortfall > 0 && (
            <span className={done ? 'ml-1 text-slate-400' : 'ml-1 font-semibold text-amber-700'}
              title={done
                ? 'Signed off short — the balance went back to the planner'
                : `${fmtQty(run.shortfall)} not made. Signing this shift off hands it back to the planner.`}
            >−{fmtQty(run.shortfall)}</span>
          )}
        </div>
      ) : (
        <div className={`tabular-nums ${over ? 'text-amber-700' : 'text-slate-600'}`}>
          {fmtQty(run.qty_planned)}
          {run.capacity !== null
            ? <span className="text-slate-400"> of {fmtQty(run.capacity)}</span>
            : <span className="text-slate-300" title="No output rate for this product yet"> · no rate</span>}
        </div>
      )}
      <div className="text-[10px] text-slate-400">
        {run.allocations.length} work order{run.allocations.length === 1 ? '' : 's'}
        {run.allocations.length > 0 && ` · ${run.allocations.map((a) => a.number).join(', ')}`}
      </div>
    </>
  );
  /* `done` is a tick rather than a pill: on a board of fifty cells a pill per
     signed-off shift would be the loudest thing on the page, and what the
     mark has to say is only that this one is closed. */
  const mark = done ? (
    <span className="text-[10px] text-slate-400" title="Signed off">&#10003; signed off</span>
  ) : null;

  /* Recording is a control of its own rather than a second meaning for the
     cell: opening the run plans it, and the two are different acts on
     different permission cells. Quiet until the row is hovered, the rule the
     line-items editor's own remove button records — except once a shift has
     fallen short and not been signed off, which is the one state somebody is
     looking for. */
  const actions = (onRecord || mark) && (
    <div className="mt-0.5 flex items-center gap-2">
      {onRecord && (
        <button
          type="button"
          className={`rounded px-1 text-[10px] hover:bg-brand-50 hover:text-brand-600 ${
            !done && run.shortfall > 0 && started ? 'text-brand-600' : 'text-slate-400'
          }`}
          onClick={onRecord}
          title={done ? 'What this shift made' : 'Record what this shift made'}
        >{started ? 'what ran' : 'record'}</button>
      )}
      {mark}
    </div>
  );

  return onOpen ? (
    <div className="px-0.5">
      <button
        type="button"
        className="w-full rounded px-1 py-1 text-left hover:bg-brand-50"
        onClick={onOpen}
        title="Open this run"
      >{body}</button>
      {actions}
    </div>
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
      {actions}
    </div>
  );
}
