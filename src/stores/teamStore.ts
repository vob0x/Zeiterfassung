import { create } from 'zustand';
import { Team, TeamMember, TimeEntry, PeriodType } from '@/types';
import { getUserData, setUserData, removeUserData } from '@/lib/userStorage';
import { useAuthStore } from './authStore';
import { supabaseClient, isSupabaseAvailable, ensureValidSession } from '@/lib/supabase';
import { formatDateISO } from '@/lib/utils';
import { decryptEntryFromSupabase } from './entriesStore';
import {
  hasEncryptionKey,
  generateTeamKey,
  encryptTeamKeyForTransport,
  decryptTeamKeyFromTransport,
  encryptTeamKeyWithPersonalKey,
  decryptTeamKeyWithPersonalKey,
  setTeamKey,
  getTeamKeyB64,
  clearTeamKey,
  hasTeamKey,
} from '@/lib/crypto';

interface TeamState {
  team: Team | null;
  members: TeamMember[];
  memberEntries: Map<string, TimeEntry[]>;
  period: PeriodType;
  connected: boolean;
  loading: boolean;
  error: string | null;
  createTeam: (name: string) => Promise<void>;
  joinTeam: (inviteCode: string, displayName?: string) => Promise<void>;
  leaveTeam: () => Promise<void>;
  removeMember: (memberUserId: string) => Promise<void>;
  syncTeamData: () => Promise<void>;
  setTeamPeriod: (period: PeriodType) => void;
  getTeamMemberEntries: (memberId: string) => TimeEntry[];
  setError: (error: string | null) => void;
  clearError: () => void;
}

// Generate a unique 6-character invite code
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  team: null,
  members: [],
  memberEntries: new Map(),
  period: 'week',
  connected: false,
  loading: false,
  error: null,

  // ========================================================================
  // CREATE TEAM
  // ========================================================================
  createTeam: async (name: string) => {
    set({ loading: true, error: null });
    try {
      const profile = useAuthStore.getState().profile;
      const userId = profile?.id || 'anonymous';
      const displayName = profile?.codename || 'User';

      // ── Supabase mode ──
      if (isSupabaseAvailable() && supabaseClient) {
        const inviteCode = generateInviteCode();

        // Generate Team Key for E2E encryption
        const teamKeyB64 = await generateTeamKey();

        // Insert team (with transport-encrypted Team Key)
        // We need the team ID first, so insert without the key, then update
        const { data: teamData, error: teamErr } = await supabaseClient
          .from('teams')
          .insert({
            name,
            creator_id: userId,
            invite_code: inviteCode,
          })
          .select()
          .single();

        if (teamErr) throw new Error(teamErr.message);

        // Encrypt Team Key with invite-code-derived transport key
        const transportEncryptedKey = await encryptTeamKeyForTransport(
          teamKeyB64, inviteCode, teamData.id
        );

        // Update team with encrypted Team Key (check for errors!)
        const { error: tkErr } = await supabaseClient
          .from('teams')
          .update({ encrypted_team_key: transportEncryptedKey })
          .eq('id', teamData.id);
        if (tkErr) {
          console.error('[Team E2E] Failed to store transport-encrypted Team Key:', tkErr.message);
        }

        // Encrypt Team Key with creator's personal key (for session persistence)
        let personalEncryptedKey = '';
        if (hasEncryptionKey()) {
          personalEncryptedKey = await encryptTeamKeyWithPersonalKey(teamKeyB64);
        }

        // Insert creator as first member (with personal-key-encrypted Team Key)
        const { error: memberErr } = await supabaseClient
          .from('team_members')
          .insert({
            team_id: teamData.id,
            user_id: userId,
            encrypted_team_key: personalEncryptedKey,
          });

        if (memberErr) throw new Error(memberErr.message);

        // Store Team Key in sessionStorage for immediate use
        setTeamKey(teamKeyB64);

        const team: Team = {
          id: teamData.id,
          name: teamData.name,
          creator_id: teamData.creator_id,
          invite_code: teamData.invite_code,
          created_at: teamData.created_at,
          updated_at: teamData.updated_at,
        };

        const member: TeamMember = {
          id: `${teamData.id}_${userId}`,
          team_id: teamData.id,
          user_id: userId,
          display_name: displayName,
          joined_at: new Date().toISOString(),
        };

        const memberEntriesMap = new Map<string, TimeEntry[]>();
        memberEntriesMap.set(displayName, []);

        set({
          team,
          members: [member],
          memberEntries: memberEntriesMap,
          connected: true,
          loading: false,
        });

        // Also persist locally for offline recovery
        setUserData('team', team);
        setUserData('teamMembers', [member]);
        return;
      }

      // ── Offline/local mode ──
      const inviteCode = generateInviteCode();
      const newTeam: Team = {
        id: `team_${Date.now()}`,
        name,
        creator_id: userId,
        invite_code: inviteCode,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const creatorMember: TeamMember = {
        id: `member_${Date.now()}`,
        team_id: newTeam.id,
        user_id: userId,
        display_name: displayName,
        joined_at: new Date().toISOString(),
      };

      const currentEntries = getUserData<TimeEntry[]>('entries', []);
      const memberEntriesMap = new Map<string, TimeEntry[]>();
      memberEntriesMap.set(displayName, currentEntries);

      set({
        team: newTeam,
        members: [creatorMember],
        memberEntries: memberEntriesMap,
        connected: true,
        loading: false,
      });

      setUserData('team', newTeam);
      setUserData('teamMembers', [creatorMember]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create team';
      set({ error: message, loading: false });
      throw error;
    }
  },

  // ========================================================================
  // JOIN TEAM
  // ========================================================================
  joinTeam: async (inviteCode: string, displayName?: string) => {
    set({ loading: true, error: null });
    try {
      const profile = useAuthStore.getState().profile;
      const userName = displayName || profile?.codename || 'User';
      const userId = profile?.id || 'anonymous';

      // ── Supabase mode ──
      if (isSupabaseAvailable() && supabaseClient) {
        // Ensure auth session is valid before joining
        await ensureValidSession();

        // Use SECURITY DEFINER RPC function — bypasses RLS completely.
        // The direct query approach fails when the teams_select_by_invite_code
        // RLS policy hasn't been deployed, because the default teams_select
        // policy only allows creators/members to read the teams table.
        const { data: rpcResult, error: rpcErr } = await supabaseClient
          .rpc('join_team_by_code', { p_invite_code: inviteCode.toUpperCase() });

        if (rpcErr) {
          const msg = rpcErr.message || '';
          if (msg.includes('INVALID_INVITE_CODE')) {
            throw new Error('INVALID_INVITE_CODE');
          }
          throw new Error(msg);
        }
        if (!rpcResult) throw new Error('INVALID_INVITE_CODE');

        const teamRow = rpcResult as any;
        const team: Team = {
          id: teamRow.id,
          name: teamRow.name,
          creator_id: teamRow.creator_id,
          invite_code: teamRow.invite_code,
          created_at: teamRow.created_at,
          updated_at: teamRow.updated_at,
        };

        // Decrypt Team Key using invite code (E2E key exchange)
        let teamKeyB64 = '';
        if (teamRow.encrypted_team_key) {
          try {
            teamKeyB64 = await decryptTeamKeyFromTransport(
              teamRow.encrypted_team_key,
              inviteCode.toUpperCase(),
              team.id
            );
            // Store Team Key in sessionStorage
            setTeamKey(teamKeyB64);

            // Also encrypt with personal key and store on team_members row
            if (hasEncryptionKey()) {
              const personalEncrypted = await encryptTeamKeyWithPersonalKey(teamKeyB64);
              await supabaseClient
                .from('team_members')
                .update({ encrypted_team_key: personalEncrypted })
                .eq('team_id', team.id)
                .eq('user_id', userId);
            }
          } catch (e) {
            console.error('[Team E2E] Failed to decrypt Team Key from transport:', e);
          }
        }

        const member: TeamMember = {
          id: `${team.id}_${userId}`,
          team_id: team.id,
          user_id: userId,
          display_name: userName,
          joined_at: new Date().toISOString(),
        };

        set({
          team,
          members: [member],
          connected: true,
          loading: false,
        });

        setUserData('team', team);
        setUserData('teamMembers', [member]);

        // Immediately sync to get all members and their entries
        await get().syncTeamData();
        return;
      }

      // ── Offline/local mode ──
      const newTeam: Team = {
        id: `team_${Date.now()}`,
        name: userName,
        invite_code: inviteCode.toUpperCase(),
        creator_id: 'other_user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const newMember: TeamMember = {
        id: `member_${Date.now()}`,
        team_id: newTeam.id,
        user_id: userId,
        display_name: userName,
        joined_at: new Date().toISOString(),
      };

      set({
        team: newTeam,
        members: [newMember],
        connected: true,
        loading: false,
      });

      setUserData('team', newTeam);
      setUserData('teamMembers', [newMember]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to join team';
      set({ error: message, loading: false });
      throw error;
    }
  },

  // ========================================================================
  // LEAVE TEAM
  // ========================================================================
  leaveTeam: async () => {
    set({ loading: true, error: null });
    try {
      // ── Supabase mode ──
      if (isSupabaseAvailable() && supabaseClient) {
        const profile = useAuthStore.getState().profile;
        const team = get().team;

        if (profile?.id && team?.id) {
          // Delete team_member row (RLS ensures only own rows)
          await supabaseClient
            .from('team_members')
            .delete()
            .eq('team_id', team.id)
            .eq('user_id', profile.id);

          // If creator, delete the entire team
          if (team.creator_id === profile.id) {
            await supabaseClient
              .from('teams')
              .delete()
              .eq('id', team.id);
          }
        }
      }

      // Clear Team Key from sessionStorage
      clearTeamKey();

      // Clear local state
      removeUserData('team');
      removeUserData('teamMembers');
      removeUserData('memberEntries');

      set({
        team: null,
        members: [],
        memberEntries: new Map(),
        connected: false,
        loading: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to leave team';
      set({ error: message, loading: false });
      throw error;
    }
  },

  // ========================================================================
  // REMOVE MEMBER (creator only)
  // ========================================================================
  removeMember: async (memberUserId: string) => {
    set({ error: null });
    try {
      const profile = useAuthStore.getState().profile;
      const team = get().team;

      if (!profile?.id || !team?.id) throw new Error('Not authenticated or no team');
      if (team.creator_id !== profile.id) throw new Error('Only the team creator can remove members');

      if (isSupabaseAvailable() && supabaseClient) {
        // Delete from team_members directly by user_id (no codename lookup needed)
        const { error: delErr } = await supabaseClient
          .from('team_members')
          .delete()
          .eq('team_id', team.id)
          .eq('user_id', memberUserId);

        if (delErr) throw new Error(delErr.message);
      }

      // Update local state — find display_name for memberEntries cleanup
      const removedMember = get().members.find((m) => m.user_id === memberUserId);
      const members = get().members.filter((m) => m.user_id !== memberUserId);
      const memberEntries = new Map(get().memberEntries);
      if (removedMember?.display_name) {
        memberEntries.delete(removedMember.display_name);
      }

      set({ members, memberEntries });
      setUserData('teamMembers', members);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove member';
      set({ error: message });
      throw error;
    }
  },

  // ========================================================================
  // SYNC TEAM DATA
  // ========================================================================
  syncTeamData: async () => {
    set({ loading: true, error: null });
    try {
      const profile = useAuthStore.getState().profile;
      // displayName will be overridden by profileMap (from Supabase) for consistency
      let displayName = profile?.codename || 'User';

      // ── Supabase mode ──
      if (isSupabaseAvailable() && supabaseClient && profile?.id) {
        // Ensure auth session is valid before querying (avoids 401 spam)
        const sessionOk = await ensureValidSession();
        if (!sessionOk) {
          set({ loading: false });
          return;
        }

        // Check if user is in any team (also fetch encrypted_team_key for E2E)
        const { data: membershipData } = await supabaseClient
          .from('team_members')
          .select('team_id, encrypted_team_key')
          .eq('user_id', profile.id)
          .limit(1);

        if (!membershipData || membershipData.length === 0) {
          // Supabase is available but user has no team — not connected
          // (ignore stale localStorage team data when online)
          set({ loading: false, connected: false });
          return;
        }

        const teamId = membershipData[0].team_id;

        // Fetch team details FIRST — we need invite_code + encrypted_team_key
        // for Team Key restoration fallback
        const { data: teamData } = await supabaseClient
          .from('teams')
          .select('*')
          .eq('id', teamId)
          .single();

        if (!teamData) {
          set({ loading: false, connected: false });
          return;
        }

        // ── Team Key Restoration (3-tier fallback + auto-generate) ──
        // Priority: sessionStorage → team_members (personal-encrypted) →
        //           teams table (transport-encrypted) → generate new key
        if (!hasTeamKey() && hasEncryptionKey()) {
          // Path 1: Personal-key-encrypted copy on team_members row
          if (membershipData[0].encrypted_team_key) {
            try {
              const teamKeyB64 = await decryptTeamKeyWithPersonalKey(
                membershipData[0].encrypted_team_key
              );
              setTeamKey(teamKeyB64);
              console.info('[Team E2E] Team Key restored from personal-encrypted copy');
            } catch (e) {
              console.warn('[Team E2E] Path 1 failed (personal copy):', e);
            }
          } else {
            console.info('[Team E2E] Path 1 skipped — no encrypted_team_key on team_members row');
          }

          // Path 2: Transport-encrypted copy from teams table (invite-code-derived key)
          if (!hasTeamKey()) {
            if (teamData.encrypted_team_key && teamData.invite_code) {
              try {
                const teamKeyB64 = await decryptTeamKeyFromTransport(
                  teamData.encrypted_team_key,
                  teamData.invite_code,
                  teamData.id
                );
                setTeamKey(teamKeyB64);
                console.info('[Team E2E] Team Key restored from transport-encrypted copy');
              } catch (e) {
                console.warn('[Team E2E] Path 2 failed (transport copy):', e);
              }
            } else {
              console.info('[Team E2E] Path 2 skipped — teams.encrypted_team_key or invite_code is null');
            }
          }

          // Path 3: Team Key is unrecoverable → generate a new one.
          // This happens when the team was created before the E2E columns existed,
          // or when the DB was reset. Since no Team Key ever existed, all entries
          // were encrypted with the Personal Key and remain decryptable.
          // The new Team Key will be used for FUTURE entries only.
          if (!hasTeamKey()) {
            console.warn('[Team E2E] Team Key unrecoverable — generating a new Team Key');
            try {
              const newTeamKeyB64 = await generateTeamKey();
              setTeamKey(newTeamKeyB64);

              // Persist transport-encrypted copy to teams table
              const transportEncrypted = await encryptTeamKeyForTransport(
                newTeamKeyB64, teamData.invite_code, teamData.id
              );
              await supabaseClient
                .from('teams')
                .update({ encrypted_team_key: transportEncrypted })
                .eq('id', teamId);

              console.info('[Team E2E] New Team Key generated and stored on teams table');
            } catch (e) {
              console.error('[Team E2E] Failed to generate new Team Key:', e);
            }
          }
        }

        // Persist Team Key to team_members row (if not already there)
        // This ensures the key survives across sessions/devices via Path 1
        if (hasTeamKey() && hasEncryptionKey() && !membershipData[0].encrypted_team_key) {
          try {
            const personalEncrypted = await encryptTeamKeyWithPersonalKey(getTeamKeyB64()!);
            await supabaseClient
              .from('team_members')
              .update({ encrypted_team_key: personalEncrypted })
              .eq('team_id', teamId)
              .eq('user_id', profile.id);
            console.info('[Team E2E] Persisted Team Key to team_members row');
          } catch (e) {
            console.warn('[Team E2E] Could not persist Team Key to team_members:', e);
          }
        }

        const team: Team = {
          id: teamData.id,
          name: teamData.name,
          creator_id: teamData.creator_id,
          invite_code: teamData.invite_code,
          created_at: teamData.created_at,
          updated_at: teamData.updated_at,
        };

        // Fetch all team members with their profiles
        const { data: membersData } = await supabaseClient
          .from('team_members')
          .select(`
            id,
            team_id,
            user_id,
            joined_at
          `)
          .eq('team_id', teamId);

        // Fetch codenames for each member (decrypt from DB)
        const memberUserIds = (membersData || []).map((m: any) => m.user_id);
        const { data: profilesData } = await supabaseClient
          .from('profiles')
          .select('id, codename')
          .in('id', memberUserIds);

        // Normalize codenames: use original casing from Supabase profiles (source of truth)
        // This prevents "Gnac" vs "gnac" appearing as two different users
        const profileMap = new Map<string, string>();
        const seenNames = new Map<string, string>(); // lowercase → first-seen original casing
        (profilesData || []).forEach((p: any) => {
          const raw = p.codename || p.id;
          const lower = raw.toLowerCase();
          // Use first-seen casing for consistency
          if (!seenNames.has(lower)) {
            seenNames.set(lower, raw);
          }
          profileMap.set(p.id, seenNames.get(lower)!);
        });

        // Override displayName for current user from profileMap (single source of truth)
        if (profile?.id && profileMap.has(profile.id)) {
          displayName = profileMap.get(profile.id)!;
        }

        const members: TeamMember[] = (membersData || []).map((m: any) => ({
          id: m.id,
          team_id: m.team_id,
          user_id: m.user_id, // Keep real UUID
          display_name: profileMap.get(m.user_id) || m.user_id,
          joined_at: m.joined_at,
        }));

        // Fetch all team members' entries directly (RLS handles visibility)
        const memberEntriesMap = new Map<string, TimeEntry[]>();
        for (const uid of memberUserIds) {
          const displayName_member = profileMap.get(uid) || uid;
          const { data: entriesData } = await supabaseClient
            .from('time_entries')
            .select('*')
            .eq('user_id', uid)
            .order('date', { ascending: false });

          if (entriesData) {
            // Use shared decryptEntryFromSupabase for consistent decryption
            // (same defaults, stakeholder migration, format fallback as entriesStore)
            const entries: TimeEntry[] = await Promise.all(
              entriesData.map(async (row: any) => {
                const decrypted = await decryptEntryFromSupabase(row);
                let stakeholder: string | string[] = decrypted.stakeholder || '';
                if (typeof stakeholder === 'string' && stakeholder) {
                  stakeholder = [stakeholder];
                }
                return {
                  id: decrypted.id,
                  user_id: decrypted.user_id,
                  date: typeof decrypted.date === 'string' ? decrypted.date : formatDateISO(new Date(decrypted.date)),
                  stakeholder,
                  projekt: decrypted.projekt || '',
                  taetigkeit: decrypted.taetigkeit || '',
                  format: decrypted.format || 'Einzelarbeit',
                  start_time: decrypted.start_time || '',
                  end_time: decrypted.end_time || '',
                  duration_ms: decrypted.duration_ms || 0,
                  notiz: decrypted.notiz || '',
                  created_at: decrypted.created_at || '',
                  updated_at: decrypted.updated_at || '',
                };
              })
            );
            // Filter out entries where decryption failed (empty date = unrecoverable)
            const validEntries = entries.filter(e => e.date && e.date !== '');
            memberEntriesMap.set(displayName_member, validEntries);
          }
        }

        // Also include current user's VERY RECENT local entries not yet in Supabase
        // (prevents zombie entries from re-syncing after deletion on another device)
        const localEntries = getUserData<TimeEntry[]>('entries', []);
        if (localEntries.length > 0) {
          const existing = memberEntriesMap.get(displayName) || [];
          const existingIds = new Set(existing.map((e) => e.id));
          const now = Date.now();
          const RECENT_MS = 30000; // 30 seconds
          const newLocal = localEntries.filter((e) => {
            if (existingIds.has(e.id)) return false;
            // Only add if very recently created (not yet pushed to Supabase)
            const createdAt = e.created_at ? new Date(e.created_at).getTime() : 0;
            return (now - createdAt) < RECENT_MS;
          });
          if (newLocal.length > 0) {
            memberEntriesMap.set(displayName, [...existing, ...newLocal]);
          }
        }

        set({
          team,
          members,
          memberEntries: memberEntriesMap,
          connected: true,
          loading: false,
        });

        // Persist locally for offline recovery
        setUserData('team', team);
        setUserData('teamMembers', members);
        return;
      }

      // ── Offline/local mode ──
      await syncLocalData(set, get, displayName);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync team data';
      set({ error: message, loading: false });
      // Don't throw — sync failures should not crash the app
      console.error('Team sync error:', message);
    }
  },

  setTeamPeriod: (period: PeriodType) => {
    set({ period });
  },

  getTeamMemberEntries: (memberId: string): TimeEntry[] => {
    const state = get();
    return state.memberEntries.get(memberId) || [];
  },

  setError: (error: string | null) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },
}));

// ========================================================================
// Helper: Sync from localStorage (offline fallback)
// ========================================================================
async function syncLocalData(
  set: (state: Partial<TeamState>) => void,
  _get: () => TeamState,
  displayName: string
) {
  const team = getUserData<Team | null>('team', null);
  const members = getUserData<TeamMember[]>('teamMembers', []);
  const memberEntriesData = getUserData<Record<string, TimeEntry[]>>('memberEntries', {});

  if (team) {
    const memberEntriesMap = new Map<string, TimeEntry[]>();
    for (const [memberId, entries] of Object.entries(memberEntriesData)) {
      memberEntriesMap.set(memberId, entries as TimeEntry[]);
    }

    // Load current user's entries
    const currentEntries = getUserData<TimeEntry[]>('entries', []);
    memberEntriesMap.set(displayName, currentEntries);

    set({
      team,
      members,
      memberEntries: memberEntriesMap,
      connected: true,
      loading: false,
    });
  } else {
    set({ loading: false, connected: false });
  }
}

// ── Cross-Device Team Sync ──────────────────────────────────────────────

let _teamPollInterval: ReturnType<typeof setInterval> | null = null;
let _teamRealtimeChannels: any[] = [];
let _teamSuppressUntil: number = 0;

async function pullTeamDataFromSupabase(): Promise<void> {
  if (Date.now() < _teamSuppressUntil) return;

  const state = useTeamStore.getState();
  if (!state.connected || !state.team) return;

  // Re-use the existing syncTeamData logic, but silently
  try {
    // Don't set loading to true for background sync
    const profile = useAuthStore.getState().profile;
    if (!isSupabaseAvailable() || !supabaseClient || !profile?.id) return;

    // Ensure auth session is valid before querying (avoids 401 spam)
    const sessionOk = await ensureValidSession();
    if (!sessionOk) return;

    const teamId = state.team.id;

    // Quick check: fetch member count + latest entry timestamp
    const { data: membersData } = await supabaseClient
      .from('team_members')
      .select('id, user_id, joined_at')
      .eq('team_id', teamId);

    if (Date.now() < _teamSuppressUntil) return;

    const memberUserIds = (membersData || []).map((m: any) => m.user_id);
    const currentMemberIds = state.members.map(m => m.user_id).sort().join(',');
    const remoteMemberIds = memberUserIds.sort().join(',');

    // Check if members changed
    const membersChanged = currentMemberIds !== remoteMemberIds;

    // Check if entries changed (quick count check)
    let entriesChanged = false;
    if (!membersChanged) {
      const { count } = await supabaseClient
        .from('time_entries')
        .select('id', { count: 'exact', head: true })
        .in('user_id', memberUserIds);

      if (Date.now() < _teamSuppressUntil) return;

      let currentTotal = 0;
      state.memberEntries.forEach(entries => { currentTotal += entries.length; });
      entriesChanged = (count || 0) !== currentTotal;
    }

    if (!membersChanged && !entriesChanged) return;

    // Something changed — do a full sync
    await useTeamStore.getState().syncTeamData();
  } catch (e) {
    // silent
  }
}

export function subscribeToTeamSync(): void {
  const state = useTeamStore.getState();
  if (!state.connected || !state.team) return;
  if (!isSupabaseAvailable() || !supabaseClient) return;

  unsubscribeFromTeamSync();

  const teamId = state.team.id;
  // Poll every 120s as safety net (Realtime is the primary sync mechanism)
  _teamPollInterval = setInterval(() => {
    pullTeamDataFromSupabase();
  }, 120000);

  // Realtime: listen for team_members changes
  try {
    const memberChannel = supabaseClient
      .channel(`team-members-${teamId}`)
      .on(
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'team_members',
          filter: `team_id=eq.${teamId}`,
        },
        () => {
          setTimeout(() => pullTeamDataFromSupabase(), 1000);
        }
      )
      .subscribe();
    _teamRealtimeChannels.push(memberChannel);
  } catch (e) {
    // Realtime failed, polling is the fallback
  }

  // Realtime: listen for time_entries changes from all team members
  const memberUserIds = state.members.map(m => m.user_id);
  for (const uid of memberUserIds) {
    try {
      const entryChannel = supabaseClient
        .channel(`team-entries-${uid}`)
        .on(
          'postgres_changes' as any,
          {
            event: '*',
            schema: 'public',
            table: 'time_entries',
            filter: `user_id=eq.${uid}`,
          },
          () => {
            setTimeout(() => pullTeamDataFromSupabase(), 1000);
          }
        )
        .subscribe();
      _teamRealtimeChannels.push(entryChannel);
    } catch (e) {
      // silent
    }
  }
}

export function unsubscribeFromTeamSync(): void {
  if (_teamRealtimeChannels.length > 0 && supabaseClient) {
    for (const ch of _teamRealtimeChannels) {
      try { supabaseClient.removeChannel(ch); } catch (_) {}
    }
    _teamRealtimeChannels = [];
  }
  if (_teamPollInterval) {
    clearInterval(_teamPollInterval);
    _teamPollInterval = null;
  }
}

// Suppress after local team mutations
useTeamStore.subscribe((state, prevState) => {
  if (state.members !== prevState.members || state.memberEntries !== prevState.memberEntries) {
    _teamSuppressUntil = Date.now() + 5000;
  }
});

// NOTE: Team sync is deferred to after auth (called from App.tsx),
// NOT on store creation, because we need the user ID for scoped keys.
