
ALTER TABLE public.profiles
  ADD COLUMN legacy_imported_at timestamptz;

CREATE OR REPLACE FUNCTION public.initialize_user()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  INSERT INTO public.profiles (id)
  VALUES (v_user_id)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.calendars (user_id, kind, name, color, is_default)
  VALUES
    (v_user_id, 'pf', 'Pessoal', '#102A43', true),
    (v_user_id, 'pj', 'Profissional', '#F57C00', true)
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.initialize_user() TO authenticated;
