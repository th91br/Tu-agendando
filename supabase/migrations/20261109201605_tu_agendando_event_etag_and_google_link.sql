
ALTER TABLE public.events
  ADD COLUMN etag uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.google_calendar_links
  ALTER COLUMN calendar_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  IF TG_TABLE_NAME = 'events' THEN
    NEW.etag := pg_catalog.gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC, anon, authenticated;
