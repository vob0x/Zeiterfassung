-- ─────────────────────────────────────────────────────────────────────────
-- Persistent per-user roles (admin / mitarbeiter)
-- ─────────────────────────────────────────────────────────────────────────
-- Up to now the role was DERIVED at runtime from team.creator_id —
-- whoever created the team was admin, everyone else was mitarbeiter.
-- That was simple but inflexible: the admin couldn't promote a teammate
-- to be a co-admin, and a creator couldn't step down.
--
-- This migration introduces ze_roles, a per-team per-user role table
-- modelled after the Dienstplan tool's dp_roles. The runtime hook
-- (useRole) now reads from this table with a fallback to creator_id
-- so existing teams keep working without manual migration.
--
-- Two-tier model (matching the original product brief):
--   admin       — full access (manage members + roles, delete master
--                 data, edit any teammate entry, see DayRing)
--   mitarbeiter — limited (own data only, no Format/Tätigkeit add,
--                 only team totals in the Team view)
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS public.ze_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin', 'mitarbeiter')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

-- ── updated_at auto-bump trigger ──
DROP TRIGGER IF EXISTS update_ze_roles_updated_at ON public.ze_roles;
CREATE TRIGGER update_ze_roles_updated_at
  BEFORE UPDATE ON public.ze_roles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Auto-seed admin role on team creation ──
-- Whoever inserts a row into teams becomes admin of that team. Reduces
-- the "team creator without admin row" edge case that the Dienstplan
-- store tries to repair at runtime.
CREATE OR REPLACE FUNCTION public.ze_seed_creator_admin_role()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.ze_roles (team_id, user_id, role)
  VALUES (NEW.id, NEW.creator_id, 'admin')
  ON CONFLICT (team_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS ze_seed_creator_admin_role_trg ON public.teams;
CREATE TRIGGER ze_seed_creator_admin_role_trg
  AFTER INSERT ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.ze_seed_creator_admin_role();

-- ── Auto-seed mitarbeiter role on team join ──
-- Whoever joins a team via team_members defaults to 'mitarbeiter'.
-- Idempotent: ON CONFLICT means an existing role is left untouched.
CREATE OR REPLACE FUNCTION public.ze_seed_member_role()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.ze_roles (team_id, user_id, role)
  VALUES (NEW.team_id, NEW.user_id, 'mitarbeiter')
  ON CONFLICT (team_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS ze_seed_member_role_trg ON public.team_members;
CREATE TRIGGER ze_seed_member_role_trg
  AFTER INSERT ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.ze_seed_member_role();

-- ── Backfill: for every existing team_members row, ensure a role exists ──
-- Existing teams from before this migration won't have ze_roles entries.
-- Seed creator → admin, everyone else → mitarbeiter.
INSERT INTO public.ze_roles (team_id, user_id, role)
SELECT t.id, t.creator_id, 'admin'
FROM public.teams t
WHERE NOT EXISTS (
  SELECT 1 FROM public.ze_roles r
  WHERE r.team_id = t.id AND r.user_id = t.creator_id
)
ON CONFLICT (team_id, user_id) DO NOTHING;

INSERT INTO public.ze_roles (team_id, user_id, role)
SELECT tm.team_id, tm.user_id, 'mitarbeiter'
FROM public.team_members tm
WHERE NOT EXISTS (
  SELECT 1 FROM public.ze_roles r
  WHERE r.team_id = tm.team_id AND r.user_id = tm.user_id
)
ON CONFLICT (team_id, user_id) DO NOTHING;

-- ── RLS ──
ALTER TABLE public.ze_roles ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the team can see all roles in that team
DROP POLICY IF EXISTS "ze_roles_select" ON public.ze_roles;
CREATE POLICY "ze_roles_select" ON public.ze_roles
  FOR SELECT USING (
    team_id IN (
      SELECT tm.team_id FROM public.team_members tm
      WHERE tm.user_id = auth.uid()
    )
  );

-- Helper: is the calling user an admin of `tid`?
-- We need to combine three sources for back-compat:
--   1. ze_roles.role = 'admin' for (tid, auth.uid())
--   2. teams.creator_id = auth.uid() (legacy fallback)
CREATE OR REPLACE FUNCTION public.ze_is_admin(tid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ze_roles
    WHERE team_id = tid AND user_id = auth.uid() AND role = 'admin'
  )
  OR EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = tid AND creator_id = auth.uid()
  );
$$;

-- INSERT/UPDATE/DELETE: admin only (or self-promote-to-admin via creator)
DROP POLICY IF EXISTS "ze_roles_insert" ON public.ze_roles;
CREATE POLICY "ze_roles_insert" ON public.ze_roles
  FOR INSERT WITH CHECK (public.ze_is_admin(team_id));

DROP POLICY IF EXISTS "ze_roles_update" ON public.ze_roles;
CREATE POLICY "ze_roles_update" ON public.ze_roles
  FOR UPDATE
  USING (public.ze_is_admin(team_id))
  WITH CHECK (public.ze_is_admin(team_id));

DROP POLICY IF EXISTS "ze_roles_delete" ON public.ze_roles;
CREATE POLICY "ze_roles_delete" ON public.ze_roles
  FOR DELETE USING (public.ze_is_admin(team_id));

-- Index for the most common access path: lookup by (team_id, user_id)
CREATE INDEX IF NOT EXISTS ze_roles_team_user_idx
  ON public.ze_roles(team_id, user_id);
