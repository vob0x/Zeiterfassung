-- ============================================================
-- server_now_ms() — returns the database server's current
-- wall-clock time in milliseconds since epoch.
--
-- Used by the timer store to anchor multi-device timer state
-- against a single shared clock instead of each device's own
-- (potentially skewed) Date.now(). Without this, two devices
-- with different system clocks display different elapsed
-- times for the same running timer.
-- ============================================================

CREATE OR REPLACE FUNCTION public.server_now_ms()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT (extract(epoch from now()) * 1000)::bigint;
$$;

-- Allow any authenticated user to call this — it leaks no data.
GRANT EXECUTE ON FUNCTION public.server_now_ms() TO authenticated;
GRANT EXECUTE ON FUNCTION public.server_now_ms() TO anon;
