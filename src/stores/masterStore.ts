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
    // Diff/reconcile pattern (instead of DELETE-ALL + INSERT-ALL):
    //   1. Read what the caller currently OWNS (eq user_id)
    //   2. Decrypt each row's name to a {name → id} map
    //   3. INSERT names in `names` that aren't already in own namespace
    //   4. DELETE rows in own namespace whose name isn't in `names`
    //
    // Why this matters:
    //   - In team mode, `names` is often the team-merged list (state.xxx).
    //     A blanket DELETE-ALL + INSERT-ALL under our user_id duplicated
    //     teammate values into our namespace and ballooned Supabase egress.
    //   - This pattern only ever touches our OWN rows and only writes the
    //     deltas — typical sync transfers a handful of rows, not the whole
    //     list every time.
    //   - Teammate rows are never touched (RLS would block them anyway,
    //     except for admin DELETE which only the targeted helpers use).
    const { data: ownRows, error: selErr } = await supabaseClient
      .from(table)
      .select('id, name')
      .eq('user_id', userId);
    if (selErr) {
      _syncInProgress.set(lockKey, false);
      return;
    }

    const ownByName = new Map<string, string>(); // decrypted name → row id
    for (const row of ownRows || []) {
      const decrypted = await decryptFieldSmart(row.name);
      // Only keep the FIRST occurrence — drop duplicates as a side effect of sync
      if (decrypted && !ownByName.has(decrypted)) {
        ownByName.set(decrypted, row.id);
      }
    }

    const wantedSet = new Set(names);

    // In team mode, also collect names owned by teammates so we don't
    // create cross-namespace duplicates (the source of the historical
    // egress inflation + reappearing-after-delete bug).
    const teammateOwnedNames = new Set<string>();
    const inTeam = useTeamStore.getState().connected;
    if (inTeam) {
      const { data: allRows, error: allErr } = await supabaseClient
        .from(table)
        .select('user_id, name');
      if (!allErr && allRows) {
        for (const row of allRows as any[]) {
          if (row.user_id === userId) continue;
          const decrypted = await decryptFieldSmart(row.name);
          if (decrypted) teammateOwnedNames.add(decrypted);
        }
      }
    }

    // Rows to add: names we want but don't already own AND that no teammate owns.
    // Skipping teammate-owned names is safe because the merged read already
    // surfaces them in everyone's UI — there's no point in inserting a copy.
    const toInsert = names
      .map((name, idx) => ({ name, idx }))
      .filter(({ name }) => !ownByName.has(name) && !teammateOwnedNames.has(name));

    // Rows to delete: own rows whose name we no longer want, plus duplicate
    // own rows for the same name (we dedupe to one canonical row).
    const toDeleteIds: string[] = [];
    const seen = new Set<string>();
    for (const row of ownRows || []) {
      const decrypted = await decryptFieldSmart(row.name);
      if (!decrypted) {
        toDeleteIds.push(row.id); // Unrecoverable cipher — drop it
        continue;
      }
      if (!wantedSet.has(decrypted)) {
        toDeleteIds.push(row.id);
        continue;
      }
      if (seen.has(decrypted)) {
        toDeleteIds.push(row.id); // Duplicate of an already-kept row
        continue;
      }
      seen.add(decrypted);
    }

    if (toDeleteIds.length > 0) {
      const { error: delErr } = await supabaseClient
        .from(table)
        .delete()
        .in('id', toDeleteIds);
      if (delErr) console.warn(`[Sync] ${table} delete failed:`, delErr.message);
    }

    if (toInsert.length > 0) {
      const encryptedRows = await Promise.all(
        toInsert.map(async ({ name, idx }) => ({
          user_id: userId,
          name: await encryptFieldForTeam(name),
          sort_order: idx,
        }))
      );
      const { error } = await supabaseClient
        .from(table)
        .insert(encryptedRows);
      if (error) {
        console.warn(`[Sync] ${table} insert failed:`, error.message);
      }
    }
  } catch {
    // Silent — network or auth issue, will retry on next sync cycle
  } finally {
    _syncInProgress.set(lockKey, false);
  }
}

/**
 * Targeted INSERT of a single master-data row owned by the current user.
 *
 * Why not syncListToSupabase: in team mode `state.xxx` is the merged team
 * list, and pushing it back under one user_id duplicates teammate values
 * into the caller's namespace and inflates egress on every add. This helper
 * inserts exactly one row (current_user, encrypted(name)) only if the
 * caller doesn't already own a matching row.
 */
async function addMasterToSupabase(
  table: 'stakeholders' | 'projects' | 'activities' | 'formats',
  name: string
): Promise<void> {
  if (!isSupabaseAvailable() || !supabaseClient) return;
  if (!hasEncryptionKey()) return;
  const userId = getSupabaseUserId();
  if (!userId) return;

  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  // Skip if a row owned by this user already decrypts to `name`
  const { data: ownRows } = await supabaseClient
    .from(table)
    .select('id, name, sort_order')
    .eq('user_id', userId);
  if (ownRows) {
    for (const row of ownRows) {
      const decrypted = await decryptFieldSmart(row.name);
      if (decrypted === name) return; // already owned, no-op
    }
  }

  const nextSortOrder = ownRows && ownRows.length > 0
    ? Math.max(...ownRows.map((r: any) => r.sort_order ?? 0)) + 1
    : 0;
  const { error } = await supabaseClient
    .from(table)
    .insert({
      user_id: userId,
      name: await encryptFieldForTeam(name),
      sort_order: nextSortOrder,
    });
  if (error) console.warn(`[Sync] ${table} insert failed:`, error.message);
}

/**
 * Targeted RENAME: update every RLS-visible row whose decrypted name equals
 * `oldName` so its encrypted name becomes encrypt(newName). This rewrites
 * the value across all team members in one operation (admin-scoped via
 * the *_update RLS policies). For Mitarbeiter, only own rows update due
 * to base RLS.
 */
async function renameMasterByName(
  table: 'stakeholders' | 'projects' | 'activities' | 'formats',
  oldName: string,
  newName: string
): Promise<number> {
  if (!isSupabaseAvailable() || !supabaseClient) return 0;
  if (!hasEncryptionKey()) return 0;
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return 0;

  const { data, error } = await supabaseClient
    .from(table)
    .select('id, name');
  if (error || !data) return 0;

  const matchIds: string[] = [];
  for (const row of data) {
    const decrypted = await decryptFieldSmart(row.name);
    if (decrypted === oldName) matchIds.push(row.id);
  }
  if (matchIds.length === 0) return 0;

  // Each row needs its own re-encryption (random IV) — issue updates per row
  let updated = 0;
  for (const id of matchIds) {
    const newEnc = await encryptFieldForTeam(newName);
    const { error: upErr } = await supabaseClient
      .from(table)
      .update({ name: newEnc })
      .eq('id', id);
    if (!upErr) updated += 1;
  }
  return updated;
}

/**
 * Targeted delete by name across all RLS-visible rows of a master-data table.
 *
 * Background: master data is per-user, but team RLS lets every member see
 * every other member's rows. Naively deleting "Konzept" from your own
 * namespace leaves teammate copies untouched, and they reappear on the next
 * sync via the merged read. This helper closes that gap by:
 *   1. Selecting all rows the caller can SEE (RLS = own + team in team mode)
 *   2. Decrypting each row's name client-side (random IV per row, so we
 *      can't match server-side)
 *   3. Collecting the IDs of every row whose decrypted name equals `name`
 *   4. Deleting those IDs in a single batch
 *
 * RLS additionally gates DELETE: the base policy blocks teammate rows for
 * non-admins, but the new admin DELETE policies (migration 20260426000000)
 * permit team creators to clean up across the team. Mitarbeiter calling
 * this helper still only delete their own rows — server-side enforced.
 *
 * Returns the number of rows actually deleted.
 */
async function deleteMasterByName(
  table: 'stakeholders' | 'projects' | 'activities' | 'formats',
  name: string
): Promise<number> {
  if (!isSupabaseAvailable() || !supabaseClient) return 0;
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return 0;

  // Pull all rows the caller can see (RLS scope: own + teammates in team mode)
  const { data, error } = await supabaseClient
    .from(table)
    .select('id, name');
  if (error || !data) return 0;

  // Match by decrypted name (case-sensitive — matches the canonical add path)
  const matchIds: string[] = [];
  for (const row of data) {
    const decrypted = await decryptFieldSmart(row.name);
    if (decrypted === name) matchIds.push(row.id);
  }
  if (matchIds.length === 0) return 0;

  const { error: delErr } = await supabaseClient
    .from(table)
    .delete()
    .in('id', matchIds);
  if (delErr) {
    console.warn(`[Sync] ${table} delete-by-name failed:`, delErr.message);
    return 0;
  }
  return matchIds.length;
}

/**
 * One-shot DB cleanup: per master-data table, fetch the caller's OWN rows
 * (eq user_id), decrypt each row's name, group by name, keep the first row
 * per name, delete the rest. Cleans up historical duplicates left over
 * from the old DELETE+INSERT-merged-list syncListToSupabase behaviour.
 *
 * Runs ONLY on rows the caller owns — never touches teammate data
 * (server-side RLS would block it anyway). Datensicher: only TRUE
 * duplicates are removed; if the user genuinely has 100 distinct
 * stakeholders, all 100 are kept.
 *
 * Returns per-table counts so the UI can show "deleted N rows" feedback.
 */
export interface DbCleanupResult {
  stakeholders: { kept: number; removed: number };
  projects: { kept: number; removed: number };
  activities: { kept: number; removed: number };
  formats: { kept: number; removed: number };
}

export async function cleanupOwnNamespaceDuplicates(): Promise<DbCleanupResult> {
  const empty = { kept: 0, removed: 0 };
  const result: DbCleanupResult = {
    stakeholders: { ...empty },
    projects: { ...empty },
    activities: { ...empty },
    formats: { ...empty },
  };
  if (!isSupabaseAvailable() || !supabaseClient) return result;
  const userId = getSupabaseUserId();
  if (!userId) return result;
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return result;

  const tables = ['stakeholders', 'projects', 'activities', 'formats'] as const;
  for (const table of tables) {
    const { data, error } = await supabaseClient
      .from(table)
      .select('id, name')
      .eq('user_id', userId);
    if (error || !data) continue;

    const seen = new Map<string, string>(); // decrypted name → row id (kept)
    const toDelete: string[] = [];
    for (const row of data) {
      const decrypted = await decryptFieldSmart(row.name);
      if (!decrypted) {
        // Unrecoverable cipher — drop it; can't tell what it was anyway
        toDelete.push(row.id);
        continue;
      }
      if (seen.has(decrypted)) {
        toDelete.push(row.id);
      } else {
        seen.set(decrypted, row.id);
      }
    }
    result[table].kept = seen.size;
    if (toDelete.length === 0) continue;

    // Delete in batches of 100 to keep individual queries small
    for (let i = 0; i < toDelete.length; i += 100) {
      const batch = toDelete.slice(i, i + 100);
      const { error: delErr } = await supabaseClient
        .from(table)
        .delete()
        .in('id', batch);
      if (!delErr) result[table].removed += batch.length;
    }
  }
  return result;
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
  // Seed with 'Produktiv' (timer default) plus the four absence categories
  // so they're available out-of-the-box for booking Ferien/Krankheit/etc.
  // The absence-aware KPI math (see lib/absences.ts + utils.ts) recognises
  // them by name and excludes them from work-time totals.
  activities: ['Produktiv', 'Ferien', 'Krankheit', 'Militär/Zivildienst', 'Bezahlte Freistellung'],
  formats: ['Einzelarbeit', 'Meeting', 'Telefonat', 'Workshop'], // NEW: default formats
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      // Always load from localStorage first (source of truth)
      const localStakeholders = getUserData<string[]>('stakeholders', []);
      const localProjects = getUserData<string[]>('projects', []);
      const localActivities = getUserData<string[]>('activities', ['Produktiv', 'Ferien', 'Krankheit', 'Militär/Zivildienst', 'Bezahlte Freistellung']);
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

        // If user is in a team, wait briefly for Team Key (syncTeamData may still be restoring it)
        if (inTeam && !hasTeamKey()) {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (hasTeamKey()) break;
          }
          if (!hasTeamKey()) {
            console.warn('[MasterData] Team Key not available after waiting — decryption may use Personal Key fallback');
          }
        }
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

  // ── add* uses targeted INSERT (one row per add) ──
  // syncListToSupabase pushed the entire merged team list under the caller's
  // user_id, which duplicated teammate values into the caller's namespace
  // and inflated Supabase egress on every add. Targeted insert is precise.
  addStakeholder: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      if (state.stakeholders.includes(name)) return; // Silently skip duplicates
      const updated = [...state.stakeholders, name].sort();
      set({ stakeholders: updated });
      setUserData('stakeholders', updated);
      _suppressMasterPollFor(3000);
      await addMasterToSupabase('stakeholders', name);
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
      _suppressMasterPollFor(3000);
      await addMasterToSupabase('projects', name);
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
      _suppressMasterPollFor(3000);
      await addMasterToSupabase('activities', name);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add activity';
      set({ error: message });
    }
  },

  // ── remove* uses targeted delete-by-name across ALL visible rows ──
  // Why not syncListToSupabase: in team mode, state.xxx is the merged team
  // list; pushing it back under a single user_id duplicates teammate values
  // into the caller's namespace AND leaves teammate copies of the deleted
  // value intact (which then reappear on the next pull). Targeted ID delete
  // is precise and idempotent.
  removeStakeholder: async (name: string) => {
    set({ error: null });
    try {
      const state = get();
      const updated = state.stakeholders.filter((s) => s !== name);
      set({ stakeholders: updated });
      setUserData('stakeholders', updated);
      _suppressMasterPollFor(5000);
      await deleteMasterByName('stakeholders', name);
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
      _suppressMasterPollFor(5000);
      await deleteMasterByName('projects', name);
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
      _suppressMasterPollFor(5000);
      await deleteMasterByName('activities', name);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove activity';
      set({ error: message });
      throw error;
    }
  },

  // ── rename* uses targeted UPDATE on rows whose decrypted name matches ──
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
      _suppressMasterPollFor(3000);
      await renameMasterByName('stakeholders', oldName, newName);
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
      _suppressMasterPollFor(3000);
      await renameMasterByName('projects', oldName, newName);
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
      _suppressMasterPollFor(3000);
      await renameMasterByName('activities', oldName, newName);
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
      _suppressMasterPollFor(3000);
      await addMasterToSupabase('formats', name);
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
      _suppressMasterPollFor(5000);
      await deleteMasterByName('formats', name);
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
      _suppressMasterPollFor(3000);
      await renameMasterByName('formats', oldName, newName);
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

/**
 * Pause polling/realtime pulls for the next `ms` milliseconds.
 * Called after local mutations (delete-by-name etc.) so that an in-flight
 * pull doesn't read a stale "before delete" snapshot and resurrect the row
 * in the local state. The realtime DELETE event itself will trigger the
 * next reliable pull after the suppression window ends.
 */
function _suppressMasterPollFor(ms: number): void {
  _masterSuppressUntil = Date.now() + ms;
}

// Track last known state fingerprint to avoid unnecessary updates
let _lastMasterFingerprint: string = '';

function getMasterFingerprint(sh: string[], pr: string[], ac: string[], fm: string[]): string {
  return [sh.join(','), pr.join(','), ac.join(','), fm.join(',')].join('|');
}

export async function pullMasterDataFromSupabase(): Promise<void> {
  if (Date.now() < _masterSuppressUntil) return;

  const userId = getSupabaseUserId();
  if (!isSupabaseAvailable() || !supabaseClient || !userId) return;

  // Ensure auth session is valid before querying (avoids 401 spam)
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  // If user is in a team, wait briefly for Team Key before decrypting
  const { connected: inTeam } = useTeamStore.getState();
  if (inTeam && !hasTeamKey()) {
    // Wait up to 2s for Team Key (syncTeamData may be restoring it)
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (hasTeamKey()) break;
    }
    // Proceed even without Team Key — decryptFieldSmart falls back to Personal Key
  }

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

  // Poll every 5min — master data changes infrequently, the previous
  // 2-min cycle was burning Disk-IO unnecessarily. Realtime channels
  // were also disabled below (they ran 4 WAL listeners per user even
  // when nobody was editing master data). Polling alone is enough for
  // Stakeholder/Projekt/Tätigkeit/Format which barely change once
  // configured.
  _masterPollInterval = setInterval(() => {
    pullMasterDataFromSupabase();
  }, 300_000);

  // Realtime intentionally NOT subscribed for master data — saves four
  // channels per user × WAL-read pressure. If a teammate adds a new
  // Stakeholder, it shows up within the 5-min poll cycle, which is
  // perfectly fine for this domain.
  // To re-enable later, restore the loop below with the previous logic.
  /* (legacy realtime block intentionally removed — see comment above)
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
  */
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
