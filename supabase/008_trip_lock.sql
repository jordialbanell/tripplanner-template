-- Lock the TripPlanner tables (13 Oct 2026). Run this LAST, only after testing the site.
-- After this, the browser's public key can't read or change any trip or place, so:
--   - jordialbanell.com/projects/tripplanner keeps working (it goes through the server)
--   - the OLD tripplanner-black.vercel.app stops working. That's expected: it's being retired.
-- Undo (emergency only): re-create a "Public access" policy on each table.

do $$
declare t text;
begin
  foreach t in array array[
    'places', 'boards', 'trips', 'trip_legs', 'trip_days', 'trip_stops',
    'trip_flights', 'trip_included_places', 'trip_excluded_places'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "Public access" on public.%I', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- Check: this should list no policies for the tables above. If any show up, send Claude the result.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('places', 'boards', 'trips', 'trip_legs', 'trip_days', 'trip_stops',
                    'trip_flights', 'trip_included_places', 'trip_excluded_places');
