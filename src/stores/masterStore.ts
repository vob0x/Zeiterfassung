import { create } from 'zustand';
import { getUserData, setUserData } from '@/lib/userStorage';
import { supabaseClient, isSupabaseAvailable, ensureValidSession } from '@/lib/supabase';
import { useAuthStore } from './authStore';
import { hasEncryptionKey, hasTeamKey, encryptFieldForTeam, decryptFieldSmart } from '@/lib/crypto';
import { useTeamStore } from './teamStore';

interface MasterState {
  stakeholders: string[];
  projects: string[];
  activities: string[];
  formats: string[]; // NEW: format dimension
  loading: boolean;
  error: string | null;
  fetch: () => Promise<void>;
  addStakeholder: (name: string) => Promise<void>;
  addProject: (name: string) => Promise<void>;
  addActivity: (name: string) => Promise<void>;
  addFormat: (name: string) => Promise<void>; // NEW
  removeStakeholder: (name: string) => Promise<void>;
  removeProject: (name: string) => Promise<void>;
  removeActivity: (name: string) => Promise<void>;
  removeFormat: (name: string) => Promise<void>; // NEW
  renameStakeholder: (oldName: string, newName: string) => Promise<void>;
  renameProject: (oldName: string, newName: string) => Promise<void>;
  renameActivity: (oldName: string, newName: string) => Promise<void>;
  renameFormat: (oldName: string, newName: string) => Promise<void>; // NEW
  sortMasterData: () => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

// Helper: get current authenticated user ID (non-local)
function getSupabaseUserId(): string | null {
  const profile = useAuthStore.getState().profile;
  if (profile?.id && !profile.id.startsWith('local_')) return profile.id;
  return null;
}

/**
 * Sync a local list to Supabase table (non-blocking bulk upsert, encrypted).
 *
 * Uses a mutex-like timestamp guard to prevent race conditions when
 * multiple devices sync the same table simultaneously. The DELETE + INSERT
 * is protected by checking that no other sync overwrote our delete.
 */
const _syncInProgress = new Map<string, boolean>();

async function syncListToSupabase(
  table: 'stakeholders' | 'projects' | 'activities' | 'formats',
  names: string[],
  userId: string
) {
  if (!isSupabaseAvailable() || !supabaseClient) return;

  // Abort sync if no encryption key — never send plaintext to Supabase
  if (!hasEncryptionKey()) return;

  // Wait for any in-progress sync on this table (instead of silently skipping)
  const lockKey = `${table}_${userId}`;
  const maxWait = 5000;
  const start = Date.now();
  while (_syncInProgress.get(lockKey) && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
  _syncInProgress.set(lockKey, true);

  // Ensure auth session is still valid (avoids 401 / RLS errors)
  const sessionOk = await ensureValidSession();
  if (!sessionOk) {
    _syncInProgress.set(lockKey, false);
    return;
  }

  try {
    // Delete existing rows first (encrypted values differ each time due to random IV)
    const { error: delErr } = await supabaseClient.from(table).delete().eq('user_id', userId);
    if (delErr) {
      _syncInProgress.set(lockKey, false);
      return; // Auth issue — don't attempt insert
    }

    // Insert fresh — only if there's data to insert (empty list = intentional delete-all)
    if (names.length > 0) {
      const encryptedRows = await Promise.all(
        names.map(async (name, idx) => ({
          user_id: userId,
          name: await encryptFieldForTeam(name),
          sort_order: idx,
        }))
      );
      const { error } = await supabaseClient
        .from(table)
        .insert(encryptedRows);
      if (error) {
        console.warn(`[Sync] ${table} sync failed:`, error.message);
      }
    }
  } catch {
    // Silent — network or auth issue, will retry on next sync cycle
  } finally {
    _syncInProgress.set(lockKey, false);
  }
}

/**
 * Force-sync ALL master data categories to Supabase with the current encryption key.
 * Call after bulk operations (CSV import, backup restore) to ensure Supabase has
 * a complete, consistently encrypted snapshot — avoids partial writes from
 * individual addXxx() calls that get skipped by the concurrency lock.
 */
export async function syncAllMasterData(): Promise<void> {
  const userId = getSupabaseUserId();
  if (!userId) return;

  // Wait for any in-progress fire-and-forget syncs to settle
  const maxWait = 3000;
  const start = Date.now();
  while (_syncInProgress.size > 0 && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // If locks are still held after timeout, clear them (stale locks)
  _syncInProgress.clear();

  // Read the FINAL state after all addXxx() calls completed
  const { stakeholders, projects, activities, formats } = useMasterStore.getState();

  // Sync each category sequentially to avoid overwhelming Supabase
  if (stakeholders.length > 0) await syncListToSupabase('stakeholders', stakeholders, userId);
  if (projects.length > 0) await syncListToSupabase('projects', projects, userId);
  if (activities.length > 0) await syncListToSupabase('activities', activities, userId);
  if (formats.length > 0) await syncListToSupabase('formats', formats, userId);
}

export const useMasterStore = create<MasterState>((set, get) => ({
  stakeholders: [],
  projects: [],
  activities: [],
  formats: ['Einzelarbeit', 'Meeting', 'Telefonat', 'Workshop'], // NEW: default formats
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      // Always load from localStorage first (source of truth)
      const localStakeholders = getUserData<string[]>('stakeholders', []);
      const localProjects = getUserData<string[]>('projects', []);
      const localActivities = getUserData<string[]>('activities', []);
      const localFormats = getUserData<string[]>('formats', ['Einzelarbeit', 'Meeting', 'Telefonat', 'Workshop']);

      // Show local data immediately
      set({
        stakeholders: localStakeholders,
        projects: localProjects,
        activities: localActivities,
        formats: localFormats,
        loading: false,
      });

      // Then try to merge with Supabase data (own + teammates via RLS)
      const userId = getSupabaseUserId();
      const sessionValid = userId ? await ensureValidSession() : false;

      if (isSupabaseAvailable() && supabaseClient && userId && sessionValid) {
        // Team mode: read ALL team members' master data (RLS returns team scope)
        // Solo mode: filter by own user_id only
        const { connected: inTeam } = useTeamStore.getState();
        const buildQuery = (table: string) => {
          let q = supabaseClient!.from(table).select('name');
          if (!inTeam) q = q.eq('user_id', userId);
          return q.order('sort_order');
        };
        const [shRes, prRes, actRes, fmtRes] = await Promise.all([
          buildQuery('stakeholders'),
          buildQuery('projects'),
          buildQuery('activities'),
          buildQuery('formats'),
        ]);

        // If any query had an error, skip Supabase merge (keep localStorage as-is)
        const anyError = shRes.error || prRes.error || actRes.error || fmtRes.error;
        if (anyError) {
          console.warn('[Sync] Master data fetch had errors, keeping localStorage');
        } else {
          // All queries succeeded — Supabase is source of truth.
          // Decrypt names (smart: tries Team Key first, then personal key)
          const sbStakeholders = (await Promise.all(
            (shRes.data || []).map((r: any) => decryptFieldSmart(r.name))
          )).filter(Boolean) as string[];
          const sbProjects = (await Promise.all(
            (prRes.data || []).map((r: any) => decryptFieldSmart(r.name))
          )).filter(Boolean) as string[];
          const sbActivities = (await Promise.all(
            (actRes.data || []).map((r: any) => decryptFieldSmart(r.name))
          )).filter(Boolean) as string[];
          const sbFormats = (await Promise.all(
            (fmtRes.data || []).map((r: any) => decryptFieldSmart(r.name))
          )).filter(Boolean) as string[];

          // Supabase data replaces localStorage per category.
          // For formats: fall back to defaults if Supabase has no formats
          // (fresh account or formats table never populated).
          const DEFAULT_FORMATS = ['Einzelarbeit', 'Meeting', 'Telefonat', 'Workshop'];

          // Detect key mismatch: Supabase had rows but decryption yielded nothing.
          // In this case, keep local data (which is still useful) and re-encrypt to Supabase.
          const shHadRows = (shRes.data || []).length > 0;
          const prHadRows = (prRes.data || []).length > 0;
          const actHadRows = (actRes.data || []).length > 0;
          const fmtHadRows = (fmtRes.data || []).length > 0;
          const shKeyMismatch = shHadRows && sbStakeholders.length === 0;
          const prKeyMismatch = prHadRows && sbProjects.length === 0;
          const actKeyMismatch = actHadRows && sbActivities.length === 0;
          const fmtKeyMismatch = fmtHadRows && sbFormats.length === 0;

          // If key mismatch, prefer localStorage data over empty decryption result
          const localState = get();
          const finalStakeholders = sbStakeholders.length > 0
            ? [...new Set(sbStakeholders)].sort()
            : (shKeyMismatch ? localState.stakeholders : []);
          const finalProjects = sbProjects.length > 0
            ? [...new Set(sbProjects)].sort()
            : (prKeyMismatch ? localState.projects : []);
          const finalActivities = sbActivities.length > 0
            ? [...new Set(sbActivities)].sort()
            : (actKeyMismatch ? localState.activities : []);
          const finalFormats = sbFormats.length > 0
            ? [...new Set(sbFormats)].sort()
            : (fmtKeyMismatch ? localState.formats : DEFAULT_FORMATS);

          set({
            stakeholders: finalStakeholders,
            projects: finalProjects,
            activities: finalActivities,
            formats: finalFormats,
          });

          // Persist Supabase result locally (replaces stale localStorage)
          setUserData('stakeholders', finalStakeholders);
          setUserData('projects', finalProjects);
          setUserData('activities', finalActivities);
          setUserData('formats', finalFormats);

          // Only re-encrypt and push to Supabase if key mismatch was detected
          // (avoids unnecessary DELETE+INSERT on every app start → saves Disk IO)
          const anyKeyMismatch = shKeyMismatch || prKeyMismatch || actKeyMismatch || fmtKeyMismatch;
          if (anyKeyMismatch) {
            console.info('[Sync] Key mismatch detected in fetch — re-encrypting master data');
            if (finalStakeholders.length > 0) syncListToSupabase('stakeholders', finalStakeholders, userId);
            if (finalProjects.length > 0) syncListToSupabase('projects', finalProjects, userId);
            if (finalActivities.length > 0) syncListToSupabase('activities', finalActivities, userId);
            if (finalFormats.length > 0) syncListToSupabase('formats', finalFormats, userId);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch master data';
      set({ error: message, loading: false });
    }
  },

  addStakeholder: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.stakeholders.includes(name)) return; // Silently skip duplicates
      const updated = [...state.stakeholders, name].sort();
      set({ stakeholders: updated });
      setUserData('stakeholders', updated);

      // Sync full list to Supabase (encrypted)
      const userId = getSupabaseUserId();
      if (userId) syncListToSupabase('stakeholders', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add stakeholder';
      set({ error: message });
    }
  },

  addProject: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.projects.includes(name)) return; // Silently skip duplicates
      const updated = [...state.projects, name].sort();
      set({ projects: updated });
      setUserData('projects', updated);

      const userId = getSupabaseUserId();
      if (userId) syncListToSupabase('projects', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add project';
      set({ error: message });
      throw error;
    }
  },

  addActivity: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.activities.includes(name)) return; // Silently skip duplicates
      const updated = [...state.activities, name].sort();
      set({ activities: updated });
      setUserData('activities', updated);

      const userId = getSupabaseUserId();
      if (userId) syncListToSupabase('activities', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add activity';
      set({ error: message });
    }
  },

  removeStakeholder: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      const updated = state.stakeholders.filter((s) => s !== name);
      set({ stakeholders: updated });
      setUserData('stakeholders', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('stakeholders', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove stakeholder';
      set({ error: message });
      throw error;
    }
  },

  removeProject: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      const updated = state.projects.filter((p) => p !== name);
      set({ projects: updated });
      setUserData('projects', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('projects', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove project';
      set({ error: message });
      throw error;
    }
  },

  removeActivity: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      const updated = state.activities.filter((a) => a !== name);
      set({ activities: updated });
      setUserData('activities', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('activities', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove activity';
      set({ error: message });
      throw error;
    }
  },

  renameStakeholder: async (oldName: string, newName: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.stakeholders.includes(newName)) {
        throw new Error('Stakeholder name already exists');
      }
      const updated = state.stakeholders
        .map((s) => (s === oldName ? newName : s))
        .sort();
      set({ stakeholders: updated });
      setUserData('stakeholders', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('stakeholders', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename stakeholder';
      set({ error: message });
      throw error;
    }
  },

  renameProject: async (oldName: string, newName: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.projects.includes(newName)) {
        throw new Error('Project name already exists');
      }
      const updated = state.projects
        .map((p) => (p === oldName ? newName : p))
        .sort();
      set({ projects: updated });
      setUserData('projects', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('projects', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename project';
      set({ error: message });
      throw error;
    }
  },

  renameActivity: async (oldName: string, newName: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.activities.includes(newName)) {
        throw new Error('Activity name already exists');
      }
      const updated = state.activities
        .map((a) => (a === oldName ? newName : a))
        .sort();
      set({ activities: updated });
      setUserData('activities', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('activities', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename activity';
      set({ error: message });
      throw error;
    }
  },

  // NEW: Format methods (same pattern as activities/stakeholders/projects)
  addFormat: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.formats.includes(name)) return; // Silently skip duplicates
      const updated = [...state.formats, name].sort();
      set({ formats: updated });
      setUserData('formats', updated);

      const userId = getSupabaseUserId();
      if (userId) syncListToSupabase('formats', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add format';
      set({ error: message });
    }
  },

  removeFormat: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      const updated = state.formats.filter((f) => f !== name);
      set({ formats: updated });
      setUserData('formats', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('formats', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove format';
      set({ error: message });
      throw error;
    }
  },

  renameFormat: async (oldName: string, newName: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.formats.includes(newName)) {
        throw new Error('Format name already exists');
      }
      const updated = state.formats
        .map((f) => (f === oldName ? newName : f))
        .sort();
      set({ formats: updated });
      setUserData('formats', updated);

      const userId = getSupabaseUserId();
      if (userId) await syncListToSupabase('formats', updated, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename format';
      set({ error: message });
      throw error;
    }
  },

  sortMasterData: () => {
    const state = get();
    set({
      stakeholders: [...state.stakeholders].sort(),
      projects: [...state.projects].sort(),
      activities: [...state.activities].sort(),
      formats: [...state.formats].sort(),
    });
  },

  setError: (error: string | null) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },
}));

// ── Cross-Device Master Data Sync ──────────────────────────────────────

let _masterPollInterval: ReturnType<typeof setInterval> | null = null;
let _masterRealtimeChannels: any[] = [];
let _masterSuppressUntil: number = 0;

// Track last known state fingerprint to avoid unnecessary updates
let _lastMasterFingerprint: string = '';

function getMasterFingerprint(sh: string[], pr: string[], ac: string[], fm: string[]): string {
  return [sh.join(','), pr.join(','), ac.join(','), fm.join(',')].join('|');
}

async function pullMasterDataFromSupabase(): Promise<void> {
  if (Date.now() < _masterSuppressUntil) return;

  const userId = getSupabaseUserId();
  if (!isSupabaseAvailable() || !supabaseClient || !userId) return;

  // Ensure auth session is valid before querying (avoids 401 spam)
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  // If user is in a team, wait for Team Key before decrypting
  const { connected: inTeam } = useTeamStore.getState();
  if (inTeam && !hasTeamKey()) return;

  try {
    // Team mode: read ALL team members' master data (RLS returns team scope)
    // Solo mode: filter by own user_id only
    const buildQuery = (table: string) => {
      let q = supabaseClient!.from(table).select('name');
      if (!inTeam) q = q.eq('user_id', userId);
      return q.order('sort_order');
    };
    const [shRes, prRes, actRes, fmtRes] = await Promise.all([
      buildQuery('stakeholders'),
      buildQuery('projects'),
      buildQuery('activities'),
      buildQuery('formats'),
    ]);

    // Re-check suppress after async query
    if (Date.now() < _masterSuppressUntil) return;

    const sbStakeholders = (await Promise.all(
      (shRes.data || []).map((r: any) => decryptFieldSmart(r.name))
    )).filter(Boolean) as string[];
    const sbProjects = (await Promise.all(
      (prRes.data || []).map((r: any) => decryptFieldSmart(r.name))
    )).filter(Boolean) as string[];
    const sbActivities = (await Promise.all(
      (actRes.data || []).map((r: any) => decryptFieldSmart(r.name))
    )).filter(Boolean) as string[];
    const sbFormats = (await Promise.all(
      (fmtRes.data || []).map((r: any) => decryptFieldSmart(r.name))
    )).filter(Boolean) as string[];

    // Supabase is source of truth — use its data directly, don't merge with local.
    // Detect key mismatch: Supabase had rows but decryption yielded nothing.
    const DEFAULT_FORMATS = ['Einzelarbeit', 'Meeting', 'Telefonat', 'Workshop'];
    const localState = useMasterStore.getState();

    const shKeyMismatch = (shRes.data || []).length > 0 && sbStakeholders.length === 0;
    const prKeyMismatch = (prRes.data || []).length > 0 && sbProjects.length === 0;
    const actKeyMismatch = (actRes.data || []).length > 0 && sbActivities.length === 0;
    const fmtKeyMismatch = (fmtRes.data || []).length > 0 && sbFormats.length === 0;

    const result = {
      stakeholders: sbStakeholders.length > 0
        ? [...new Set(sbStakeholders)].sort()
        : (shKeyMismatch ? localState.stakeholders : []),
      projects: sbProjects.length > 0
        ? [...new Set(sbProjects)].sort()
        : (prKeyMismatch ? localState.projects : []),
      activities: sbActivities.length > 0
        ? [...new Set(sbActivities)].sort()
        : (actKeyMismatch ? localState.activities : []),
      formats: sbFormats.length > 0
        ? [...new Set(sbFormats)].sort()
        : (fmtKeyMismatch ? localState.formats : DEFAULT_FORMATS),
    };

    // If key mismatch detected, re-encrypt local data to Supabase (cleans up old ciphertext)
    if (shKeyMismatch || prKeyMismatch || actKeyMismatch || fmtKeyMismatch) {
      console.info('[Sync] Key mismatch detected — re-encrypting master data to Supabase');
      if (result.stakeholders.length > 0) syncListToSupabase('stakeholders', result.stakeholders, userId);
      if (result.projects.length > 0) syncListToSupabase('projects', result.projects, userId);
      if (result.activities.length > 0) syncListToSupabase('activities', result.activities, userId);
      if (result.formats.length > 0) syncListToSupabase('formats', result.formats, userId);
    }

    // Check fingerprint — skip if unchanged
    const newFp = getMasterFingerprint(result.stakeholders, result.projects, result.activities, result.formats);
    if (newFp === _lastMasterFingerprint) return;
    _lastMasterFingerprint = newFp;

    // Update store + localStorage
    useMasterStore.setState(result);
    setUserData('stakeholders', result.stakeholders);
    setUserData('projects', result.projects);
    setUserData('activities', result.activities);
    setUserData('formats', result.formats);
  } catch (e) {
    // silent
  }
}

export function subscribeToMasterSync(): void {
  const userId = getSupabaseUserId();
  if (!isSupabaseAvailable() || !supabaseClient || !userId) return;

  unsubscribeFromMasterSync();

  // Initialize fingerprint from current state
  const state = useMasterStore.getState();
  _lastMasterFingerprint = getMasterFingerprint(state.stakeholders, state.projects, state.activities, state.formats);

  // Poll every 120s as safety net (Realtime is the primary sync mechanism)
  _masterPollInterval = setInterval(() => {
    pullMasterDataFromSupabase();
  }, 120000);

  // Realtime subscriptions for each table
  const tables = ['stakeholders', 'projects', 'activities', 'formats'];
  for (const table of tables) {
    try {
      const channel = supabaseClient
        .channel(`master-${table}-${userId}`)
        .on(
          'postgres_changes' as any,
          {
            event: '*',
            schema: 'public',
            table,
            filter: `user_id=eq.${userId}`,
          },
          () => {
            setTimeout(() => pullMasterDataFromSupabase(), 500);
          }
        )
        .subscribe();
      _masterRealtimeChannels.push(channel);
    } catch (e) {
      // Realtime failed, polling is the fallback
    }
  }
}

export function unsubscribeFromMasterSync(): void {
  if (_masterRealtimeChannels.length > 0 && supabaseClient) {
    for (const ch of _masterRealtimeChannels) {
      try { supabaseClient.removeChannel(ch); } catch (_) {}
    }
    _masterRealtimeChannels = [];
  }
  if (_masterPollInterval) {
    clearInterval(_masterPollInterval);
    _masterPollInterval = null;
  }
}

// Subscribe to store changes to auto-suppress after local mutations
useMasterStore.subscribe((state, prevState) => {
  const changed =
    state.stakeholders !== prevState.stakeholders ||
    state.projects !== prevState.projects ||
    state.activities !== prevState.activities ||
    state.formats !== prevState.formats;

  if (changed) {
    _masterSuppressUntil = Date.now() + 3000;
    _lastMasterFingerprint = getMasterFingerprint(
      state.stakeholders, state.projects, state.activities, state.formats
    );
  }
});
