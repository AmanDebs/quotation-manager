import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { User } from '../types';
import { Button, Input, Field, ErrorText } from '../components/ui';

export default function LoginPage({ onLogin, expired = false }: {
  onLogin: (u: User) => void;
  /** True when the app dropped back here mid-use, rather than starting here. */
  expired?: boolean;
}) {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ needsSetup: boolean }>('/api/auth/status').then((s) => setNeedsSetup(s.needsSetup)).catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = needsSetup
        ? await api.post<User>('/api/auth/register', { name, email, password })
        : await api.post<User>('/api/auth/login', { email, password });
      onLogin(user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-800 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow-2xl">
        <div className="text-center">
          <h1 className="text-xl font-bold text-brand-700">ERP Tool</h1>
          <p className="mt-1 text-sm text-slate-500">
            {needsSetup ? 'Welcome! Create the first user account to get started.' : 'Sign in to your account'}
          </p>
        </div>
        {expired && !needsSetup && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Your session ended — either it expired, or the password on this account was changed.
            Sign in again to carry on.
          </p>
        )}
        {needsSetup && (
          <Field label="Your Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Aman Saraogi" />
          </Field>
        )}
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" disabled={busy} className="w-full py-2">
          {busy ? 'Please wait…' : needsSetup ? 'Create Account' : 'Sign In'}
        </Button>
      </form>
    </div>
  );
}
