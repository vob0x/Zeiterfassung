-- ─────────────────────────────────────────────────────────────────────────
-- Admin (team creator) edit-teammate-entries policies
-- ─────────────────────────────────────────────────────────────────────────
-- The base RLS for time_entries restricts UPDATE/DELETE to auth.uid() = user_id.
-- For the role model introduced after the 2-week pilot, the team creator
-- ("Admin") needs to be able to edit and delete teammate entries from the
-- Team view's drill-down. Joiners ("Mitarbeiter") keep the base policy and
-- can still only edit their own data.
--
-- These policies are ADDITIVE — Postgres OR-combines policies of the same
-- command, so a row passes if ANY policy permits it. We don't drop the
-- existing te_update / te_delete; we simply add admin equivalents.
--
-- Idempotent: run multiple times safely.

-- ── UPDATE: admin (creator) can update teammate rows ──
DROP POLICY IF EXISTS "te_update_admin" ON public.time_entries;
CREATE POLICY "te_update_admin" ON public.time_entries
  FOR UPDATE
  USING (
    user_id IN (
      -- Members of any team where the calling user is the creator
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  );

-- ── DELETE: admin (creator) can delete teammate rows ──
DROP POLICY IF EXISTS "te_delete_admin" ON public.time_entries;
CREATE POLICY "te_delete_admin" ON public.time_entries
  FOR DELETE
  USING (
    user_id IN (
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  );
