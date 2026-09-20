-- Waterbodies table (lake/river metadata)
CREATE TABLE public.waterbodies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) > 0),
  type text NOT NULL CHECK (type IN ('lake', 'river', 'pond', 'reservoir')),
  state text NOT NULL DEFAULT 'OK',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Spots table: micro-locations within a waterbody
CREATE TABLE public.spots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waterbody_id uuid NOT NULL REFERENCES public.waterbodies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) > 0),
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  structure_type text CHECK (structure_type IN ('point', 'bank', 'channel', 'brush', 'dock', 'hump', 'other')),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Catch logs: individual catches tied to users and waterbodies
CREATE TABLE public.catch_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  waterbody_id uuid NOT NULL REFERENCES public.waterbodies(id) ON DELETE CASCADE,
  spot_id uuid REFERENCES public.spots(id) ON DELETE SET NULL,
  species text NOT NULL,
  length_in text,
  weight_lb numeric,
  bait text,
  depth_ft numeric,
  structure_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  conditions jsonb, -- snapshot of weather/pressure, etc.
  updated_at timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.spots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catch_logs ENABLE ROW LEVEL SECURITY;

-- Owner-based RLS policies for spots (users only see/manage their own spots)
CREATE POLICY "Users can view own spots"
ON public.spots
FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can create spots"
ON public.spots
FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own spots"
ON public.spots
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own spots"
ON public.spots
FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

-- Owner-based RLS policies for catch logs
CREATE POLICY "Users can view own catches"
ON public.catch_logs
FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can create catches"
ON public.catch_logs
FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own catches"
ON public.catch_logs
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own catches"
ON public.catch_logs
FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

-- Indexes for performance
CREATE INDEX idx_spots_user_id ON public.spots (user_id);
CREATE INDEX idx_spots_waterbody_id ON public.spots (waterbody_id);
CREATE INDEX idx_catch_logs_user_id ON public.catch_logs (user_id);
CREATE INDEX idx_catch_logs_waterbody_id ON public.catch_logs (waterbody_id);

-- Trigger to auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_spots_updated_at
BEFORE UPDATE ON public.spots
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER set_catch_logs_updated_at
BEFORE UPDATE ON public.catch_logs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
