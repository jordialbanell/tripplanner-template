-- TripPlanner day planner (15 Oct 2026): notes per stop, hotel rest stops,
-- one-off stops that aren't saved places, and an editable bag-drop time.
-- Safe to run more than once. Adds columns only, changes no existing data.

alter table trip_stops add column if not exists note text;
-- null = a saved place, 'hotel' = back to the hotel to rest, 'custom' = one-off stop not in your places
alter table trip_stops add column if not exists kind text;
-- minutes at the hotel dropping bags on an arrival day (null = 30)
alter table trip_days add column if not exists bags_minutes integer;
