-- Situation of an appointment is owned by its user and never sent to Google.
ALTER TABLE public.events
  ADD COLUMN attendance_status text NOT NULL DEFAULT 'scheduled'
  CONSTRAINT events_attendance_status_valid CHECK (
    attendance_status IN ('scheduled', 'completed', 'missed', 'no_show', 'rescheduled')
  );

COMMENT ON COLUMN public.events.attendance_status IS
  'User-owned appointment outcome; independent of Google synchronization status.';
