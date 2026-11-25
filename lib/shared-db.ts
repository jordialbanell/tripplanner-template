// Server-only client for the shared Supabase database that apps on /projects move into.
// For now that's the database TripPlanner already uses; each app keeps its tables
// prefixed (scanner_*, ...). RLS is on with no policies, so only this service key can read or write.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function sharedDb(): SupabaseClient {
  if (client) return client;
  const url = process.env.SHARED_SUPABASE_URL;
  const key = process.env.SHARED_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Shared database not configured");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
