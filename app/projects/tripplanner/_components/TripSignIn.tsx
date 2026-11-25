'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { signInAction, signOutAction, type SignInState } from '@/app/projects/_owner/actions';

// "Owner? Sign in" for TripPlanner. Reloads after signing in or out, because the app's
// pages are client-side and ask the server what they may show on load.
export function TripSignIn({ owner }: { owner: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, {});
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current && !pending && !state.error) window.location.reload();
  }, [state, pending]);

  if (owner) {
    return (
      <form action={async () => { await signOutAction(); window.location.reload(); }} className="flex items-center gap-2 text-xs text-gray-400">
        <span>Signed in as owner</span>
        <button type="submit" className="underline hover:text-gray-600">Sign out</button>
      </form>
    );
  }
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="text-xs text-gray-400 hover:text-gray-600">Owner? Sign in</button>;
  }
  return (
    <form action={fd => { submitted.current = true; return action(fd); }} className="flex items-center gap-2">
      <input name="password" type="password" autoFocus required placeholder="Password" aria-label="Password" autoComplete="current-password"
        className="h-8 w-36 rounded-md border border-gray-200 px-2 text-sm outline-none focus:border-sky-400" />
      <button type="submit" disabled={pending} className="h-8 rounded-md border border-gray-200 px-3 text-xs text-gray-600 hover:bg-gray-50">
        {pending ? '…' : 'Sign in'}
      </button>
      {state.error && <span className="text-xs text-red-500">{state.error}</span>}
    </form>
  );
}
