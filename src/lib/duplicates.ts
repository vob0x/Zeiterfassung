/**
 * Near-duplicate detection for TimeEntry rows.
 *
 * The exact-match fingerprint dedup we use elsewhere (date + start_time +
 * end_time + dimensions) does not catch entries that differ by a minute
 * or two on either boundary — exactly the failure mode produced by the
 * pre-debounce double-click-on-Stop bug, where two stops on the same
 * slot fired with `now` instants slightly apart and produced rows like
 * 08:10–09:15 and 08:10–09:16 with the same dimensions.
 *
 * A near-duplicate is defined here as: same date, same canonical
 * dimension set (stakeholder sorted, projekt, taetigkeit, format), AND
 * overlapping time intervals. Overlap is the right relation rather than
 * "boundaries within ±N minutes" — two genuine back-to-back tasks at
 * 09:00–09:30 and 09:30–10:00 don't overlap and shouldn't be flagged.
 */

import type { TimeEntry } from '@/types';

export interface DuplicateGroup {
  /** Recommended entry to keep — the longest, ties broken by latest
   *  updated_at, then by id (stable). */
  keeper: TimeEntry;
  /** Other entries in the cluster, candidates for deletion. */
  duplicates: TimeEntry[];
}

/** Canonicalize stakeholder so [A,B] and [B,A] hash identically. */
function canonicalStakeholder(sh: string | string[] | undefined): string {
  if (!sh) return '';
  if (Array.isArray(sh)) return [...sh].sort().join('|');
  return String(sh);
}

/**
 * The grouping key. Anything sharing this key is allowed to be compared
 * for overlap. Different keys → different groups, never compared.
 *
 * Notiz is part of the key on purpose: the user uses the notiz field to
 * distinguish parallel work items that share dimensions otherwise (two
 * media inquiries to Medien/Medienanfragen happening simultaneously,
 * one labelled "srf mengele", the other "bloomberg mengele"). Treating
 * those as duplicates flooded the cleanup panel with false positives.
 * Empty-vs-empty notiz still groups (the original bug case — two
 * stop-clicks producing two near-identical noteless entries — is
 * exactly when the notiz field is empty on both sides).
 */
function dimensionKey(e: TimeEntry): string {
  return [
    e.date || '',
    canonicalStakeholder(e.stakeholder),
    e.projekt || '',
    e.taetigkeit || '',
    e.format || '',
    (e.notiz || '').trim(),
  ].join('::');
}

/** Convert "HH:MM" to minutes-of-day. Returns null on malformed input. */
function timeToMin(t: string | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Two entries overlap iff their time intervals share any minute. We treat
 * end as exclusive so 09:00–10:00 and 10:00–11:00 do NOT overlap. End <
 * start (overnight wrap) is normalized by adding 24h to end.
 */
function intervalsOverlap(a: TimeEntry, b: TimeEntry): boolean {
  const aStart = timeToMin(a.start_time);
  let aEnd = timeToMin(a.end_time);
  const bStart = timeToMin(b.start_time);
  let bEnd = timeToMin(b.end_time);
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  if (aEnd < aStart) aEnd += 24 * 60;
  if (bEnd < bStart) bEnd += 24 * 60;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Effective duration in ms — prefer the stored `duration_ms`, fall back
 * to computing it from start/end. Used to pick the longest "keeper".
 */
function effectiveDurationMs(e: TimeEntry): number {
  if (e.duration_ms && e.duration_ms > 0) return e.duration_ms;
  const s = timeToMin(e.start_time);
  let en = timeToMin(e.end_time);
  if (s == null || en == null) return 0;
  if (en < s) en += 24 * 60;
  return (en - s) * 60_000;
}

/**
 * Within a dimension bucket, return all PAIRS of entries that overlap
 * directly. No transitive clustering — three entries A-B-C where A∩B
 * and B∩C overlap but A∩C don't would have given a 3-element cluster
 * under union-find, suggesting all three are duplicates of each other.
 * In reality A and C may be entirely legitimate separate sessions and
 * only B is the suspect duplicate. The pair-only output makes that
 * clear: emit (A,B) and (B,C) separately, let the user judge each
 * relationship on its own merits.
 */
function findOverlappingPairs(entries: TimeEntry[]): [TimeEntry, TimeEntry][] {
  const pairs: [TimeEntry, TimeEntry][] = [];
  const n = entries.length;
  if (n < 2) return pairs;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (intervalsOverlap(entries[i], entries[j])) {
        pairs.push([entries[i], entries[j]]);
      }
    }
  }
  return pairs;
}

/**
 * Pick the SUGGESTED keeper from a pair. The user can override in the UI.
 * Strategy:
 *   1. Longest effective duration wins (the longer entry is more likely
 *      to be the "complete" capture; the shorter is the truncated dupe).
 *   2. Tie-breaker: latest updated_at (more recent edits = user intent).
 *   3. Final tie-breaker: id (stable).
 */
function pickKeeper(pair: [TimeEntry, TimeEntry]): { keeper: TimeEntry; duplicates: TimeEntry[] } {
  const [a, b] = pair;
  const da = effectiveDurationMs(a);
  const db = effectiveDurationMs(b);
  let keeper: TimeEntry;
  let other: TimeEntry;
  if (da !== db) {
    keeper = da > db ? a : b;
    other = da > db ? b : a;
  } else {
    const ua = a.updated_at || '';
    const ub = b.updated_at || '';
    if (ua !== ub) {
      keeper = ua > ub ? a : b;
      other = ua > ub ? b : a;
    } else {
      keeper = a.id <= b.id ? a : b;
      other = a.id <= b.id ? b : a;
    }
  }
  return { keeper, duplicates: [other] };
}

/**
 * Top-level: scan all entries, group by dimensions, find overlapping
 * clusters within each group, return the deletion plan.
 *
 * Soft-deleted entries (deleted_at !== null) are skipped — they're
 * already on their way out. Absence entries (Ferien etc.) are also
 * skipped: an 8-hour Ferien entry that happens to overlap a real work
 * entry is a data-entry issue but not a "duplicate" in the sense this
 * tool is meant to clean up.
 */
export function findNearDuplicateGroups(entries: TimeEntry[]): DuplicateGroup[] {
  const active = entries.filter((e) => !e.deleted_at);

  // Bucket by dimension key
  const byDims = new Map<string, TimeEntry[]>();
  for (const e of active) {
    const k = dimensionKey(e);
    const list = byDims.get(k);
    if (list) list.push(e);
    else byDims.set(k, [e]);
  }

  const groups: DuplicateGroup[] = [];
  byDims.forEach((bucket) => {
    if (bucket.length < 2) return;
    const pairs = findOverlappingPairs(bucket);
    for (const pair of pairs) {
      groups.push(pickKeeper(pair));
    }
  });

  // Stable order: by date desc, then by start_time asc — matches typical
  // entry-list reading order.
  groups.sort((a, b) => {
    const da = a.keeper.date || '';
    const db = b.keeper.date || '';
    if (db !== da) return db.localeCompare(da);
    return (a.keeper.start_time || '').localeCompare(b.keeper.start_time || '');
  });

  return groups;
}
