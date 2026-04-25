import { useMemo } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useTeamStore } from '@/stores/teamStore'

/**
 * User role within the current team context.
 *
 * - `solo`     → user is not in a team. Treated like an admin (no restrictions),
 *                because outside of team context there is no privacy/permission
 *                boundary to enforce.
 * - `admin`    → user is the team creator. Full access to all features:
 *                edit any master data category, view & edit teammates' entries,
 *                see DayRing & goal animations, see per-member breakdowns.
 * - `mitarbeiter` → user joined an existing team. Restricted permissions:
 *                may only add Stakeholder + Projekt (not Format / Tätigkeit),
 *                no per-member breakdown in Team view, no DayRing / goal animations.
 */
export type UserRole = 'admin' | 'mitarbeiter' | 'solo'

/**
 * Derives the current user's role from auth + team state.
 *
 * Roles are derived rather than persisted (no schema migration needed):
 * the team creator is always admin, joiners are always mitarbeiter.
 */
export function useRole(): UserRole {
  const profile = useAuthStore((s) => s.profile)
  const team = useTeamStore((s) => s.team)
  const connected = useTeamStore((s) => s.connected)

  return useMemo<UserRole>(() => {
    if (!connected || !team) return 'solo'
    if (!profile?.id) return 'mitarbeiter'
    return team.creator_id === profile.id ? 'admin' : 'mitarbeiter'
  }, [connected, team, profile?.id])
}

/**
 * Convenience: true when the user has full admin privileges
 * (admin or solo). Use this in UI gates around restricted features.
 */
export function useIsAdmin(): boolean {
  const role = useRole()
  return role === 'admin' || role === 'solo'
}

/**
 * Convenience: true when the user is in mitarbeiter mode and should
 * see the restricted UI (no Format/Tätigkeit editing, no DayRing,
 * no per-member breakdowns).
 */
export function useIsMitarbeiter(): boolean {
  return useRole() === 'mitarbeiter'
}
