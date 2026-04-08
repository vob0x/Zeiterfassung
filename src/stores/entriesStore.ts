import { create } from 'zustand';
import { TimeEntry, FilterState } from '@/types';
import { getUserData, setUserData } from '@/lib/userStorage';
import { formatDateISO } from '@/lib/utils';
import { supabaseClient, isSupabaseAvailable, ensureValidSession } from '@/lib/supabase';
import { useAuthStore } from './authStore';
import { hasEncryptionKey, hasTeamKey, encryptFieldForTeam, decryptFieldSmart } from '@/lib/crypto';
import { useTeamStore } from './teamStore';

// Generate a proper UUID v4 (required by Supabase)
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Normalized fingerprint for duplicate detection.
 * Includes: date, start_time, end_time, projekt, taetigkeit, format, stakeholder.
 * Normalizes case and trims whitespace to avoid false negatives.
 */
function entryFingerprint(e: { date: string; start_time: string; end_time: string; projekt: string; taetigkeit: string; format?: string; stakeholder: string | string[] }): string {
  const sh = Array.isArray(e.stakeholder)
    ? e.stakeholder.map(s => s.trim().toLowerCase()).sort().join(',')
    : (e.stakeholder || '').trim().toLowerCase();
  return [
    e.date,
    e.start_time,
    e.end_time,
    (e.projekt || '').trim().toLowerCase(),
    (e.taetigkeit || '').trim().toLowerCase(),
    (e.format || '').trim().toLowerCase(),
    sh,
  ].join('|');
}

// Check if a string is a valid UUID
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Fields to encrypt in time_entries
const ENCRYPTED_ENTRY_FIELDS = ['stakeholder', 'projekt', 'taetigkeit', 'format', 'notiz'] as const;

async function encryptEntryForSupabase(row: Record<string, any>): Promise<Record<string, any>> {
  if (!hasEncryptionKey()) return row;
  const encrypted = { ...row };
  for (const field of ENCRYPTED_ENTRY_FIELDS) {
    const value = encrypted[field];
    // For stakeholder (now an array), serialize before encrypting
    if (field === 'stakeholder' && Array.isArray(value)) {
      encrypted[field] = await encryptFieldForTeam(JSON.stringify(value));
    } else if (typeof value === 'string' && value !== '') {
      // Encrypt non-empty strings
      encrypted[field] = await encryptFieldForTeam(value);
    } else {
      // Explicitly set empty string for cleared fields — ensures old ciphertext
      // is overwritten in Supabase when a field is emptied.
      encrypted[field] = '';
    }
  }
  return encrypted;
}

export async function decryptEntryFromSupabase(row: any): Promise<any> {
  const decrypted = { ...row };
  for (const field of ENCRYPTED_ENTRY_FIELDS) {
    if (decrypted[field]) {
      // Use decryptFieldSmart: tries Team Key first, then personal key
      // This handles entries encrypted with either key
      const decryptedValue = await decryptFieldSmart(decrypted[field]);
      // For stakeholder, parse JSON array if it was serialized
      if (field === 'stakeholder' && decryptedValue && decryptedValue.startsWith('[')) {
        try {
          decrypted[field] = JSON.parse(decryptedValue);
        } catch {
          decrypted[field] = decryptedValue;
        }
      } else {
        decrypted[field] = decryptedValue;
      }
    }
  }
  return decrypted;
}

interface EntriesState {
  entries: TimeEntry[];
  loading: boolean;
  error: string | null;
  filters: FilterState;
  fetch: () => Promise<void>;
  add: (entry: Record<string, any>) => Promise<void>;
  bulkAdd: (entries: Record<string, any>[]) => Promise<void>;
  update: (id: string, updates: Partial<TimeEntry>) => Promise<void>;
  delete: (id: string) => Promise<void>;
  findDuplicates: () => Map<string, TimeEntry[]>;
  removeByIds: (ids: string[]) => Promise<number>;
  removeDuplicates: () => Promise<number>;
  setFilter: (key: keyof FilterState, value: string) => void;
  clearFilters: () => void;
  getFilteredEntries: () => TimeEntry[];
  getFilteredEntriesByDay: (date: string) => TimeEntry[];
  getDayTotal: (date: string) => number;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const useEntriesStore = create<EntriesState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,
  filters: {
    from: '',
    to: '',
    stakeholder: '',
    project: '',
    activity: '',
    format: '', // NEW: format filter
    notiz: '',
  },

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      // Load from localStorage first (immediate)
      const localEntries = getUserData<TimeEntry[]>('entries', []);
      set({ entries: localEntries, loading: false });

      // Then merge with Supabase data (only if encryption key is available for decryption)
      const profile = useAuthStore.getState().profile;
      if (isSupabaseAvailable() && supabaseClient && hasEncryptionKey() && profile?.id && !profile.id.startsWith('local_')) {
        // Ensure auth session is valid (token may have expired after app close on iOS)
        const sessionOk = await ensureValidSession();
        if (!sessionOk) {
          console.warn('[Entries] Session expired, could not refresh — using localStorage');
          return;
        }

        // If user is in a team, wait briefly for Team Key if not yet available
        // (syncTeamData may still be restoring it)
        const { connected: inTeam } = useTeamStore.getState();
        if (inTeam && !hasTeamKey()) {
          // Wait up to 3 seconds for Team Key to become available
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (hasTeamKey()) break;
          }
          if (!hasTeamKey()) {
            console.warn('[Entries] Team Key not available after waiting — proceeding without (fields may not decrypt)');
          }
        }

        const { data, error: sbErr } = await supabaseClient
          .from('time_entries')
          .select('*')
          .eq('user_id', profile.id)
          .order('date', { ascending: false });

        if (sbErr) {
          console.warn('[Entries] Supabase fetch error:', sbErr.message, '— keeping localStorage data');
        }
        if (!sbErr && data) {
          console.info(`[Entries] Supabase returned ${data.length} entries`);
          // Decrypt entries from Supabase
          const sbEntries: TimeEntry[] = await Promise.all(
            data.map(async (row: any) => {
              const decrypted = await decryptEntryFromSupabase(row);
              // Migrate old string stakeholder to array
              let stakeholder: string | string[] = decrypted.stakeholder || '';
              if (typeof stakeholder === 'string' && stakeholder) {
                stakeholder = [stakeholder];
              }
              return {
                id: decrypted.id,
                user_id: decrypted.user_id,
                date: typeof decrypted.date === 'string' ? decrypted.date : formatDateISO(new Date(decrypted.date)),
                stakeholder: stakeholder,
                projekt: decrypted.projekt || '',
                taetigkeit: decrypted.taetigkeit || '',
                format: decrypted.format || 'Einzelarbeit', // NEW: default format
                start_time: decrypted.start_time || '',
                end_time: decrypted.end_time || '',
                duration_ms: decrypted.duration_ms || 0,
                notiz: decrypted.notiz || '',
                created_at: decrypted.created_at || '',
                updated_at: decrypted.updated_at || '',
              };
            })
          );

          // Supabase responded successfully — it is the source of truth.
          // Deduplicate by ID (in case Supabase has duplicate rows)
          const sbByIdMap = new Map<string, TimeEntry>();
          for (const entry of sbEntries) {
            const existing = sbByIdMap.get(entry.id);
            if (!existing || (entry.updated_at || '') > (existing.updated_at || '')) {
              sbByIdMap.set(entry.id, entry);
            }
          }
          const dedupedSbEntries = Array.from(sbByIdMap.values());

          // Only keep local entries that are PENDING push (just created locally,
          // not yet confirmed in Supabase). This prevents stale localStorage
          // entries from being re-pushed after Supabase data was intentionally cleared.
          const sbIds = new Set(dedupedSbEntries.map((e) => e.id));
          const now = Date.now();
          const RECENT_THRESHOLD_MS = 30000; // 30 seconds
          const localOnly = localEntries.filter((e) => {
            if (sbIds.has(e.id)) return false; // Already in Supabase
            // Keep if explicitly tracked as pending push (just created this session)
            if (_pendingLocalIds.has(e.id)) return true;
            // Fallback: keep if created very recently (safety net for race conditions)
            const createdAt = e.created_at ? new Date(e.created_at).getTime() : 0;
            return (now - createdAt) < RECENT_THRESHOLD_MS;
          });
          const merged = [...dedupedSbEntries, ...localOnly];

          set({ entries: merged });
          setUserData('entries', merged);

          // Push genuinely pending local entries to Supabase (fix non-UUID IDs first)
          if (localOnly.length > 0 && hasEncryptionKey()) {
            let needsLocalUpdate = false;
            const fixedEntries = localOnly.map((e) => {
              if (!isValidUUID(e.id)) {
                needsLocalUpdate = true;
                return { ...e, id: generateUUID() };
              }
              return e;
            });

            // If we generated new UUIDs, update local storage
            if (needsLocalUpdate) {
              const oldIdMap = new Map(localOnly.map((old, i) => [old.id, fixedEntries[i].id]));
              const updatedMerged = merged.map((e) => {
                const newId = oldIdMap.get(e.id);
                return newId ? { ...e, id: newId } : e;
              });
              set({ entries: updatedMerged });
              setUserData('entries', updatedMerged);
            }

            // Encrypt before pushing to Supabase
            const rows = await Promise.all(
              fixedEntries.map(async (e) => {
                const row = {
                  id: e.id,
                  user_id: profile.id,
                  date: e.date,
                  stakeholder: e.stakeholder,
                  projekt: e.projekt,
                  format: e.format || 'Einzelarbeit',
                  taetigkeit: e.taetigkeit,
                  start_time: e.start_time,
                  end_time: e.end_time,
                  duration_ms: e.duration_ms,
                  notiz: e.notiz || '',
                  created_at: e.created_at,
                  updated_at: e.updated_at,
                };
                return encryptEntryForSupabase(row);
              })
            );
            const { error: pushErr } = await supabaseClient
              .from('time_entries')
              .upsert(rows, { onConflict: 'id' });
            if (pushErr) {
              console.error('[Sync] Local→Supabase push failed:', pushErr.message, pushErr.details);
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch entries';
      set({ error: message, loading: false });
    }
  },

  add: async (entry) => {
    set({ error: null });
    try {
      const state = get();

      // Calculate duration_ms if not provided
      let duration_ms = (entry as any).duration_ms || 0;
      if (!duration_ms && entry.start_time && entry.end_time) {
        const [sh, sm] = entry.start_time.split(':').map(Number);
        const [eh, em] = entry.end_time.split(':').map(Number);
        let startMins = sh * 60 + sm;
        let endMins = eh * 60 + em;
        if (endMins < startMins) endMins += 24 * 60;
        duration_ms = (endMins - startMins) * 60000;
      }

      // Normalize stakeholder to array for consistency
      let stakeholder: string | string[] = entry.stakeholder || '';
      if (typeof stakeholder === 'string' && stakeholder) {
        stakeholder = [stakeholder];
      } else if (!stakeholder || (Array.isArray(stakeholder) && stakeholder.length === 0)) {
        stakeholder = '';
      }

      const newEntry: TimeEntry = {
        id: generateUUID(),
        user_id: (entry as any).user_id || 'local',
        date: entry.date,
        stakeholder: stakeholder,
        projekt: entry.projekt || (entry as any).project || '',
        taetigkeit: entry.taetigkeit || (entry as any).activity || '',
        format: entry.format || 'Einzelarbeit', // NEW: default format
        start_time: entry.start_time || (entry as any).startTime || '',
        end_time: entry.end_time || (entry as any).endTime || '',
        duration_ms: duration_ms,
        notiz: entry.notiz || '',
        created_at: (entry as any).created_at || new Date().toISOString(),
        updated_at: (entry as any).updated_at || new Date().toISOString(),
      };

      const updated = [...state.entries, newEntry];
      set({ entries: updated });
      setUserData('entries', updated);

      // Track as pending until confirmed in Supabase
      markEntryPending(newEntry.id);

      // Sync to Supabase (non-blocking — local is source of truth, but log errors visibly)
      if (isSupabaseAvailable() && supabaseClient && hasEncryptionKey()) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          const row = await encryptEntryForSupabase({
            id: newEntry.id,
            user_id: profile.id,
            date: newEntry.date,
            stakeholder: newEntry.stakeholder,
            projekt: newEntry.projekt,
            taetigkeit: newEntry.taetigkeit,
            format: newEntry.format,
            start_time: newEntry.start_time,
            end_time: newEntry.end_time,
            duration_ms: newEntry.duration_ms,
            notiz: newEntry.notiz || '',
            created_at: newEntry.created_at,
            updated_at: newEntry.updated_at,
          });
          const { error: sbErr } = await supabaseClient
            .from('time_entries')
            .upsert(row, { onConflict: 'id' });
          if (sbErr) {
            console.error('[Sync] Entry upsert failed:', sbErr.message, sbErr.details);
          } else {
            // Confirmed in Supabase — remove from pending
            _pendingLocalIds.delete(newEntry.id);
            _savePendingIds(_pendingLocalIds);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add entry';
      set({ error: message });
      throw error;
    }
  },

  bulkAdd: async (rawEntries: Record<string, any>[]) => {
    set({ error: null });
    try {
      const state = get();
      const now = new Date().toISOString();

      // Build a fingerprint set from existing entries to detect duplicates
      const existingFingerprints = new Set(state.entries.map((e) => entryFingerprint(e)));
      let skippedCount = 0;

      const newEntries: TimeEntry[] = [];
      for (const entry of rawEntries) {
        let duration_ms = (entry as any).duration_ms || 0;
        if (!duration_ms && entry.start_time && entry.end_time) {
          const [sh, sm] = entry.start_time.split(':').map(Number);
          const [eh, em] = entry.end_time.split(':').map(Number);
          let startMins = sh * 60 + sm;
          let endMins = eh * 60 + em;
          if (endMins < startMins) endMins += 24 * 60;
          duration_ms = (endMins - startMins) * 60000;
        }
        // Normalize stakeholder to array
        let stakeholder: string | string[] = entry.stakeholder || '';
        if (typeof stakeholder === 'string' && stakeholder) {
          stakeholder = [stakeholder];
        } else if (!stakeholder || (Array.isArray(stakeholder) && stakeholder.length === 0)) {
          stakeholder = '';
        }

        const candidate = {
          date: entry.date,
          start_time: entry.start_time || (entry as any).startTime || '',
          end_time: entry.end_time || (entry as any).endTime || '',
          projekt: entry.projekt || (entry as any).project || '',
          taetigkeit: entry.taetigkeit || (entry as any).activity || '',
          format: entry.format || 'Einzelarbeit',
          stakeholder,
        };

        const fp = entryFingerprint(candidate);
        if (existingFingerprints.has(fp)) {
          skippedCount++;
          continue; // Duplicate — skip
        }
        existingFingerprints.add(fp); // Also deduplicate within the import batch

        newEntries.push({
          id: generateUUID(),
          user_id: (entry as any).user_id || 'local',
          date: candidate.date,
          stakeholder: candidate.stakeholder,
          projekt: candidate.projekt,
          taetigkeit: candidate.taetigkeit,
          format: entry.format || 'Einzelarbeit',
          start_time: candidate.start_time,
          end_time: candidate.end_time,
          duration_ms,
          notiz: entry.notiz || '',
          created_at: (entry as any).created_at || now,
          updated_at: (entry as any).updated_at || now,
        });
      }

      if (skippedCount > 0) {
        console.info(`[Import] Skipped ${skippedCount} duplicate entries`);
      }

      const updated = [...state.entries, ...newEntries];
      set({ entries: updated });
      setUserData('entries', updated);

      // Track all new entries as pending
      newEntries.forEach(e => markEntryPending(e.id));

      // Bulk sync to Supabase (encrypted)
      if (isSupabaseAvailable() && supabaseClient && hasEncryptionKey()) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          const rows = await Promise.all(
            newEntries.map(async (e) => {
              const row = {
                id: e.id,
                user_id: profile.id,
                date: e.date,
                stakeholder: e.stakeholder,
                projekt: e.projekt,
                taetigkeit: e.taetigkeit,
                format: e.format,
                start_time: e.start_time,
                end_time: e.end_time,
                duration_ms: e.duration_ms,
                notiz: e.notiz || '',
                created_at: e.created_at,
                updated_at: e.updated_at,
              };
              return encryptEntryForSupabase(row);
            })
          );
          const { error: sbErr } = await supabaseClient
            .from('time_entries')
            .upsert(rows, { onConflict: 'id' });
          if (sbErr) {
            console.error('[Sync] Bulk entry sync failed:', sbErr.message, sbErr.details);
          } else {
            // Confirmed in Supabase — clear from pending
            newEntries.forEach(e => _pendingLocalIds.delete(e.id));
            _savePendingIds(_pendingLocalIds);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to bulk add entries';
      set({ error: message });
      throw error;
    }
  },

  update: async (id, updates) => {
    set({ error: null });
    try {
      const state = get();
      const updatedAt = new Date().toISOString();

      // IMPORTANT: Capture the original updated_at BEFORE applying the local update.
      // This is needed for conflict detection against the Supabase remote version.
      const originalEntry = state.entries.find((e) => e.id === id);
      const localBaseTime = originalEntry?.updated_at
        ? new Date(originalEntry.updated_at).getTime()
        : 0;

      // Recalculate duration_ms when start_time or end_time changed
      if ((updates.start_time || updates.end_time) && !updates.duration_ms) {
        if (originalEntry) {
          const st = updates.start_time || originalEntry.start_time;
          const et = updates.end_time || originalEntry.end_time;
          if (st && et) {
            const [sh, sm] = st.split(':').map(Number);
            const [eh, em] = et.split(':').map(Number);
            let startMins = sh * 60 + sm;
            let endMins = eh * 60 + em;
            if (endMins < startMins) endMins += 24 * 60;
            updates.duration_ms = (endMins - startMins) * 60000;
          }
        }
      }

      const updated = state.entries.map((e) =>
        e.id === id
          ? {
              ...e,
              ...updates,
              updated_at: updatedAt,
            }
          : e
      );
      set({ entries: updated });
      setUserData('entries', updated);

      // Sync to Supabase with conflict detection (non-blocking)
      if (isSupabaseAvailable() && supabaseClient && hasEncryptionKey()) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          // Ensure auth session is valid before any Supabase query
          const sessionOk = await ensureValidSession();
          if (!sessionOk) return;

          const entry = updated.find((e) => e.id === id);
          if (entry) {
            // Conflict detection: check if Supabase has a newer version
            // Uses localBaseTime captured BEFORE the local update was applied
            try {
              const { data: remoteRow, error: conflictErr } = await supabaseClient
                .from('time_entries')
                .select('updated_at')
                .eq('id', id)
                .maybeSingle();

              if (!conflictErr && remoteRow?.updated_at) {
                const remoteTime = new Date(remoteRow.updated_at).getTime();
                if (remoteTime > localBaseTime) {
                  // Remote was updated after our base version — another device edited it
                  console.info(`[Sync] Conflict detected for entry ${id}: remote is newer, pulling remote version`);
                  setTimeout(() => pullEntriesFromSupabase(), 100);
                  return; // Don't push our local changes
                }
              }
            } catch {
              // Conflict check failed — proceed with upsert (best-effort)
            }

            const row = await encryptEntryForSupabase({
              id: entry.id,
              user_id: profile.id,
              date: entry.date,
              stakeholder: entry.stakeholder,
              projekt: entry.projekt,
              taetigkeit: entry.taetigkeit,
              format: entry.format,
              start_time: entry.start_time,
              end_time: entry.end_time,
              duration_ms: entry.duration_ms,
              notiz: entry.notiz || '',
              created_at: entry.created_at,
              updated_at: updatedAt,
            });
            // Use UPDATE (not upsert) to prevent duplicate rows if id has no unique constraint
            const { id: rowId, ...rowWithoutId } = row;
            const { error: sbErr } = await supabaseClient
              .from('time_entries')
              .update(rowWithoutId)
              .eq('id', id);
            if (sbErr) {
              // Row might not exist yet (offline-created) — fall back to upsert
              const { error: upsertErr } = await supabaseClient
                .from('time_entries')
                .upsert(row, { onConflict: 'id' });
              if (upsertErr) {
                console.error('[Sync] Entry update failed:', upsertErr.message, upsertErr.details);
              }
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update entry';
      set({ error: message });
      throw error;
    }
  },

  delete: async (id) => {
    set({ error: null });
    try {
      const state = get();
      const updated = state.entries.filter((e) => e.id !== id);
      set({ entries: updated });
      setUserData('entries', updated);

      // Sync delete to Supabase
      if (isSupabaseAvailable() && supabaseClient) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          const sessionOk = await ensureValidSession();
          if (sessionOk) {
            const { error: sbErr } = await supabaseClient
              .from('time_entries')
              .delete()
              .eq('id', id);
            if (sbErr) {
              console.error('[Sync] Entry delete failed:', sbErr.message, sbErr.details);
            }
          }
        }
      }
      // Also remove from pending set if it was there
      if (_pendingLocalIds.has(id)) {
        _pendingLocalIds.delete(id);
        _savePendingIds(_pendingLocalIds);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete entry';
      set({ error: message });
      throw error;
    }
  },

  /**
   * Find duplicate groups without deleting.
   * Returns Map<fingerprint, TimeEntry[]> where each group has 2+ entries.
   */
  findDuplicates: (): Map<string, TimeEntry[]> => {
    const state = get();
    const groups = new Map<string, TimeEntry[]>();

    for (const entry of state.entries) {
      const fp = entryFingerprint(entry);
      if (!groups.has(fp)) {
        groups.set(fp, []);
      }
      groups.get(fp)!.push(entry);
    }

    // Only return groups with 2+ entries (actual duplicates)
    const dupes = new Map<string, TimeEntry[]>();
    groups.forEach((entries, fp) => {
      if (entries.length > 1) dupes.set(fp, entries);
    });
    return dupes;
  },

  /**
   * Remove specific entries by ID (for manual dedup selection).
   */
  removeByIds: async (ids: string[]) => {
    set({ error: null });
    try {
      if (ids.length === 0) return 0;
      const state = get();
      const idSet = new Set(ids);
      const updated = state.entries.filter((e) => !idSet.has(e.id));
      set({ entries: updated });
      setUserData('entries', updated);

      // Delete from Supabase
      if (isSupabaseAvailable() && supabaseClient) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          const sessionOk = await ensureValidSession();
          if (sessionOk) {
            for (let i = 0; i < ids.length; i += 50) {
              const batch = ids.slice(i, i + 50);
              const { error: batchErr } = await supabaseClient
                .from('time_entries')
                .delete()
                .in('id', batch);
              if (batchErr) {
                console.error('[Sync] Batch delete failed:', batchErr.message);
              }
            }
          }
        }
      }
      // Clean up pending set
      let pendingChanged = false;
      for (const id of ids) {
        if (_pendingLocalIds.has(id)) { _pendingLocalIds.delete(id); pendingChanged = true; }
      }
      if (pendingChanged) _savePendingIds(_pendingLocalIds);
      return ids.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove entries';
      set({ error: message });
      throw error;
    }
  },

  removeDuplicates: async () => {
    set({ error: null });
    try {
      const state = get();
      const seen = new Set<string>();
      const duplicateIds: string[] = [];
      const unique: TimeEntry[] = [];

      for (const entry of state.entries) {
        const fp = entryFingerprint(entry);
        if (seen.has(fp)) {
          duplicateIds.push(entry.id);
        } else {
          seen.add(fp);
          unique.push(entry);
        }
      }

      if (duplicateIds.length === 0) return 0;

      set({ entries: unique });
      setUserData('entries', unique);

      // Delete duplicates from Supabase
      if (isSupabaseAvailable() && supabaseClient) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          const sessionOk = await ensureValidSession();
          if (sessionOk) {
            for (let i = 0; i < duplicateIds.length; i += 50) {
              const batch = duplicateIds.slice(i, i + 50);
              await supabaseClient
                .from('time_entries')
                .delete()
                .in('id', batch);
            }
          }
        }
      }

      console.info(`[Dedup] Removed ${duplicateIds.length} duplicate entries`);
      return duplicateIds.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove duplicates';
      set({ error: message });
      throw error;
    }
  },

  setFilter: (key, value) => {
    set((state) => ({
      filters: {
        ...state.filters,
        [key]: value,
      },
    }));
  },

  clearFilters: () => {
    set({
      filters: {
        from: '',
        to: '',
        stakeholder: '',
        project: '',
        activity: '',
        format: '', // NEW: format filter
        notiz: '',
      },
    });
  },

  getFilteredEntries: () => {
    const state = get();
    return state.entries.filter((entry) => {
      const filters = state.filters;

      // Date range filter
      if (filters.from && entry.date < filters.from) return false;
      if (filters.to && entry.date > filters.to) return false;

      // Stakeholder filter (handle array)
      if (filters.stakeholder) {
        const entryStakeholders = Array.isArray(entry.stakeholder) ? entry.stakeholder : [entry.stakeholder];
        if (!entryStakeholders.includes(filters.stakeholder)) return false;
      }

      // Other dimension filters (case-insensitive, empty means all)
      if (filters.project && entry.projekt !== filters.project) return false;
      if (filters.activity && entry.taetigkeit !== filters.activity) return false;
      if (filters.format && entry.format !== filters.format) return false; // NEW: format filter

      // Text search in notiz
      if (filters.notiz) {
        const searchTerm = filters.notiz.toLowerCase();
        const entryNotiz = (entry.notiz || '').toLowerCase();
        if (!entryNotiz.includes(searchTerm)) return false;
      }

      return true;
    });
  },

  getFilteredEntriesByDay: (date: string) => {
    const state = get();
    return state.entries.filter((e) => e.date === date);
  },

  getDayTotal: (date: string) => {
    const state = get();
    const dayEntries = state.entries.filter((e) => e.date === date);
    return dayEntries.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / (1000 * 60 * 60); // Convert to hours
  },

  setError: (error: string | null) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },
}));

// ── Cross-Device Entries Sync ──────────────────────────────────────────

let _entriesPollInterval: ReturnType<typeof setInterval> | null = null;
let _entriesRealtimeChannel: any = null;
let _entriesSuppressUntil: number = 0;

/**
 * Track IDs of entries that were created locally but not yet confirmed
 * in Supabase. This prevents data loss when entries take longer than
 * 30s to push (e.g. due to network issues). Entries are removed from
 * this set once they appear in a Supabase pull response.
 *
 * Persisted to localStorage so they survive page reload / PWA restart.
 */
const PENDING_IDS_KEY = 'ze_pending_entry_ids';

function _loadPendingIds(): Set<string> {
  try {
    const stored = localStorage.getItem(PENDING_IDS_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* ignore */ }
  return new Set();
}

function _savePendingIds(ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem(PENDING_IDS_KEY);
    } else {
      localStorage.setItem(PENDING_IDS_KEY, JSON.stringify([...ids]));
    }
  } catch { /* ignore */ }
}

const _pendingLocalIds = _loadPendingIds();

/** Mark an entry as pending local push (call after local add/bulkAdd) */
export function markEntryPending(id: string): void {
  _pendingLocalIds.add(id);
  _savePendingIds(_pendingLocalIds);
}

export async function pullEntriesFromSupabase(): Promise<void> {
  if (Date.now() < _entriesSuppressUntil) return;

  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !hasEncryptionKey() || !profile?.id || profile.id.startsWith('local_')) return;

  // Ensure auth session is valid before querying (avoids 401 spam)
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  // If user is in a team, wait for Team Key to be available before decrypting
  // (entries are encrypted with the Team Key when in a team)
  const { connected } = useTeamStore.getState();
  if (connected && !hasTeamKey()) return; // Team Key not yet restored — skip this poll cycle

  try {
    const { data, error: sbErr } = await supabaseClient
      .from('time_entries')
      .select('*')
      .eq('user_id', profile.id)
      .order('date', { ascending: false });

    // Re-check suppress after async query
    if (Date.now() < _entriesSuppressUntil) return;
    if (sbErr || !data) return;

    // Quick check: has the row count or IDs changed?
    const localEntries = useEntriesStore.getState().entries;
    const remoteIds = data.map((r: any) => r.id).sort().join(',');
    const localIds = localEntries.map(e => e.id).sort().join(',');
    const remoteLatest = data.reduce((max: string, r: any) => {
      const t = r.updated_at || '';
      return t > max ? t : max;
    }, '');
    const localLatest = localEntries.reduce((max, e) => {
      const t = e.updated_at || '';
      return t > max ? t : max;
    }, '');

    // Skip if nothing changed
    if (remoteIds === localIds && remoteLatest === localLatest) return;

    // Decrypt and rebuild entries
    const sbEntries: TimeEntry[] = await Promise.all(
      data.map(async (row: any) => {
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

    // Deduplicate by ID: if Supabase has multiple rows with same ID (schema issue),
    // keep only the newest version (by updated_at)
    const sbByIdMap = new Map<string, TimeEntry>();
    for (const entry of sbEntries) {
      const existing = sbByIdMap.get(entry.id);
      if (!existing || (entry.updated_at || '') > (existing.updated_at || '')) {
        sbByIdMap.set(entry.id, entry);
      }
    }
    const dedupedSbEntries = Array.from(sbByIdMap.values());

    // Clear pending IDs that now appear in Supabase (confirmed synced)
    const sbIds = new Set(dedupedSbEntries.map(e => e.id));
    let pendingChanged = false;
    for (const id of Array.from(_pendingLocalIds)) {
      if (sbIds.has(id)) { _pendingLocalIds.delete(id); pendingChanged = true; }
    }
    if (pendingChanged) _savePendingIds(_pendingLocalIds);

    // Merge strategy:
    // 1. Supabase entries are the base (source of truth for synced data)
    // 2. Keep local-only entries if they are PENDING push (tracked explicitly)
    //    OR if they were created very recently (< 30s, fallback safety net)
    // This prevents zombie entries (deleted on another device) while also
    // preventing data loss for entries that haven't been pushed yet.
    const now = Date.now();
    const RECENT_THRESHOLD_MS = 30000; // 30 seconds
    const localOnly = localEntries.filter(e => {
      if (sbIds.has(e.id)) return false; // Already in Supabase
      // Keep if explicitly tracked as pending push
      if (_pendingLocalIds.has(e.id)) return true;
      // Fallback: keep if created very recently (not yet tracked or race condition)
      const createdAt = e.created_at ? new Date(e.created_at).getTime() : 0;
      return (now - createdAt) < RECENT_THRESHOLD_MS;
    });

    // For local-only entries that survived, attempt to push them to Supabase
    if (localOnly.length > 0 && hasEncryptionKey()) {
      pushLocalEntriesToSupabase(localOnly, profile.id);
    }

    const merged = [...dedupedSbEntries, ...localOnly];

    useEntriesStore.setState({ entries: merged });
    setUserData('entries', merged);
  } catch (e) {
    // silent
  }
}

/**
 * Push local-only entries to Supabase (retry mechanism for offline-created entries).
 * Non-blocking — fires and forgets. On success, entries will appear in next pull.
 */
async function pushLocalEntriesToSupabase(entries: TimeEntry[], userId: string): Promise<void> {
  if (!supabaseClient || !hasEncryptionKey()) return;
  try {
    const rows = await Promise.all(
      entries.map(async (e) => {
        const row = {
          id: e.id,
          user_id: userId,
          date: e.date,
          stakeholder: e.stakeholder,
          projekt: e.projekt,
          taetigkeit: e.taetigkeit,
          format: e.format || 'Einzelarbeit',
          start_time: e.start_time,
          end_time: e.end_time,
          duration_ms: e.duration_ms,
          notiz: e.notiz || '',
          created_at: e.created_at,
          updated_at: e.updated_at,
        };
        return encryptEntryForSupabase(row);
      })
    );
    const { error } = await supabaseClient
      .from('time_entries')
      .upsert(rows, { onConflict: 'id' });
    if (error) {
      console.warn('[Sync] Retry push failed:', error.message);
    } else {
      // Successfully pushed — clear from pending set
      entries.forEach(e => _pendingLocalIds.delete(e.id));
      _savePendingIds(_pendingLocalIds);
    }
  } catch {
    // Silent — will retry on next pull cycle
  }
}

export function subscribeToEntriesSync(): void {
  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !profile?.id || profile.id.startsWith('local_')) return;

  unsubscribeFromEntriesSync();

  // Poll every 60s as safety net (Realtime is the primary sync mechanism)
  _entriesPollInterval = setInterval(() => {
    pullEntriesFromSupabase();
  }, 60000);

  // Realtime for faster updates
  try {
    _entriesRealtimeChannel = supabaseClient
      .channel(`entries-${profile.id}`)
      .on(
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'time_entries',
          filter: `user_id=eq.${profile.id}`,
        },
        () => {
          setTimeout(() => pullEntriesFromSupabase(), 500);
        }
      )
      .subscribe();
  } catch (e) {
    // Realtime failed, polling is the fallback
  }
}

export function unsubscribeFromEntriesSync(): void {
  if (_entriesRealtimeChannel && supabaseClient) {
    try { supabaseClient.removeChannel(_entriesRealtimeChannel); } catch (_) {}
    _entriesRealtimeChannel = null;
  }
  if (_entriesPollInterval) {
    clearInterval(_entriesPollInterval);
    _entriesPollInterval = null;
  }
}

// Suppress sync after local mutations (add, update, delete, bulkAdd)
useEntriesStore.subscribe((state, prevState) => {
  if (state.entries !== prevState.entries) {
    _entriesSuppressUntil = Date.now() + 5000;
  }
});
