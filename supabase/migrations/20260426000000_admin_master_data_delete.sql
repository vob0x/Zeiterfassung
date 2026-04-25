-- ─────────────────────────────────────────────────────────────────────────
-- Admin (team creator) DELETE policies for master data tables
-- ─────────────────────────────────────────────────────────────────────────
-- Symptom we're fixing: when an admin deletes a Tätigkeit / Stakeholder /
-- Projekt / Format, the entry reappears on the next sync. Cause: the value
-- exists in OTHER team members' namespaces (master data is per-user) and
-- the merged team RLS read brings them back into the admin's display.
--
-- Fix: extend the base "owner-only" DELETE policies with an admin variant
-- that lets the team creator delete teammate rows. Combined with the
-- client-side fix that decrypts names and matches IDs across all team
-- members, deleting "Konzept" now removes ALL "Konzept" rows for every
-- member — the way users intuitively expect master data to behave.
--
-- These policies are ADDITIVE (Postgres OR-combines policies of the same
-- command), so the base owner-DELETE policy keeps working for solo users
-- and Mitarbeiter editing their own data.
--
-- Idempotent: safe to run multiple times.

-- ── Stakeholders ──
DROP POLICY IF EXISTS "sh_delete_admin" ON public.stakeholders;
CREATE POLICY "sh_delete_admin" ON public.stakeholders
  FOR DELETE
  USING (
    user_id IN (
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  );

-- ── Projects ──
DROP POLICY IF EXISTS "pr_delete_admin" ON public.projects;
CREATE POLICY "pr_delete_admin" ON public.projects
  FOR DELETE
  USING (
    user_id IN (
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  );

-- ── Activities ──
DROP POLICY IF EXISTS "act_delete_admin" ON public.activities;
CREATE POLICY "act_delete_admin" ON public.activities
  FOR DELETE
  USING (
    user_id IN (
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  );

-- ── Formats ──
DROP POLICY IF EXISTS "fmt_delete_admin" ON public.formats;
CREATE POLICY "fmt_delete_admin" ON public.formats
  FOR DELETE
  USING (
    user_id IN (
      SELECT tm.user_id
      FROM public.team_members tm
      JOIN public.teams t ON t.id = tm.team_id
      WHERE t.creator_id = auth.uid()
    )
  );
