-- TripPlanner database. Paste the whole file into the Supabase SQL Editor and press Run.
-- Safe to run more than once. If Supabase warns about Row Level Security, choose "Run without RLS":
-- every table below turns it on itself.
--
-- Security model: Row Level Security is on for every table with NO policies, and the public
-- (anon / authenticated) roles get no access. Only the app's server, using the service role key,
-- can read or write. The browser never talks to Supabase directly.

begin;

-- Every saved place belongs to one board. The app uses a single "Wishlist" board with a fixed id
-- (lib/trip/constants.ts, WISHLIST_BOARD_ID).
create table if not exists public.boards (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now() not null,
  name text,
  constraint boards_pkey primary key (id)
);
insert into public.boards (id, name)
values ('209c81f5-c90f-4a0e-af67-0b6a82c27a75', 'Wishlist')
on conflict (id) do nothing;

create table if not exists public.places (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  name text not null,
  address text,
  city text,
  country text,
  category text,
  emoji text,
  lat double precision,
  lng double precision,
  vibe text,
  source_url text,
  tiktok_url text,
  tags text[] default '{}'::text[],
  been_here boolean default false,
  rating integer,
  personal_note text,
  source_handle text,
  board_id uuid not null,
  google_place_id text,
  description text,
  must_go boolean default false not null,
  neighbourhood text,
  research jsonb,
  ai_duration_minutes integer,
  ai_duration_note text,
  photo_url text,
  constraint places_pkey primary key (id),
  constraint places_board_id_fkey foreign key (board_id) references public.boards(id),
  constraint places_rating_check check (rating >= 1 and rating <= 5)
);
create index if not exists places_board_id_idx on public.places using btree (board_id);

create table if not exists public.trips (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now(),
  board_id uuid,
  name text not null,
  start_date date,
  end_date date,
  is_demo boolean default false not null,
  constraint trips_pkey primary key (id),
  constraint trips_board_id_fkey foreign key (board_id) references public.boards(id) on delete cascade
);

-- A leg is one city (and hotel) within a trip.
create table if not exists public.trip_legs (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now(),
  trip_id uuid,
  city text not null,
  start_date date,
  end_date date,
  leg_order integer default 0,
  hotel text,
  country text not null,
  hotel_lat double precision,
  hotel_lng double precision,
  hotel_place_id text,
  constraint trip_legs_pkey primary key (id),
  constraint trip_legs_trip_id_fkey foreign key (trip_id) references public.trips(id) on delete cascade
);

create table if not exists public.trip_days (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now(),
  trip_id uuid,
  date date not null,
  day_number integer not null,
  leg_id uuid,
  day_date date,
  start_time time,
  start_kind text default 'hotel'::text,
  travel_options jsonb,
  bags_minutes integer,
  plan_name text,
  plan_active boolean,
  constraint trip_days_pkey primary key (id),
  constraint trip_days_leg_id_fkey foreign key (leg_id) references public.trip_legs(id) on delete set null,
  constraint trip_days_trip_id_fkey foreign key (trip_id) references public.trips(id) on delete cascade
);

create table if not exists public.trip_stops (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now(),
  day_id uuid,
  place_id uuid,
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  duration_minutes integer default 60,
  start_time time,
  stop_order integer not null,
  assigned_to text default 'both'::text,
  transport_to_next text,
  travel_minutes_to_next integer,
  arrive_by time,
  fixed_time time,
  duration_source text default 'default'::text,
  travel_options jsonb,
  note text,
  kind text,
  constraint trip_stops_pkey primary key (id),
  constraint trip_stops_day_id_fkey foreign key (day_id) references public.trip_days(id) on delete cascade,
  constraint trip_stops_place_id_fkey foreign key (place_id) references public.places(id) on delete set null
);

create table if not exists public.trip_flights (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now(),
  trip_id uuid,
  flight_number text not null,
  departure_airport text,
  arrival_airport text,
  departure_time timestamptz,
  arrival_time timestamptz,
  buffer_before_minutes integer default 180,
  buffer_after_minutes integer default 90,
  constraint trip_flights_pkey primary key (id),
  constraint trip_flights_trip_id_fkey foreign key (trip_id) references public.trips(id) on delete cascade
);

-- Which saved places a trip shows (by default a trip shows the places in its cities).
create table if not exists public.trip_included_places (
  trip_id uuid not null,
  place_id uuid not null,
  created_at timestamptz default now() not null,
  constraint trip_included_places_pkey primary key (trip_id, place_id),
  constraint trip_included_places_place_id_fkey foreign key (place_id) references public.places(id) on delete cascade,
  constraint trip_included_places_trip_id_fkey foreign key (trip_id) references public.trips(id) on delete cascade
);

create table if not exists public.trip_excluded_places (
  trip_id uuid not null,
  place_id uuid not null,
  created_at timestamptz default now() not null,
  constraint trip_excluded_places_pkey primary key (trip_id, place_id),
  constraint trip_excluded_places_place_id_fkey foreign key (place_id) references public.places(id) on delete cascade,
  constraint trip_excluded_places_trip_id_fkey foreign key (trip_id) references public.trips(id) on delete cascade
);

-- Share links: the token is stored hashed (to check a link) and encrypted (to show it again).
create table if not exists public.trip_shares (
  id uuid default gen_random_uuid() not null,
  trip_id uuid not null,
  role text not null,
  token_hash text not null,
  token_enc text not null,
  created_at timestamptz default now() not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  budget_usd numeric(10,4),
  constraint trip_shares_pkey primary key (id),
  constraint trip_shares_token_hash_key unique (token_hash),
  constraint trip_shares_trip_id_fkey foreign key (trip_id) references public.trips(id) on delete cascade,
  constraint trip_shares_role_check check (role = any (array['view'::text, 'edit'::text]))
);
create index if not exists trip_shares_trip_idx on public.trip_shares using btree (trip_id);

-- What each edit link has spent on AI features per day, so a shared link can't run up a bill.
create table if not exists public.trip_share_usage (
  share_id uuid not null,
  day date not null,
  calls integer default 0 not null,
  est_usd numeric(12,5) default 0 not null,
  features jsonb default '{}'::jsonb not null,
  constraint trip_share_usage_pkey primary key (share_id, day),
  constraint trip_share_usage_share_id_fkey foreign key (share_id) references public.trip_shares(id) on delete cascade
);

-- Lock everything down: RLS on, no policies, no access for the public roles.
do $$
declare t text;
begin
  foreach t in array array[
    'boards', 'places', 'trips', 'trip_legs', 'trip_days', 'trip_stops', 'trip_flights',
    'trip_included_places', 'trip_excluded_places', 'trip_shares', 'trip_share_usage'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Counts one AI call against a share link, checking its daily cap and its total budget.
-- Returns 'ok', 'daily' or 'budget'. Days are counted in Singapore time; change it to yours.
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

-- Public bucket for place photos.
insert into storage.buckets (id, name, public)
values ('trip-photos', 'trip-photos', true)
on conflict (id) do nothing;

commit;

-- Check: should list 11 tables.
select table_name from information_schema.tables
where table_schema = 'public' and table_name in (
  'boards', 'places', 'trips', 'trip_legs', 'trip_days', 'trip_stops', 'trip_flights',
  'trip_included_places', 'trip_excluded_places', 'trip_shares', 'trip_share_usage')
order by table_name;
