import type { Batch, QcCheck } from '../types';

/**
 * The inspection a lot's certificate prints: its **latest final check that
 * reached a verdict**.
 *
 * Latest rather than whichever was recorded last, and decided rather than
 * merely recorded — a lot is re-tested after rework and an undecided check
 * decides nothing, so this is the one `buildCoaPdf` reads (`perLot` in
 * `services/pdf.ts`) and therefore the one a correction has to land on.
 *
 * It lives here because two screens ask it — the job's Batches tab, to point
 * *Correct* at the right inspection, and the certificate page, to resolve a
 * check from the lot a link names. A second copy is how the two would come to
 * correct different readings from the one the document carries.
 */
export function printedCheck(batch: Batch | undefined): QcCheck | undefined {
  const decided = (batch?.final_checks ?? []).filter((c) => c.passed !== null);
  return decided[decided.length - 1];
}
