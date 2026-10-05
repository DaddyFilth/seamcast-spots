-- Trips can also be logged by Fishfinder Pro users, whose accounts live in a different Supabase
-- project. Their (verified) user id is stored as text; rows are written server-side only.
ALTER TABLE public.trip_logs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.trip_logs ADD COLUMN external_source text CHECK (external_source IN ('fishfinder-pro'));
ALTER TABLE public.trip_logs ADD COLUMN external_user_id text CHECK (char_length(external_user_id) <= 64);

ALTER TABLE public.trip_logs ADD CONSTRAINT trip_logs_one_owner CHECK (
  (user_id IS NOT NULL AND external_user_id IS NULL AND external_source IS NULL)
  OR (user_id IS NULL AND external_user_id IS NOT NULL AND external_source IS NOT NULL)
);

CREATE INDEX trip_logs_external_idx ON public.trip_logs (external_source, external_user_id, started_at DESC)
  WHERE external_user_id IS NOT NULL;
