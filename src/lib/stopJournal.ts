/**
 * Stop Journal — defense-in-depth for the timer-stop data path.
 *
 * Background: even with the await/error-toast hardening in TimerLane and
 * timerStore, the Stop → addEntry path has happy-path failure modes that
 * leave NO trace: a successful local set + Supabase upsert can still be
 * lost later by a faulty merge, a bad re-decrypt, or a tab reload mid-flight.
 * The pending-IDs set is cleared on first successful upsert, so once that
 * fires there is no record that the stop ever happened.
 *
 * The journal sits BELOW addEntry in the trust stack. Before any async work,
 * record the user's intent ("they pressed Stop on this slot, with these
 * dimensions, this duration"). After the entry is verified to be present
 * in entries[] (or after Supabase confirms), confirm the journal entry —
 * which removes it.
 *
 * On boot, the app inspects the journal for stops that never got confirmed.
 * It dedups against current entries[] (by ID and by fingerprint) so true
 * silent successes don't generate noise. What's left is genuine recovery
 * candidates the user can one-click restore.
 *
 * Storage: user-scoped localStorage, key `stop_journal`. Format is a flat
 * array (small, bounded — typically 0-3 entries at a time, hard cap 50).
 */

import { getUserData, setUserData } from './userStorage';

const KEY = 'stop_journal';
const MAX_ENTRIES = 50;
// Older than this and the entry is considered stale (probably from a session
// the user forgot about); we still surface it but with a clear warning.
const STALE_AFTER_DAYS = 7;
// Younger than this and we don't show in the recovery banner — the entry
// might still be in flight (encryption taking long, Supabase slow). 2 minutes
// gives ample buffer for normal sync paths.
export const RECOVERY_MIN_AGE_MS = 2 * 60 * 1000;

export interface StopJournalEntry {
  /** Journal-internal ID — not the entry's ID. */
  journalId: string;
  /** The entry ID we tried to create. If addEntry succeeded, this should
   *  appear in entries[]. We use this to dedup confirmed stops on recovery. */
  entryId: string;
  /** ISO timestamp of when Stop was pressed. */
  recordedAt: string;
  /** The full payload that was passed to addEntry — enough to recreate the
   *  entry from scratch on recovery. */
  payload: {
    date: string;
    stakeholder: string | string[];
    projekt: string;
    taetigkeit: string;
    format: string;
    start_time: string;
    end_time: string;
    duration_ms: number;
    notiz?: string;
  };
  /** Where the stop came from — useful for diagnostics. */
  source: 'lane-stop' | 'stop-all' | 'timer-store-stop';
}

function loadJournal(): StopJournalEntry[] {
  return getUserData<StopJournalEntry[]>(KEY, []);
}

function saveJournal(entries: StopJournalEntry[]): void {
  setUserData(KEY, entries);
}

function generateJournalId(): string {
  return `sj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Record a stop attempt BEFORE running addEntry. Returns the journalId so
 * the caller can confirm later. Synchronous — never throws (best-effort
 * persistence).
 */
export function recordStopAttempt(args: {
  entryId: string;
  payload: StopJournalEntry['payload'];
  source: StopJournalEntry['source'];
}): string {
  try {
    const entry: StopJournalEntry = {
      journalId: generateJournalId(),
      entryId: args.entryId,
      recordedAt: new Date().toISOString(),
      payload: args.payload,
      source: args.source,
    };
    let journal = loadJournal();
    journal.push(entry);
    // Cap size — drop oldest if we exceed the limit. In practice this should
    // never trigger, but guards against runaway growth if confirm fails for
    // every entry for some reason.
    if (journal.length > MAX_ENTRIES) {
      journal = journal.slice(journal.length - MAX_ENTRIES);
    }
    saveJournal(journal);
    return entry.journalId;
  } catch (e) {
    console.warn('[StopJournal] recordStopAttempt failed:', e);
    // Return a placeholder so callers still have something to pass to
    // confirmStopSucceeded; that call will be a no-op.
    return '';
  }
}

/**
 * Mark a stop attempt as confirmed (entry made it through). Removes the
 * journal entry. Idempotent.
 */
export function confirmStopSucceeded(journalId: string): void {
  if (!journalId) return;
  try {
    const journal = loadJournal();
    const filtered = journal.filter((e) => e.journalId !== journalId);
    if (filtered.length !== journal.length) {
      saveJournal(filtered);
    }
  } catch (e) {
    console.warn('[StopJournal] confirmStopSucceeded failed:', e);
  }
}

/**
 * Manually remove a journal entry — used when the user clicks "Verwerfen"
 * in the recovery banner.
 */
export function removeStopAttempt(journalId: string): void {
  confirmStopSucceeded(journalId); // same logic — drop by id
}

/**
 * Return all open journal entries (older than min-age, younger than stale).
 * Use the dedup helper below to filter out ones that are already represented
 * in entries[].
 */
export function getOpenStopAttempts(): StopJournalEntry[] {
  try {
    const journal = loadJournal();
    const now = Date.now();
    const minAge = RECOVERY_MIN_AGE_MS;
    const maxAge = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    return journal.filter((e) => {
      const age = now - new Date(e.recordedAt).getTime();
      return age >= minAge && age <= maxAge;
    });
  } catch (e) {
    console.warn('[StopJournal] getOpenStopAttempts failed:', e);
    return [];
  }
}

/**
 * Build a content fingerprint to compare a journal entry against an existing
 * entries[] row. Used to detect "the entry was actually saved, the journal
 * just wasn't cleared" — common when the browser is closed mid-flight.
 *
 * Match criteria are forgiving on stakeholder ordering (array → sorted) and
 * on stakeholder type (string vs single-element array).
 */
function fingerprint(args: {
  date: string;
  start_time: string;
  end_time: string;
  stakeholder: string | string[];
  projekt: string;
  taetigkeit: string;
}): string {
  const sh = Array.isArray(args.stakeholder)
    ? [...args.stakeholder].sort().join('|')
    : String(args.stakeholder || '');
  return [
    args.date,
    args.start_time,
    args.end_time,
    sh,
    args.projekt,
    args.taetigkeit,
  ].join('::');
}

/**
 * Filter the open-attempts list to only those NOT represented in
 * currentEntries. An attempt is considered already-saved if either:
 *  (a) the entryId is found verbatim in currentEntries, OR
 *  (b) a fingerprint match exists.
 *
 * Side effect: any attempts that match (a) or (b) are auto-confirmed
 * (removed from the journal) before this function returns. That keeps the
 * journal lean and ensures the banner doesn't reappear next session.
 */
export function getRecoveryCandidates(
  currentEntries: Array<{
    id: string;
    date: string;
    start_time: string;
    end_time: string;
    stakeholder: string | string[];
    projekt: string;
    taetigkeit: string;
  }>
): StopJournalEntry[] {
  const open = getOpenStopAttempts();
  if (open.length === 0) return [];

  const idSet = new Set(currentEntries.map((e) => e.id));
  const fingerprintSet = new Set(currentEntries.map((e) => fingerprint(e)));

  const recoveryNeeded: StopJournalEntry[] = [];
  const autoConfirmed: string[] = [];

  for (const attempt of open) {
    const alreadySavedById = idSet.has(attempt.entryId);
    const alreadySavedByFingerprint = fingerprintSet.has(fingerprint(attempt.payload));
    if (alreadySavedById || alreadySavedByFingerprint) {
      autoConfirmed.push(attempt.journalId);
    } else {
      recoveryNeeded.push(attempt);
    }
  }

  // Auto-confirm in one batched write.
  if (autoConfirmed.length > 0) {
    try {
      const journal = loadJournal();
      const ids = new Set(autoConfirmed);
      saveJournal(journal.filter((e) => !ids.has(e.journalId)));
    } catch (e) {
      console.warn('[StopJournal] auto-confirm batch failed:', e);
    }
  }

  return recoveryNeeded;
}

/**
 * Diagnostic helper — full journal contents (no filtering). For DevTools-
 * style inspection or admin tooling.
 */
export function debugDumpJournal(): StopJournalEntry[] {
  return loadJournal();
}

/**
 * Clear all journal entries — for the rare case where the user wants to
 * dismiss everything.
 */
export function clearJournal(): void {
  try {
    saveJournal([]);
  } catch (e) {
    console.warn('[StopJournal] clearJournal failed:', e);
  }
}
