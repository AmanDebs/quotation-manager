import { db } from '../db/connection.js';

/**
 * The shifts the plant runs, and the days it does not (2026-11-24).
 *
 * `production_entries.shift` has been **free text with no vocabulary** since
 * the table was written — nothing offered a list, nothing validated one, and
 * nothing anywhere held an hour, a capacity or a changeover. That was fine
 * while a shift was a label on a record; it is not enough to *plan* into one,
 * which is what the product-wise planning brief asks for.
 *
 * **Two shifts, A and B, of twelve hours** — the client's own answer when
 * asked, and what their own certificate already reads (*Batch No:
 * 05032026A+B TO 09032026A+B*, five days of two shifts). The brief named
 * A/B/C; their paper named two, and the paper won.
 */

export interface Shift {
  key: string;
  label: string;
  /** Hours on the clock. What a shift's capacity is worked out over. */
  hours: number;
}

/**
 * Compiled in rather than a master, deliberately. A shift is the **shape of
 * the working day** rather than a thing the desk adds to — there are two of
 * them, they have not changed, and a table would be a screen, a guard and a
 * migration for a list of two rows. `machines.shifts_per_day` is where a line
 * that runs fewer of them says so, which is the fact that does vary.
 *
 * It is **sent to the client rather than copied onto it** (`/auth/me`'s own
 * rule about the permission vocabulary): one list, so a picker can never offer
 * a shift the server does not know.
 */
export const SHIFTS: readonly Shift[] = [
  { key: 'A', label: 'Shift A', hours: 12 },
  { key: 'B', label: 'Shift B', hours: 12 },
] as const;

export const SHIFT_KEYS: readonly string[] = SHIFTS.map((s) => s.key);

/** Hours in a shift this build knows, else the house twelve. */
export const shiftHours = (key: string): number =>
  SHIFTS.find((s) => s.key === normaliseShift(key))?.hours ?? 12;

/**
 * Read a stored shift back.
 *
 * **Free text behind the list**, the rule `unitOptions` and `DeskPersonInput`
 * both follow: every entry already on file was typed by hand, and a value this
 * build does not know is **kept as it stands** rather than cleared or refused
 * — a record is not corrected by a release that stops offering its value.
 * Trimmed and upper-cased so `a`, `A ` and `A` are one shift, which is what
 * makes the per-shift rate measurable over a book typed by several people.
 */
export const normaliseShift = (v: unknown): string => String(v ?? '').trim().toUpperCase();

/** Whether this build offers the value, which is a different question. */
export const isKnownShift = (v: unknown): boolean => SHIFT_KEYS.includes(normaliseShift(v));

/* ------------------------------------------------------------- the calendar */

/**
 * The days the plant does not run.
 *
 * **Empty by default, and that is what makes it safe.** The client's answer on
 * 2026-11-16 was that the plant runs seven days, which is why `layOutQueue`
 * has no calendar and its arithmetic is plain addition; the planning brief
 * then asked for working days and holidays. An empty list means every date the
 * scheduler produces is exactly the date it produced before, so nothing moves
 * until somebody enters a shut-down — and then only forwards.
 *
 * Read as a `Set` and handed to `layOutQueue`, which stays **pure**: the
 * scheduler takes the calendar rather than reading one, the shape `QueueShape`
 * already has for the lanes and the lines' free days.
 */
export function shutdownDates(): Set<string> {
  const rows = db.prepare(
    `SELECT date FROM plant_shutdowns WHERE active = 1 AND date <> ''`
  ).all() as Record<string, unknown>[];
  return new Set(rows.map((r) => String(r.date ?? '')).filter(Boolean));
}

/**
 * One line of the plant, as the planner reads it.
 *
 * `machines` **is** the line list — the client's own answer when asked what a
 * line is, which is also why no column had to be added to a job:
 * `work_orders.machine_id` has referenced `machines(id)` since long before the
 * field was taken off the screen on 2026-09-25.
 */
export interface ProductionLine {
  id: number;
  name: string;
  code: string;
  location_id: number | null;
  location_name: string;
  /** Shifts this line runs in a day. Zero means it is not running at all. */
  shifts_per_day: number;
  /** Minutes lost to a colour change on it. Zero costs nothing, as today. */
  changeover_mins: number;
  /**
   * Shifts a day × hours a shift — what the line is available for. Derived,
   * never stored: a second column would be a figure able to disagree with the
   * two it is the product of.
   */
  hours_per_day: number;
}

/** The lines in use, with the hours each is good for. */
export function productionLines(): ProductionLine[] {
  const rows = db.prepare(
    `SELECT m.id, m.name, m.code, m.location_id, m.shifts_per_day, m.changeover_mins,
            COALESCE(l.name, '') AS location_name
       FROM machines m
       LEFT JOIN locations l ON l.id = m.location_id
      WHERE m.active = 1
      ORDER BY m.name`
  ).all() as Record<string, unknown>[];

  // A shift's hours are the vocabulary's, so a line running two shifts is
  // twenty-four hours whichever two they are. Floored at zero rather than
  // defaulted: a line deliberately set to no shifts is not running, and
  // reading that as the default two would plan work onto it.
  return rows.map((r) => {
    const shifts = Math.max(0, Number(r.shifts_per_day) || 0);
    return {
      id: Number(r.id),
      name: String(r.name ?? ''),
      code: String(r.code ?? ''),
      location_id: r.location_id === null ? null : Number(r.location_id),
      location_name: String(r.location_name ?? ''),
      shifts_per_day: shifts,
      changeover_mins: Math.max(0, Number(r.changeover_mins) || 0),
      hours_per_day: SHIFTS.slice(0, shifts).reduce((sum, s) => sum + s.hours, 0),
    };
  });
}
