
-- Tu agendando: initial calendar schema
-- User-owned rows are protected by RLS. Google refresh tokens remain server-only.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  time_zone text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_display_name_length CHECK (display_name IS NULL OR char_length(display_name) <= 120),
  CONSTRAINT profiles_time_zone_length CHECK (char_length(time_zone) BETWEEN 1 AND 80)
);

CREATE TABLE public.calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pf', 'pj')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  color text NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendars_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT calendars_id_user_kind_unique UNIQUE (id, user_id, kind)
);

CREATE UNIQUE INDEX calendars_one_default_per_kind_uidx
  ON public.calendars (user_id, kind)
  WHERE is_default;

CREATE TABLE public.google_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_email text,
  scopes text[] NOT NULL DEFAULT '{}',
  is_connected boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_connections_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT google_connections_email_length CHECK (account_email IS NULL OR char_length(account_email) <= 320)
);

CREATE UNIQUE INDEX google_connections_user_email_uidx
  ON public.google_connections (user_id, lower(account_email))
  WHERE account_email IS NOT NULL;

CREATE TABLE public.google_calendar_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_calendar_id text NOT NULL,
  external_calendar_name text,
  sync_direction text NOT NULL DEFAULT 'bidirectional'
    CHECK (sync_direction IN ('from_google', 'to_google', 'bidirectional')),
  sync_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_calendar_links_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT google_calendar_links_calendar_user_fk
    FOREIGN KEY (calendar_id, user_id)
    REFERENCES public.calendars (id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT google_calendar_links_connection_user_fk
    FOREIGN KEY (connection_id, user_id)
    REFERENCES public.google_connections (id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT google_calendar_links_external_id_length
    CHECK (char_length(external_calendar_id) BETWEEN 1 AND 512),
  CONSTRAINT google_calendar_links_external_name_length
    CHECK (external_calendar_name IS NULL OR char_length(external_calendar_name) <= 200),
  CONSTRAINT google_calendar_links_user_external_unique
    UNIQUE (user_id, connection_id, external_calendar_id),
  CONSTRAINT google_calendar_links_one_external_per_calendar
    UNIQUE (calendar_id, user_id)
);

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('pf', 'pj')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  time_zone text NOT NULL DEFAULT 'America/Sao_Paulo',
  location text,
  notes text,
  source text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'google')),
  sync_status text NOT NULL DEFAULT 'local_only'
    CHECK (sync_status IN ('local_only', 'pending', 'synced', 'error')),
  google_link_id uuid,
  google_event_id text,
  google_etag text,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_valid_range CHECK (end_at > start_at),
  CONSTRAINT events_location_length CHECK (location IS NULL OR char_length(location) <= 300),
  CONSTRAINT events_notes_length CHECK (notes IS NULL OR char_length(notes) <= 10000),
  CONSTRAINT events_google_event_id_length CHECK (google_event_id IS NULL OR char_length(google_event_id) <= 1024),
  CONSTRAINT events_google_etag_length CHECK (google_etag IS NULL OR char_length(google_etag) <= 1024),
  CONSTRAINT events_source_google_link CHECK (source <> 'google' OR google_link_id IS NOT NULL),
  CONSTRAINT events_google_metadata_consistent CHECK (
    (google_link_id IS NULL AND google_event_id IS NULL AND google_etag IS NULL)
    OR (google_link_id IS NOT NULL AND google_event_id IS NOT NULL)
  ),
  CONSTRAINT events_calendar_owner_category_fk
    FOREIGN KEY (calendar_id, user_id, category)
    REFERENCES public.calendars (id, user_id, kind)
    ON DELETE CASCADE,
  CONSTRAINT events_google_link_owner_fk
    FOREIGN KEY (google_link_id, user_id)
    REFERENCES public.google_calendar_links (id, user_id)
    ON DELETE SET NULL (google_link_id)
);

CREATE INDEX events_user_calendar_start_idx
  ON public.events (user_id, calendar_id, start_at);

CREATE INDEX events_user_end_idx
  ON public.events (user_id, end_at);

CREATE UNIQUE INDEX events_google_event_uidx
  ON public.events (google_link_id, google_event_id)
  WHERE google_link_id IS NOT NULL AND google_event_id IS NOT NULL;

CREATE INDEX google_calendar_links_enabled_idx
  ON public.google_calendar_links (user_id, calendar_id)
  WHERE sync_enabled;

CREATE TABLE private.google_oauth_tokens (
  connection_id uuid PRIMARY KEY
    REFERENCES public.google_connections(id) ON DELETE CASCADE,
  refresh_token text NOT NULL CHECK (char_length(btrim(refresh_token)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

CREATE TRIGGER calendars_set_updated_at
  BEFORE UPDATE ON public.calendars
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

CREATE TRIGGER google_connections_set_updated_at
  BEFORE UPDATE ON public.google_connections
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

CREATE TRIGGER google_calendar_links_set_updated_at
  BEFORE UPDATE ON public.google_calendar_links
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

CREATE TRIGGER google_oauth_tokens_set_updated_at
  BEFORE UPDATE ON private.google_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_calendar_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.google_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_owner_all ON public.profiles
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY calendars_owner_all ON public.calendars
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY google_connections_owner_all ON public.google_connections
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY google_calendar_links_owner_all ON public.google_calendar_links
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY events_owner_all ON public.events
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

REVOKE ALL ON TABLE public.profiles, public.calendars, public.google_connections,
  public.google_calendar_links, public.events FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendars,
  public.google_connections, public.google_calendar_links, public.events TO authenticated;

GRANT ALL ON TABLE public.profiles, public.calendars, public.google_connections,
  public.google_calendar_links, public.events, private.google_oauth_tokens TO service_role;
