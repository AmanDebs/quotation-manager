import { useState } from 'react';
import type { Batch } from '../types';
import { Button, Field, Modal, Textarea, ErrorText } from './ui';
import { fmtQty } from '../lib/format';

/**
 * What to do with a lot that failed its final check.
 *
 * The specification's *"initiating rework or scrap procedures"*, which is the
 * one part of the loop somebody has to type. A `confirm()` would have done for
 * the yes-or-no, as it does for the other seventeen in this app — but this one
 * asks a second thing, and the second thing is the point: **why**. A scrap
 * decision's reason is the only part of it nobody can reconstruct afterwards,
 * the batch's own figures and checks being on the record already.
 *
 * The two outcomes are deliberately not the same weight. Rework is reversible
 * by definition — the lot goes back and is inspected again — while scrap
 * condemns real goods and moves real figures, so it says exactly which figures
 * before it is pressed.
 */
export default function BatchDispositionModal({ batch, disposition, saving, error, onClose, onSave }: {
  batch: Batch;
  disposition: 'rework' | 'scrapped';
  saving: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const scrapping = disposition === 'scrapped';

  return (
    <Modal title={scrapping ? `Scrap batch ${batch.number}` : `Send batch ${batch.number} for rework`} onClose={onClose}>
      <p className="text-sm text-slate-600">
        {scrapping ? (
          <>
            Its <span className="font-medium tabular-nums">{fmtQty(batch.made)}</span> pieces stop counting
            as made — on this job, on the order line, and in the material shortfall — and it can never be
            certified or dispatched while the decision stands.
          </>
        ) : (
          <>
            The lot goes back to the floor. Nothing about its figures changes; it is cleared the ordinary
            way, by recording a final check against it that passes.
          </>
        )}
      </p>
      <Field label="Why" className="mt-3">
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={scrapping ? 'e.g. Neck diameter out on the whole run — regrind' : 'e.g. Re-trim and re-inspect'}
        />
      </Field>
      <p className="mt-2 text-xs text-slate-400">
        Recorded against the batch with your name and today's date. It can be withdrawn if it was a mistake.
      </p>
      <ErrorText error={error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={scrapping ? 'danger' : 'primary'} onClick={() => onSave(note)} disabled={saving}>
          {saving ? 'Recording…' : scrapping ? 'Scrap the batch' : 'Send for rework'}
        </Button>
      </div>
    </Modal>
  );
}
