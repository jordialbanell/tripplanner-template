-- TripPlanner share links + demo trip (13 Oct 2026). Safe to run twice.
-- Run this FIRST. It changes nothing for the old tripplanner-black site.
--
-- trip_shares: one row per link. Only a SHA-256 of the link's code is used to look it up;
-- the code is also kept encrypted (with the site's secret) so Jordi can copy a link again.
-- revoked_at set = switched off for good. A new link always gets a new code.
-- trip_share_usage: paid AI/Google calls per edit link per day (Singapore date), capped by the site.

create table if not exists public.trip_shares (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  role text not null check (role in ('view', 'edit')),
  token_hash text not null unique,
  token_enc text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists trip_shares_trip_idx on public.trip_shares (trip_id);

create table if not exists public.trip_share_usage (
  share_id uuid not null references public.trip_shares(id) on delete cascade,
  day date not null,
  calls integer not null default 0,
  primary key (share_id, day)
);

alter table public.trip_shares enable row level security;
alter table public.trip_share_usage enable row level security;
revoke all on public.trip_shares from anon, authenticated;
revoke all on public.trip_share_usage from anon, authenticated;

-- Counts one paid call for a link and says whether it's still within today's cap.
create or replace function public.trip_share_charge(sid uuid, cap integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into public.trip_share_usage (share_id, day, calls)
  values (sid, (now() at time zone 'Asia/Singapore')::date, 1)
  on conflict (share_id, day) do update set calls = public.trip_share_usage.calls + 1
  returning calls into n;
  return n <= cap;
end;
$$;
revoke execute on function public.trip_share_charge(uuid, integer) from public, anon, authenticated;

-- The demo trip visitors see.
alter table public.trips add column if not exists is_demo boolean not null default false;
