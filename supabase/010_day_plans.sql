-- TripPlanner (15 Oct 2026): several plans per day (e.g. a rainy-day plan).
-- Safe to run more than once. Adds columns only, changes no existing data.

-- null = the day's Main plan; a name = an alternative plan for the same date
alter table trip_days add column if not exists plan_name text;
-- which plan is in use for that date (none set = Main)
alter table trip_days add column if not exists plan_active boolean;
