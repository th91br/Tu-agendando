
CREATE INDEX calendars_user_id_idx
  ON public.calendars (user_id);

CREATE INDEX google_connections_user_id_idx
  ON public.google_connections (user_id);

CREATE INDEX google_calendar_links_connection_user_idx
  ON public.google_calendar_links (connection_id, user_id);

CREATE INDEX events_calendar_owner_category_idx
  ON public.events (calendar_id, user_id, category);

CREATE INDEX events_google_link_owner_idx
  ON public.events (google_link_id, user_id)
  WHERE google_link_id IS NOT NULL;

CREATE POLICY google_oauth_tokens_service_role_only
  ON private.google_oauth_tokens
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
