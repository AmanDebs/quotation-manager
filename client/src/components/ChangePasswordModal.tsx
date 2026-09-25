import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button, Input, Field, Modal, ErrorText } from './ui';

/**
 * Changing your own password.
 *
 * `POST /api/auth/change-password` has existed and been correct since the
 * sessions work landed, and **nothing on the client ever called it** — so the
 * Team dialog's own footnote, *"they can change it later from their own
 * account"*, was not true of the app. It became worth fixing the moment the
 * Team page started handing out generated passwords, which are meant to be
 * changed by the person who receives one.
 *
 * It asks for the current password, which is what makes this different from the
 * Team page's reset: proving you hold the account is what earns the **fresh
 * cookie** the server hands back, so the browser doing the changing stays
 * signed in while every other session on the account drops out. A reset cannot
 * do that, which is exactly why it is refused on your own row.
 */
export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');

  const change = useMutation({
    mutationFn: () => api.post('/api/auth/change-password', { current_password: current, new_password: next }),
  });

  // Checked here as well as on the server because the server cannot check it:
  // it is handed one new password, and whether the person typed what they meant
  // is a question only this form has both answers to.
  const mismatch = again.length > 0 && next !== again;
  const ready = current.length > 0 && next.length >= 6 && next === again;

  if (change.isSuccess) {
    return (
      <Modal title="Password changed" onClose={onClose}>
        <div className="space-y-3 text-sm">
          <p className="rounded-lg bg-green-50 px-3 py-2 text-green-800 ring-1 ring-inset ring-green-200">
            Your password has been changed. You are still signed in here; any other browser or
            device signed in as you has been signed out.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Change your password" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Current Password *">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New Password *">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 6 characters" />
        </Field>
        <Field label="Repeat New Password *">
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {mismatch && <p className="text-xs text-red-600">The two new passwords do not match.</p>}
        <p className="text-xs text-slate-400">
          Every other session signed in as you will be signed out. This tab stays signed in.
        </p>
        <ErrorText error={change.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => change.mutate()} disabled={change.isPending || !ready}>
            Change Password
          </Button>
        </div>
      </div>
    </Modal>
  );
}
