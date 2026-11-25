import { Suspense, type ReactNode } from "react";

// The trip pages read the trip id from the URL on the client, so they stream in after the shell.
export default function TripLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-full items-center justify-center bg-gray-50">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
        </main>
      }
    >
      {children}
    </Suspense>
  );
}
