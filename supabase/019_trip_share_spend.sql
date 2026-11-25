-- TripPlanner: estimated spend per share link + optional spending limit (3 Nov 2026). Safe to run twice.
-- Needs 007_trip_sharing.sql first. Until this runs, the site keeps working with the old 60-a-day cap.
--
-- trip_shares.budget_usd: optional limit on estimated spend for the whole life of an edit link.
-- trip_share_usage.est_usd: estimated cost of that day's paid calls (list prices, free tiers ignored).
-- trip_share_usage.features: calls per feature that day, e.g. {"research": 3, "routes": 12}.

alter table public.trip_shares add column if not exists budget_usd numeric(10, 4);
alter table public.trip_share_usage add column if not exists est_usd numeric(12, 5) not null default 0;
alter table public.trip_share_usage add column if not exists features jsonb not null default '{}'::jsonb;

-- Charges one paid call. Returns 'ok', 'daily' (today's call cap reached) or 'budget'
-- (this call would take the link over its spending limit). Refused calls are not recorded.
create or replace function public.trip_share_charge_v2(sid uuid, cap integer, feature text, usd numeric)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Singapore')::date;
  budget numeric;
  spent numeric;
  calls_today integer;
begin
  select budget_usd into budget from public.trip_shares where id = sid for update;
  select coalesce(calls, 0) into calls_today from public.trip_share_usage where share_id = sid and day = today;
  if coalesce(calls_today, 0) >= cap then return 'daily'; end if;
  if budget is not null then
    select coalesce(sum(est_usd), 0) into spent from public.trip_share_usage where share_id = sid;
    if spent + usd > budget then return 'budget'; end if;
  end if;
  insert into public.trip_share_usage (share_id, day, calls, est_usd, features)
  values (sid, today, 1, usd, jsonb_build_object(feature, 1))
  on conflict (share_id, day) do update set
    calls = public.trip_share_usage.calls + 1,
    est_usd = public.trip_share_usage.est_usd + excluded.est_usd,
    features = public.trip_share_usage.features || jsonb_build_object(
      feature, coalesce((public.trip_share_usage.features ->> feature)::integer, 0) + 1);
  return 'ok';
end;
$$;
revoke execute on function public.trip_share_charge_v2(uuid, integer, text, numeric) from public, anon, authenticated;
