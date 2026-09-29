import type { WorkOrder } from '../types';

/**
 * Which column a date typed against a job writes to.
 *
 * The original plan is recorded once and then fixed — `plannedDateError` on
 * the server owns that rule and refuses to move one — so a box writes
 * `planned_X` only while that column is still blank, and `revised_X` after.
 * The screen therefore never produces a refusal: it routes to the column the
 * rule allows rather than keeping a copy of the rule and disabling itself.
 *
 * **Per field, not per job**, for the reason the guard states: a job given a
 * start and no finish has not recorded its original finish yet, and reading
 * the pair as one would leave that column blank for good.
 */
export type JobDateField = 'planned_start' | 'planned_end' | 'revised_start' | 'revised_end';

export const jobDateField = (w: WorkOrder, end: boolean): JobDateField =>
  `${(end ? w.planned_end : w.planned_start) ? 'revised' : 'planned'}_${end ? 'end' : 'start'}` as JobDateField;

/**
 * What one column holds, which is what a cell under that heading must show.
 *
 * Deliberately **not** the date that stands. Both pairs are drawn now, so a
 * Revised cell showing the planned date where there is no revision would state
 * that the job had been revised to the day it was already on — the one thing
 * two columns beside each other must not say.
 */
export const jobDateOf = (w: WorkOrder, field: JobDateField): string => w[field] ?? '';

/** The column under a heading, for a cell that knows which heading it is under. */
export const jobDateColumn = (revised: boolean, end: boolean): JobDateField =>
  `${revised ? 'revised' : 'planned'}_${end ? 'end' : 'start'}` as JobDateField;

/** True once this column is the record rather than the box being filled in. */
export const jobDateIsRevision = (w: WorkOrder, end: boolean) => jobDateField(w, end).startsWith('revised');
