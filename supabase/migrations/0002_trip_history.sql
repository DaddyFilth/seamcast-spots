-- Trip logs: every outing (caught fish or not) with the real conditions at the time.
-- Blank outings are stored so success rates are not biased toward successful trips.
CREATE TABLE public.trip_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  waterbody_id uuid REFERENCES public.waterbodies(id) ON DELETE SET NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  started_at timestamptz NOT NULL,
  duration_hours numeric NOT NULL CHECK (duration_hours > 0 AND duration_hours <= 48),
  caught boolean NOT NULL,
  fish_count integer CHECK (fish_count IS NULL OR fish_count >= 0),
  species text,
  bait text,
  depth_ft numeric CHECK (depth_ft IS NULL OR depth_ft >= 0),
  -- full snapshot (NWS/Open-Meteo/USGS/NOAA/moon) captured when the trip was logged
  conditions jsonb,
  -- normalized, queryable form of the key conditions
  pressure_trend_hpa numeric,
  air_temp_f numeric,
  water_temp_f numeric,
  wind_mph numeric,
  cloud_cover_pct numeric,
  moon_illumination_pct numeric,
  season text CHECK (season IN ('winter', 'spring', 'summer', 'fall')),
  time_of_day text CHECK (time_of_day IN ('dawn', 'day', 'dusk', 'night')),
  -- user consent to include this outing, anonymized, when matching conditions for other anglers
  share_for_matching boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trip_logs_user_idx ON public.trip_logs (user_id, started_at DESC);
CREATE INDEX trip_logs_share_geo_idx ON public.trip_logs (lat, lon) WHERE share_for_matching;
CREATE INDEX trip_logs_season_idx ON public.trip_logs (season, time_of_day);

ALTER TABLE public.trip_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own trips" ON public.trip_logs
FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can create trips" ON public.trip_logs
FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own trips" ON public.trip_logs
FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own trips" ON public.trip_logs
FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- Anonymized outings for condition matching. Only consenting rows are returned, with no
-- user id, exact coordinates, timestamps or free-form data: just distance and conditions.
-- The radius is floored at 10 km so small-radius queries cannot pinpoint an individual's spot.
CREATE OR REPLACE FUNCTION public.match_outings(
  p_lat double precision,
  p_lon double precision,
  p_radius_km double precision DEFAULT 200,
  p_limit integer DEFAULT 1000
)
RETURNS TABLE (
  distance_km double precision,
  caught boolean,
  species text,
  bait text,
  depth_ft numeric,
  pressure_trend_hpa numeric,
  air_temp_f numeric,
  water_temp_f numeric,
  wind_mph numeric,
  cloud_cover_pct numeric,
  moon_illumination_pct numeric,
  season text,
  time_of_day text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.distance_km, d.caught, d.species, d.bait, d.depth_ft, d.pressure_trend_hpa,
         d.air_temp_f, d.water_temp_f, d.wind_mph, d.cloud_cover_pct,
         d.moon_illumination_pct, d.season, d.time_of_day
  FROM (
    SELECT t.*,
      6371 * 2 * asin(sqrt(least(1,
        power(sin(radians(t.lat - p_lat) / 2), 2) +
        cos(radians(p_lat)) * cos(radians(t.lat)) * power(sin(radians(t.lon - p_lon) / 2), 2)
      ))) AS distance_km
    FROM public.trip_logs t
    WHERE t.share_for_matching
      AND t.lat BETWEEN p_lat - (least(greatest(p_radius_km, 10), 500) / 111.0) AND p_lat + (least(greatest(p_radius_km, 10), 500) / 111.0)
  ) d
  WHERE d.distance_km <= least(greatest(p_radius_km, 10), 500)
  ORDER BY d.distance_km
  LIMIT least(p_limit, 1000);
$$;

REVOKE ALL ON FUNCTION public.match_outings(double precision, double precision, double precision, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_outings(double precision, double precision, double precision, integer) TO anon, authenticated;
