-- TripPlanner: one photo per place (10 Nov 2026). Safe to run twice.
-- places.photo_url: public URL of the place's photo in the trip-photos bucket.
--   null   = no photo yet (the app will try to find one on Google)
--   'none' = Google had no photo, so don't pay to look again
alter table public.places add column if not exists photo_url text;

-- Public bucket for the photos. Uploads go through /projects/tripplanner/api/photo with the
-- service key, so no storage policies are needed.
insert into storage.buckets (id, name, public)
values ('trip-photos', 'trip-photos', true)
on conflict (id) do nothing;
