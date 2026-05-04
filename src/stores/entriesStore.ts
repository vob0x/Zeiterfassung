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

// Exposed so callers (timer-stop journal) can pre-allocate an entry ID
// before invoking add(). Letting the caller own the ID lets us record a
// "we tried to create entry X" journal row before add() runs any async
// work — and confirm against the same ID after.
export function generateEntryId(): string {
  return generateUUID();
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

/**
 * Pure predicate: does an entry match a BulkFilter?
 * Used by bulkPreview and bulkUpdateMatching. Case-insensitive exact match for
 * dimensions, substring for notiz, inclusive ISO date bounds, and optional
 * member_user_ids restriction (admin scope).
 */
interface MatchableBulkFilter {
  stakeholder?: string;
  projekt?: string;
  taetigkeit?: string;
  format?: string;
  notiz_contains?: string;
  date_from?: string;
  date_to?: string;
  member_user_ids?: string[];
}

function matchesBulkFilter(
  entry: TimeEntry & { _ownerName?: string; _isOwn?: boolean },
  f: MatchableBulkFilter,
  members: { display_name?: string; user_id: string }[]
): boolean {
  if (f.date_from && entry.date < f.date_from) return false;
  if (f.date_to && entry.date > f.date_to) return false;

  if (f.stakeholder) {
    const arr = Array.isArray(entry.stakeholder) ? entry.stakeholder : [entry.stakeholder];
    const want = f.stakeholder.toLowerCase();
    if (!arr.some((s) => (s || '').toLowerCase() === want)) return false;
  }
  if (f.projekt && (entry.projekt || '').toLowerCase() !== f.projekt.toLowerCase()) return false;
  if (f.taetigkeit && (entry.taetigkeit || '').toLowerCase() !== f.taetigkeit.toLowerCase()) return false;
  if (f.format && (entry.format || '').toLowerCase() !== f.format.toLowerCase()) return false;

  if (f.notiz_contains) {
    if (!(entry.notiz || '').toLowerCase().includes(f.notiz_contains.toLowerCase())) return false;
  }

  // Member scope: only entries authored by these user_ids count.
  if (f.member_user_ids && f.member_user_ids.length > 0) {
    if (!entry.user_id) return false;
    if (!f.member_user_ids.includes(entry.user_id)) return false;
    // Defensive: confirm the user_id is in the team's member list (or it's our own).
    if (!members.some((m) => m.user_id === entry.user_id) && !entry._isOwn) {
      return false;
    }
  }
  return true;
}

/**
 * Core "apply changes to a list of matched entries" routine. Shared by
 * bulkUpdateMatching (filter-driven) and bulkUpdateByIds (selection-driven).
 *
 * Re-encrypts only the changed fields once with the active Team Key, then
 * batches Supabase UPDATE…IN(50 ids) calls. Updates local state for any
 * matched own-entry rows, and triggers a team sync for teammate rows so the
 * Team view reflects the change.
 */
async function applyBulkUpdate(
  matches: Array<TimeEntry & { _ownerName?: string; _isOwn?: boolean }>,
  changes: BulkChanges,
  get: () => any,
  set: (partial: any) => void
): Promise<BulkUpdateResult> {
  const result: BulkUpdateResult = { matched: matches.length, updated: 0, failed: 0, errors: [] };

  const changeKeys = Object.keys(changes).filter((k) => changes[k as keyof BulkChanges] !== undefined);
  if (changeKeys.length === 0) {
    throw new Error('Mindestens ein Zielwert muss gesetzt sein');
  }
  if (matches.length === 0) return result;

  if (!hasEncryptionKey()) {
    throw new Error('Verschlüsselungsschlüssel nicht verfügbar');
  }

  const sbAvailable = isSupabaseAvailable() && supabaseClient;
  if (sbAvailable) {
    const sessionOk = await ensureValidSession();
    if (!sessionOk) throw new Error('Sitzung abgelaufen');
  }

  const updatedAt = new Date().toISOString();

  // Build Supabase patch row by re-encrypting only the changed fields.
  // Empty string is a valid clear; undefined means "leave alone".
  const encPatch: Record<string, any> = { updated_at: updatedAt };
  if (changes.stakeholder !== undefined) {
    const arr = changes.stakeholder ? [changes.stakeholder] : [];
    encPatch.stakeholder = arr.length > 0
      ? await encryptFieldForTeam(JSON.stringify(arr))
      : '';
  }
  if (changes.projekt !== undefined) {
    encPatch.projekt = changes.projekt ? await encryptFieldForTeam(changes.projekt) : '';
  }
  if (changes.taetigkeit !== undefined) {
    encPatch.taetigkeit = changes.taetigkeit ? await encryptFieldForTeam(changes.taetigkeit) : '';
  }
  if (changes.format !== undefined) {
    encPatch.format = changes.format ? await encryptFieldForTeam(changes.format) : '';
  }
  if (changes.notiz !== undefined) {
    encPatch.notiz = changes.notiz ? await encryptFieldForTeam(changes.notiz) : '';
  }

  if (sbAvailable && supabaseClient) {
    const ids = matches.map((m) => m.id).filter((id): id is string => !!id);
    for (let i = 0; i < ids.length; i += 50) {
      const batchIds = ids.slice(i, i + 50);
      try {
        const { error } = await supabaseClient
          .from('time_entries')
          .update(encPatch)
          .in('id', batchIds);
        if (error) {
          result.failed += batchIds.length;
          result.errors.push(error.message);
        } else {
          result.updated += batchIds.length;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
        result.failed += batchIds.length;
        result.errors.push(msg);
      }
    }
  }

  // Local state update for own matches
  const ownPatch: Partial<TimeEntry> = { updated_at: updatedAt };
  if (changes.stakeholder !== undefined) {
    ownPatch.stakeholder = changes.stakeholder ? [changes.stakeholder] : [];
  }
  if (changes.projekt !== undefined) ownPatch.projekt = changes.projekt;
  if (changes.taetigkeit !== undefined) ownPatch.taetigkeit = changes.taetigkeit;
  if (changes.format !== undefined) ownPatch.format = changes.format;
  if (changes.notiz !== undefined) ownPatch.notiz = changes.notiz;

  const ownMatchIds = new Set(matches.filter((m) => m._isOwn).map((m) => m.id));
  if (ownMatchIds.size > 0) {
    const updated = get().entries.map((e: TimeEntry) =>
      ownMatchIds.has(e.id) ? { ...e, ...ownPatch } : e
    );
    set({ entries: updated });
    setUserData('entries', updated);
  }

  // Refresh team store so admin sees updated teammate rows in the UI
  if (matches.some((m) => !m._isOwn)) {
    try {
      await useTeamStore.getState().syncTeamData();
    } catch {
      // Non-fatal — UI will reflect changes on next sync tick
    }
  }

  return result;
}

// Track decryption failures across a batch (used by re-encryption migration)
let _batchDecryptFail = 0;

export async function decryptEntryFromSupabase(row: any): Promise<any> {
  const decrypted = { ...row };
  for (const field of ENCRYPTED_ENTRY_FIELDS) {
    if (decrypted[field]) {
      const raw = decrypted[field];
      // Use decryptFieldSmart: tries Team Key first, then personal key
      const decryptedValue = await decryptFieldSmart(raw);
      // Track failures (used by one-time re-encryption migration)
      if (typeof raw === 'string' && raw.startsWith('enc:') && (!decryptedValue || decryptedValue === '')) {
        _batchDecryptFail++;
      }
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

/**
 * Filter criteria for bulk operations. All fields optional. Empty/undefined
 * means "don't filter on this field". Stakeholder/projekt/activity/format
 * compare exact (case-insensitive); notiz uses substring match; date_from/
 * date_to are inclusive ISO date bounds; member_user_ids restricts to a
 * subset of team members (admin only).
 */
export interface BulkFilter {
  stakeholder?: string;
  projekt?: string;
  taetigkeit?: string;
  format?: string;
  notiz_contains?: string;
  date_from?: string; // YYYY-MM-DD
  date_to?: string;
  /** When set, only entries from these team members are matched (admin scope). */
  member_user_ids?: string[];
}

/**
 * Field-level changes for a bulk update. Each field is optional; only set
 * fields are applied. An explicit empty string clears a field — to leave it
 * untouched, omit the key entirely.
 */
export interface BulkChanges {
  stakeholder?: string;       // Single stakeholder; replaces array entirely
  projekt?: string;
  taetigkeit?: string;
  format?: string;
  notiz?: string;
}

export interface BulkUpdateResult {
  matched: number;
  updated: number;
  failed: number;
  errors: string[];
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
  /**
   * Admin-only: dry-run a bulk filter against own + team entries.
   * Returns matched entries WITHOUT modifying anything (used for live preview).
   */
  bulkPreview: (filter: BulkFilter) => Array<TimeEntry & { _ownerName?: string; _isOwn?: boolean }>;
  /**
   * Admin-only: apply changes to all entries matching the filter, across own
   * + team members. Re-encrypts changed fields with the active Team Key,
   * writes via Supabase UPDATE (RLS te_update_admin), then refreshes both
   * the entries store and the team store. Throws if neither store nor team
   * key is available, or if the user is not an admin.
   */
  bulkUpdateMatching: (filter: BulkFilter, changes: BulkChanges) => Promise<BulkUpdateResult>;
  /**
   * Admin-only: apply changes to an explicit list of entry IDs. Used by the
   * BatchEditPanel after the user has hand-picked which of the filter
   * matches to actually modify (via checkboxes). Behavior is otherwise
   * identical to bulkUpdateMatching — same encryption, same RLS path,
   * same store refresh.
   */
  bulkUpdateByIds: (ids: string[], changes: BulkChanges) => Promise<BulkUpdateResult>;
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
          // Decrypt entries from Supabase
          _batchDecryptFail = 0;
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
                deleted_at: decrypted.deleted_at || null,
              };
            })
          );

          // ── One-time re-encryption migration ──
          // Entries encrypted with a lost Team Key need to be restored.
          // Uses a CSV-derived lookup (embedded at build time) to recover
          // plaintext for entries where decryption fails.
          const failedCount = _batchDecryptFail;
          if (failedCount > 0 && hasEncryptionKey()) {
            const REENCRYPT_KEY = 'ze_reencrypt_done_v4';
            const alreadyDone = localStorage.getItem(REENCRYPT_KEY);
            if (!alreadyDone) {
              console.warn(`[ReEncrypt] ${failedCount} fields failed — running CSV-based restore + re-encryption`);

              // CSV-derived lookup: "date|HH:MM|HH:MM" → [stakeholder, projekt, format, taetigkeit, notiz]
              let csvLookup: Record<string, string[]> = {};
              try {
                csvLookup = (await import('@/data/csvRestore.json')).default as any;
                console.warn(`[ReEncrypt] CSV lookup loaded: ${Object.keys(csvLookup).length} entries`);
              } catch (e) {
                console.warn('[ReEncrypt] CSV lookup not available — will clean unrecoverable fields');
              }

              let reEncrypted = 0;
              let restoredFromCSV = 0;
              let cleaned = 0;
              for (let i = 0; i < data.length; i += 50) {
                const batch = data.slice(i, i + 50);
                for (const row of batch) {
                  let needsUpdate = false;
                  const updatedRow: Record<string, any> = { id: row.id };
                  // Build lookup key: date|start_time(HH:MM)|end_time(HH:MM)
                  const st = (row.start_time || '').slice(0, 5);
                  const et = (row.end_time || '').slice(0, 5);
                  const lookupKey = `${row.date}|${st}|${et}`;
                  const csvEntry = csvLookup[lookupKey]; // [stakeholder, projekt, format, taetigkeit, notiz]

                  for (let fi = 0; fi < ENCRYPTED_ENTRY_FIELDS.length; fi++) {
                    const field = ENCRYPTED_ENTRY_FIELDS[fi];
                    const raw = row[field];
                    if (raw && typeof raw === 'string' && raw.startsWith('enc:')) {
                      // Try to decrypt with current keys
                      const decrypted = await decryptFieldSmart(raw);
                      if (decrypted && decrypted !== '') {
                        // Success — re-encrypt with current Team Key
                        updatedRow[field] = await encryptFieldForTeam(
                          field === 'stakeholder' ? decrypted : decrypted
                        );
                        reEncrypted++;
                      } else if (csvEntry) {
                        // Decryption failed — restore from CSV
                        // CSV order: [stakeholder, projekt, format, taetigkeit, notiz]
                        const csvFieldMap: Record<string, number> = {
                          stakeholder: 0, projekt: 1, format: 2, taetigkeit: 3, notiz: 4
                        };
                        const csvIdx = csvFieldMap[field];
                        const csvValue = csvIdx !== undefined ? csvEntry[csvIdx] : '';
                        if (csvValue) {
                          // Stakeholder in CSV may be comma-separated "NDG-Revision, GS-VBS"
                          if (field === 'stakeholder') {
                            const arr = csvValue.split(', ').map((s: string) => s.trim()).filter(Boolean);
                            updatedRow[field] = await encryptFieldForTeam(JSON.stringify(arr));
                          } else {
                            updatedRow[field] = await encryptFieldForTeam(csvValue);
                          }
                          restoredFromCSV++;
                        } else {
                          updatedRow[field] = '';
                          cleaned++;
                        }
                      } else {
                        // No CSV fallback — data is lost
                        updatedRow[field] = '';
                        cleaned++;
                      }
                      needsUpdate = true;
                    }
                  }
                  if (needsUpdate) {
                    updatedRow.updated_at = new Date().toISOString();
                    const { id: rowId, ...fields } = updatedRow;
                    await supabaseClient
                      .from('time_entries')
                      .update(fields)
                      .eq('id', rowId);
                  }
                }
                // Log progress for long batches
                if (data.length > 100) {
                  console.warn(`[ReEncrypt] Progress: ${Math.min(i + 50, data.length)}/${data.length} entries processed`);
                }
              }
              console.warn(`[ReEncrypt] Done: ${reEncrypted} re-encrypted, ${restoredFromCSV} restored from CSV, ${cleaned} unrecoverable`);
              localStorage.setItem(REENCRYPT_KEY, Date.now().toString());

              // Re-fetch after migration to get clean data
              const { data: freshData } = await supabaseClient
                .from('time_entries')
                .select('*')
                .eq('user_id', profile.id)
                .order('date', { ascending: false });
              if (freshData) {
                const freshEntries: TimeEntry[] = await Promise.all(
                  freshData.map(async (row: any) => {
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
                set({ entries: freshEntries });
                setUserData('entries', freshEntries);
                set({ loading: false });
                return; // Skip the normal merge logic below
              }
            }
          }

          // Supabase responded successfully — it is the source of truth
          // for both active rows AND tombstones (rows with deleted_at set).
          // Deduplicate by ID first (in case Supabase has duplicate rows)
          const sbByIdMap = new Map<string, TimeEntry>();
          for (const entry of sbEntries) {
            const existing = sbByIdMap.get(entry.id);
            if (!existing || (entry.updated_at || '') > (existing.updated_at || '')) {
              sbByIdMap.set(entry.id, entry);
            }
          }
          const allSbEntries = Array.from(sbByIdMap.values());

          // Split tombstones from active. Tombstones tell us about
          // deletions that other devices have committed; we drop matching
          // local rows so the deletion propagates here.
          const sbActive = allSbEntries.filter((e) => !e.deleted_at);
          const sbTombstoneIds = new Set(
            allSbEntries.filter((e) => !!e.deleted_at).map((e) => e.id)
          );

          // Local entries that are tombstoned in Supabase: drop them.
          // Local entries pending push (they have a corresponding local
          // tombstone we haven't synced yet): also drop from the active set.
          const sbActiveIds = new Set(sbActive.map((e) => e.id));
          const localOnly = localEntries.filter((e) => {
            if (sbActiveIds.has(e.id)) return false;       // server has active version
            if (sbTombstoneIds.has(e.id)) return false;    // server says deleted
            if (hasLocalTombstone(e.id)) return false;     // we deleted offline, awaiting push
            return true;                                    // genuinely local-only — preserve
          });
          // ALSO filter sbActive by local tombstones — covers the
          // "user deleted offline, push hasn't gone through, server
          // still shows entry as active" race. Without this, the entry
          // would re-appear from sbActive on every pull until the
          // tombstone push finally succeeds.
          const sbActiveFiltered = sbActive.filter((e) => !hasLocalTombstone(e.id));
          const merged = [...sbActiveFiltered, ...localOnly];

          // Tombstones we tracked locally but Supabase already
          // confirmed: clear them from the local set (the deletion was
          // already applied server-side).
          for (const id of sbTombstoneIds) {
            if (hasLocalTombstone(id)) removeLocalTombstone(id);
          }

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

        // ── One-time Team Key re-encryption for existing members ──
        // When a user is in a team but their entries were encrypted before
        // joining (with the Personal Key), teammates can't decrypt them.
        // This runs ONCE per team (flag in localStorage), fire-and-forget.
        const teamState = useTeamStore.getState();
        if (teamState.connected && teamState.team?.id && hasTeamKey() && hasEncryptionKey()) {
          const TEAM_REENCRYPT_KEY = `ze_team_reencrypt_${teamState.team.id}`;
          if (!localStorage.getItem(TEAM_REENCRYPT_KEY)) {
            console.warn('[ReEncrypt] First fetch with Team Key — re-encrypting own data for team visibility');
            // Fire-and-forget: don't block the UI. Set flag only after success.
            reEncryptEntriesForTeam().then(() => {
              localStorage.setItem(TEAM_REENCRYPT_KEY, Date.now().toString());
            }).catch(() => {
              console.warn('[ReEncrypt] Team re-encryption failed — will retry on next fetch');
            });
            // Master data is handled by syncAllMasterData in masterStore
            import('./masterStore').then(({ syncAllMasterData }) => {
              syncAllMasterData().catch(() => {});
            }).catch(() => {});
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

      // Honor a caller-supplied UUID if it looks valid (used by the timer-
      // stop journal so the journal entry and the resulting TimeEntry share
      // an ID — that's what makes the recovery dedup work). Otherwise we
      // generate one ourselves.
      const candidateId = (entry as any).id;
      const usePassedId = typeof candidateId === 'string' && isValidUUID(candidateId);
      const newEntry: TimeEntry = {
        id: usePassedId ? candidateId : generateUUID(),
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

      // Soft-delete on Supabase: set deleted_at instead of removing the
      // row. Other devices learn about the deletion via the next pull
      // (which now includes deleted_at rows and filters them out
      // client-side). This pairs with the soft-merge behaviour to give
      // us both data preservation AND cross-device delete propagation.
      const deletedAt = new Date().toISOString();
      if (isSupabaseAvailable() && supabaseClient) {
        const profile = useAuthStore.getState().profile;
        if (profile?.id && !profile.id.startsWith('local_')) {
          const sessionOk = await ensureValidSession();
          if (sessionOk) {
            const { error: sbErr } = await supabaseClient
              .from('time_entries')
              .update({ deleted_at: deletedAt })
              .eq('id', id);
            if (sbErr) {
              console.error('[Sync] Entry tombstone failed:', sbErr.message, sbErr.details);
              // Track locally so a future sync can retry the tombstone
              addLocalTombstone(id, deletedAt);
            }
          } else {
            addLocalTombstone(id, deletedAt);
          }
        }
      } else {
        // Offline — track tombstone locally; the delete will propagate
        // when we next come online.
        addLocalTombstone(id, deletedAt);
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

  // ──────────────────────────────────────────────────────────────────────
  // Bulk preview & update (admin only)
  // ──────────────────────────────────────────────────────────────────────
  bulkPreview: (filter: BulkFilter) => {
    const ownEntries = get().entries;
    const profile = useAuthStore.getState().profile;
    const ownName = profile?.codename || 'Eigene';
    const ownId = profile?.id;
    // Tag own entries
    const all: Array<TimeEntry & { _ownerName?: string; _isOwn?: boolean }> = ownEntries.map(
      (e) => ({ ...e, _ownerName: ownName, _isOwn: true })
    );
    // Tag teammate entries
    const team = useTeamStore.getState();
    team.memberEntries.forEach((entries, displayName) => {
      const memberObj = team.members.find((m) => m.display_name === displayName);
      // Skip own entries from teammate map (they're already in ownEntries) —
      // identifying via user_id is more reliable than display_name match.
      if (memberObj?.user_id === ownId) return;
      for (const e of entries) {
        all.push({ ...e, _ownerName: displayName, _isOwn: false });
      }
    });

    return all.filter((e) => matchesBulkFilter(e, filter, team.members));
  },

  bulkUpdateMatching: async (filter, changes) => {
    // Filter-driven entry point: derive matches via bulkPreview, then defer
    // to the shared core implementation.
    const matches = get().bulkPreview(filter);
    return applyBulkUpdate(matches, changes, get, set);
  },

  bulkUpdateByIds: async (ids, changes) => {
    // ID-driven entry point: collect the matching entries from own + team
    // stores in the same shape the core expects, then defer.
    const idSet = new Set(ids);
    const ownEntries = get().entries;
    const profile = useAuthStore.getState().profile;
    const ownName = profile?.codename || 'Eigene';
    const ownId = profile?.id;
    const collected: Array<TimeEntry & { _ownerName?: string; _isOwn?: boolean }> = [];
    for (const e of ownEntries) {
      if (idSet.has(e.id)) collected.push({ ...e, _ownerName: ownName, _isOwn: true });
    }
    const team = useTeamStore.getState();
    team.memberEntries.forEach((entries, displayName) => {
      const memberObj = team.members.find((m) => m.display_name === displayName);
      if (memberObj?.user_id === ownId) return; // already in own
      for (const e of entries) {
        if (idSet.has(e.id)) collected.push({ ...e, _ownerName: displayName, _isOwn: false });
      }
    });
    return applyBulkUpdate(collected, changes, get, set);
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

// ── Local tombstones ─────────────────────────────────────────────────
//
// When the user deletes an entry while offline (or when the Supabase
// UPDATE fails), we track the deletion locally so a later sync can push
// the tombstone (deleted_at) to Supabase. This prevents the
// "delete-then-zombie" pattern: without this, a local-only delete would
// be undone on the next pull because Supabase would still show the
// active entry.
//
// Persisted to localStorage so it survives reload / PWA restart.
const TOMBSTONES_KEY = 'ze_local_tombstones';

function _loadTombstones(): Map<string, string> {
  try {
    const stored = localStorage.getItem(TOMBSTONES_KEY);
    if (stored) return new Map(JSON.parse(stored));
  } catch { /* ignore */ }
  return new Map();
}

function _saveTombstones(t: Map<string, string>): void {
  try {
    if (t.size === 0) localStorage.removeItem(TOMBSTONES_KEY);
    else localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(Array.from(t.entries())));
  } catch { /* ignore */ }
}

const _localTombstones = _loadTombstones();

export function addLocalTombstone(id: string, deletedAt: string): void {
  _localTombstones.set(id, deletedAt);
  _saveTombstones(_localTombstones);
}

export function removeLocalTombstone(id: string): void {
  if (_localTombstones.delete(id)) _saveTombstones(_localTombstones);
}

export function hasLocalTombstone(id: string): boolean {
  return _localTombstones.has(id);
}

export async function pullEntriesFromSupabase(): Promise<void> {
  if (Date.now() < _entriesSuppressUntil) return;

  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !hasEncryptionKey() || !profile?.id || profile.id.startsWith('local_')) return;

  // Ensure auth session is valid before querying (avoids 401 spam)
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  // If user is in a team, wait briefly for Team Key before decrypting
  const { connected } = useTeamStore.getState();
  if (connected && !hasTeamKey()) {
    // Wait up to 2s for Team Key (syncTeamData may be restoring it)
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (hasTeamKey()) break;
    }
    // Proceed even without Team Key — decryptFieldSmart falls back to Personal Key
  }

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
          deleted_at: decrypted.deleted_at || null,
        };
      })
    );

    // Deduplicate by ID: if Supabase has multiple rows with same ID
    const sbByIdMap = new Map<string, TimeEntry>();
    for (const entry of sbEntries) {
      const existing = sbByIdMap.get(entry.id);
      if (!existing || (entry.updated_at || '') > (existing.updated_at || '')) {
        sbByIdMap.set(entry.id, entry);
      }
    }
    const allSbEntries = Array.from(sbByIdMap.values());

    // Split tombstones from active rows
    const sbActive = allSbEntries.filter((e) => !e.deleted_at);
    const sbTombstoneIds = new Set(allSbEntries.filter((e) => !!e.deleted_at).map((e) => e.id));
    const sbActiveIds = new Set(sbActive.map((e) => e.id));

    // Clear pending IDs that now appear in Supabase (confirmed synced)
    let pendingChanged = false;
    for (const id of Array.from(_pendingLocalIds)) {
      if (sbActiveIds.has(id) || sbTombstoneIds.has(id)) {
        _pendingLocalIds.delete(id);
        pendingChanged = true;
      }
    }
    if (pendingChanged) _savePendingIds(_pendingLocalIds);

    // Clear local tombstones that Supabase confirmed
    for (const id of sbTombstoneIds) {
      if (hasLocalTombstone(id)) removeLocalTombstone(id);
    }

    // Merge: keep all local entries that are NOT tombstoned anywhere.
    // This combines soft-merge (data preservation) with proper delete
    // propagation via tombstones.
    const localOnly = localEntries.filter((e) => {
      if (sbActiveIds.has(e.id)) return false;     // server has active version
      if (sbTombstoneIds.has(e.id)) return false;  // server says deleted
      if (hasLocalTombstone(e.id)) return false;   // we deleted offline
      return true;                                  // genuinely local-only
    });
    // Also filter sbActive by local tombstones — covers the offline-
    // delete-then-pull race where Supabase still shows the entry as
    // active because the tombstone push hasn't completed yet.
    const sbActiveFiltered = sbActive.filter((e) => !hasLocalTombstone(e.id));

    // For local-only entries, attempt to push them to Supabase
    if (localOnly.length > 0 && hasEncryptionKey()) {
      pushLocalEntriesToSupabase(localOnly, profile.id);
    }

    // Push any unsynced local tombstones (offline deletes) so other
    // devices learn about them on their next pull.
    pushLocalTombstonesToSupabase(profile.id);

    const merged = [...sbActiveFiltered, ...localOnly];

    useEntriesStore.setState({ entries: merged });
    setUserData('entries', merged);
  } catch (e) {
    // silent
  }
}

/**
 * Force-resync ALL local entries to Supabase, regardless of pending state.
 *
 * Recovery tool for the case where local entries failed to upsert (Supabase
 * outage, IO throttling, dropped pending tracking) and aren't visible on
 * other devices. Marks every local entry as pending and triggers a hard
 * push. Returns how many entries it tried to push and how many succeeded.
 */
export async function forceResyncAllLocalEntries(): Promise<{ attempted: number; succeeded: number; error?: string }> {
  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient) {
    return { attempted: 0, succeeded: 0, error: 'Supabase nicht verfügbar' };
  }
  if (!profile?.id || profile.id.startsWith('local_')) {
    return { attempted: 0, succeeded: 0, error: 'Kein Online-Account' };
  }
  if (!hasEncryptionKey()) {
    return { attempted: 0, succeeded: 0, error: 'Verschlüsselungsschlüssel nicht verfügbar' };
  }
  const sessionOk = await ensureValidSession();
  if (!sessionOk) {
    return { attempted: 0, succeeded: 0, error: 'Sitzung abgelaufen' };
  }

  const allEntries = useEntriesStore.getState().entries;
  if (allEntries.length === 0) return { attempted: 0, succeeded: 0 };

  // Mark every entry as pending so the next regular pull also preserves them
  for (const e of allEntries) _pendingLocalIds.add(e.id);
  _savePendingIds(_pendingLocalIds);

  // Encrypt all rows in parallel
  const rows = await Promise.all(
    allEntries.map(async (e) => {
      const row = {
        id: e.id,
        user_id: profile.id,
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

  // Upsert in batches of 50 to keep individual queries small
  let succeeded = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabaseClient
      .from('time_entries')
      .upsert(batch, { onConflict: 'id' });
    if (!error) {
      succeeded += batch.length;
      // Clear pending for the successfully pushed batch
      const idsInBatch = batch.map((r: any) => r.id);
      for (const id of idsInBatch) _pendingLocalIds.delete(id);
    } else {
      console.error('[ForceResync] batch failed:', error.message);
    }
  }
  _savePendingIds(_pendingLocalIds);
  return { attempted: rows.length, succeeded };
}

/**
 * Fetch soft-deleted entries (tombstones) from Supabase, decrypted.
 *
 * Used by the "Versehentliche Löschungen wiederherstellen" admin tool.
 * Returns entries deleted within the last `lookbackDays` so the recovery
 * panel doesn't have to render years of historic deletes. Sorted by
 * deleted_at desc — most recent first.
 */
export async function fetchDeletedEntries(
  lookbackDays: number = 30
): Promise<{ entries: TimeEntry[]; error?: string }> {
  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient) {
    return { entries: [], error: 'Supabase nicht verfügbar' };
  }
  if (!profile?.id || profile.id.startsWith('local_')) {
    return { entries: [], error: 'Kein Online-Account' };
  }
  if (!hasEncryptionKey()) {
    return { entries: [], error: 'Verschlüsselungsschlüssel nicht verfügbar' };
  }
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return { entries: [], error: 'Sitzung abgelaufen' };

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabaseClient
      .from('time_entries')
      .select('*')
      .eq('user_id', profile.id)
      .not('deleted_at', 'is', null)
      .gte('deleted_at', since)
      .order('deleted_at', { ascending: false });
    if (error) return { entries: [], error: error.message };
    if (!data) return { entries: [] };

    const decrypted = await Promise.all(
      data.map(async (row: any) => {
        const d = await decryptEntryFromSupabase(row);
        let stakeholder: string | string[] = d.stakeholder || '';
        if (typeof stakeholder === 'string' && stakeholder) stakeholder = [stakeholder];
        return {
          id: d.id,
          user_id: d.user_id,
          date: typeof d.date === 'string' ? d.date : formatDateISO(new Date(d.date)),
          stakeholder,
          projekt: d.projekt || '',
          taetigkeit: d.taetigkeit || '',
          format: d.format || 'Einzelarbeit',
          start_time: d.start_time || '',
          end_time: d.end_time || '',
          duration_ms: d.duration_ms || 0,
          notiz: d.notiz || '',
          created_at: d.created_at || '',
          updated_at: d.updated_at || '',
          deleted_at: d.deleted_at || null,
        } as TimeEntry;
      })
    );
    return { entries: decrypted };
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : 'Unbekannter Fehler' };
  }
}

/**
 * Restore a tombstoned entry — sets deleted_at = NULL and re-inserts the
 * row into local entries[]. The entry's other fields (start, end,
 * dimensions) are preserved as-is from before the delete.
 *
 * Idempotent on already-restored entries: the UPDATE ... is null filter
 * means a no-op rather than an error. The local-state path checks for
 * an existing row by id before adding so double-clicks don't duplicate.
 */
export async function restoreDeletedEntry(
  entry: TimeEntry
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseAvailable() || !supabaseClient) {
    return { ok: false, error: 'Supabase nicht verfügbar' };
  }
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return { ok: false, error: 'Sitzung abgelaufen' };

  try {
    const { error } = await supabaseClient
      .from('time_entries')
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .eq('id', entry.id);
    if (error) return { ok: false, error: error.message };

    // Reflect in local state so the entry shows up immediately.
    useEntriesStore.setState((s) => {
      if (s.entries.some((e) => e.id === entry.id)) return s;
      const restored: TimeEntry = { ...entry, deleted_at: null };
      const updated = [...s.entries, restored];
      setUserData('entries', updated);
      return { entries: updated };
    });
    // If we had a local tombstone for this id, clear it — the entry
    // is back, the deletion is reverted everywhere.
    if (hasLocalTombstone(entry.id)) removeLocalTombstone(entry.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unbekannter Fehler' };
  }
}

/**
 * Push pending local tombstones to Supabase (retry mechanism for offline
 * deletes). Sets deleted_at on each tombstoned row. Non-blocking.
 */
async function pushLocalTombstonesToSupabase(_userId: string): Promise<void> {
  if (!supabaseClient) return;
  if (_localTombstones.size === 0) return;
  try {
    const ids = Array.from(_localTombstones.keys());
    for (let i = 0; i < ids.length; i += 50) {
      const batchIds = ids.slice(i, i + 50);
      // Use the most recent deleted_at among the batch — they're all
      // user-deletes, the exact timestamp matters less than "is deleted".
      const deletedAt = _localTombstones.get(batchIds[0]) || new Date().toISOString();
      const { error } = await supabaseClient
        .from('time_entries')
        .update({ deleted_at: deletedAt })
        .in('id', batchIds);
      if (!error) {
        for (const id of batchIds) removeLocalTombstone(id);
      }
    }
  } catch {
    // Silent — will retry on next pull cycle
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

/**
 * Re-encrypt ALL of the current user's time_entries with the Team Key.
 *
 * Called once after a user joins a team. Before joining, entries were
 * encrypted with the Personal Key — teammates can't decrypt those.
 * This function reads each raw row, decrypts (Personal Key fallback),
 * re-encrypts with the Team Key, and batch-upserts back to Supabase.
 *
 * Safe to call multiple times — entries already encrypted with the
 * Team Key will decrypt via Team Key on the first try and be
 * re-encrypted with the same key (effectively a no-op with a new IV).
 */
export async function reEncryptEntriesForTeam(): Promise<void> {
  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !profile?.id) return;
  if (!hasEncryptionKey() || !hasTeamKey()) return;

  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  try {
    // 1. Fetch raw (encrypted) rows
    const { data, error } = await supabaseClient
      .from('time_entries')
      .select('*')
      .eq('user_id', profile.id);

    if (error || !data || data.length === 0) return;

    console.warn(`[ReEncrypt] Re-encrypting ${data.length} entries with Team Key…`);

    // 2. Decrypt → re-encrypt in chunks to avoid overwhelming the browser
    const CHUNK = 50;
    let reEncryptedTotal = 0;
    let skippedTotal = 0;
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      const reEncrypted: any[] = [];
      for (const row of chunk) {
        const decrypted: Record<string, any> = { ...row };
        let decryptionFailed = false;

        for (const field of ENCRYPTED_ENTRY_FIELDS) {
          const raw = decrypted[field];
          if (raw && typeof raw === 'string' && raw.startsWith('enc:')) {
            const plaintext = await decryptFieldSmart(raw);
            // If decryption returned empty but the original was a real ciphertext,
            // the key didn't match → skip this entry to avoid data loss!
            if (!plaintext) {
              decryptionFailed = true;
              break;
            }
            decrypted[field] = plaintext;
          }
        }

        if (decryptionFailed) {
          skippedTotal++;
          continue; // Don't touch this entry — preserve original ciphertext
        }

        // Re-encrypt with Team Key (encryptFieldForTeam uses getActiveKey → Team Key)
        reEncrypted.push(await encryptEntryForSupabase(decrypted));
      }

      if (reEncrypted.length === 0) continue;

      // 3. Batch upsert chunk
      const { error: upsertErr } = await supabaseClient
        .from('time_entries')
        .upsert(reEncrypted, { onConflict: 'id' });

      if (upsertErr) {
        console.warn(`[ReEncrypt] Chunk ${i}–${i + chunk.length} failed:`, upsertErr.message);
      } else {
        reEncryptedTotal += reEncrypted.length;
      }
    }

    if (skippedTotal > 0) {
      console.warn(`[ReEncrypt] Skipped ${skippedTotal} entries (decryption failed — preserved original ciphertext)`);
    }

    console.warn(`[ReEncrypt] Re-encryption complete: ${reEncryptedTotal} entries updated, ${skippedTotal} skipped`);
  } catch (e) {
    console.warn('[ReEncrypt] Re-encryption failed:', e);
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
        (payload: any) => {
          setTimeout(() => pullEntriesFromSupabase(), 500);
          // When a new entry is INSERTed from another device, it was likely
          // created by a stopTimer there → also pull timers so any matching
          // running timer on THIS device gets cleared. This acts as a
          // safety net if the running_timers Realtime channel missed the
          // DELETE (e.g. mobile was backgrounded, websocket dropped).
          if (payload?.eventType === 'INSERT') {
            // Dynamic import to avoid circular dependency with timerStore
            import('./timerStore').then(({ pullTimersFromSupabase }) => {
              setTimeout(() => pullTimersFromSupabase(), 600);
            }).catch(() => {});
          }
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
