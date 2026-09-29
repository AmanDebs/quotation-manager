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

/** The date on screen: the one that stands — revised where set, else planned. */
export const jobDateValue = (w: WorkOrder, end: boolean): string =>
  (end ? w.revised_end || w.planned_end : w.revised_start || w.planned_start) ?? '';

/** True once this column is the record rather than the box being filled in. */
export const jobDateIsRevision = (w: WorkOrder, end: boolean) => jobDateField(w, end).startsWith('revised');
