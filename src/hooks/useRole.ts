import { useMemo } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useTeamStore } from '@/stores/teamStore'

/**
 * User role within the current team context.
 *
 * - `solo`     → user is not in a team. Treated like an admin (no restrictions),
 *                because outside of team context there is no privacy/permission
 *                boundary to enforce.
 * - `admin`    → full access (manage members + roles, master data, edit
 *                teammate entries, see DayRing).
 * - `mitarbeiter` → restricted: own data only, no Format/Tätigkeit add,
 *                only team totals in Team view, no DayRing.
 */
export type UserRole = 'admin' | 'mitarbeiter' | 'solo'

/**
 * Reads the current user's role from teamStore.roles, with a creator_id
 * fallback for legacy teams that pre-date the persistent-roles migration
 * (20260427000000). Reactive via Zustand selectors.
 */
export function useRole(): UserRole {
  const profile = useAuthStore((s) => s.profile)
  const team = useTeamStore((s) => s.team)
  const connected = useTeamStore((s) => s.connected)
  const roles = useTeamStore((s) => s.roles)

  return useMemo<UserRole>(() => {
    if (!connected || !team) return 'solo'
    if (!profile?.id) return 'mitarbeiter'
    // 1) Persistent role row wins
    const row = roles.find((r) => r.user_id === profile.id && r.team_id === team.id)
    if (row?.role) return row.role as UserRole
    // 2) Legacy fallback: team creator is admin
    if (team.creator_id === profile.id) return 'admin'
    return 'mitarbeiter'
  }, [connected, team, profile?.id, roles])
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
