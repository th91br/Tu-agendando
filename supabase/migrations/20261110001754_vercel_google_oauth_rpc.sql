-- Only the server role may call these RPCs. Tokens remain in the private schema.
-- SECURITY INVOKER keeps the role check and RLS in force.
CREATE UNIQUE INDEX IF NOT EXISTS google_connections_one_per_user_uidx
  ON public.google_connections (user_id);

CREATE FUNCTION public.google_oauth_token_store(
  p_user_id uuid,
  p_refresh_token text,
  p_account_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_connection_id uuid;
  v_email text := NULLIF(pg_catalog.btrim(p_account_email), '');
BEGIN
  IF p_user_id IS NULL OR p_refresh_token IS NULL OR
     pg_catalog.char_length(pg_catalog.btrim(p_refresh_token)) NOT BETWEEN 1 AND 8192 OR
     (v_email IS NOT NULL AND pg_catalog.char_length(v_email) > 320) THEN
    RAISE EXCEPTION 'Invalid Google connection';
  END IF;

  INSERT INTO public.google_connections
    (user_id, account_email, scopes, is_connected, connected_at)
  VALUES
    (p_user_id, v_email, ARRAY['https://www.googleapis.com/auth/calendar.events.owned'], true, pg_catalog.now())
  ON CONFLICT (user_id) DO UPDATE
    SET account_email = EXCLUDED.account_email,
        scopes = EXCLUDED.scopes,
        is_connected = true,
        connected_at = EXCLUDED.connected_at
  RETURNING id INTO v_connection_id;

  INSERT INTO private.google_oauth_tokens (connection_id, refresh_token)
  VALUES (v_connection_id, p_refresh_token)
  ON CONFLICT (connection_id) DO UPDATE
    SET refresh_token = EXCLUDED.refresh_token;
END;
$$;

CREATE FUNCTION public.google_oauth_token_read(p_user_id uuid)
RETURNS TABLE (refresh_token text, account_email text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT t.refresh_token, c.account_email
  FROM public.google_connections AS c
  JOIN private.google_oauth_tokens AS t ON t.connection_id = c.id
  WHERE c.user_id = p_user_id AND c.is_connected
  LIMIT 1;
$$;

CREATE FUNCTION public.google_oauth_token_delete(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM private.google_oauth_tokens AS t
  USING public.google_connections AS c
  WHERE t.connection_id = c.id AND c.user_id = p_user_id;

  UPDATE public.google_connections
  SET is_connected = false
  WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.google_oauth_token_store(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.google_oauth_token_read(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.google_oauth_token_delete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.google_oauth_token_store(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.google_oauth_token_read(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.google_oauth_token_delete(uuid) TO service_role;
