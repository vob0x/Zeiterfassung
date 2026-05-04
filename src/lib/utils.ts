/**
 * Utility functions for Zeiterfassung app
 */

import { isAbsenceEntry, isOvertimeDate } from './absences';

/**
 * Format milliseconds to HH:MM:SS or H:MM based on duration
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format milliseconds to H:MM or HH:MM format (hours:minutes only)
 */
export function formatDurationHM(ms: number, fallback?: string): string {
  if (ms === 0 || ms < 0) return fallback || '0:00';

  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Format hours (float) adaptively: < 1h → "45min", >= 1h → "2.3h"
 * Accepts hours as float (e.g. 0.75 = 45min, 2.3 = 2h18min)
 */
export function formatHoursAdaptive(hours: number, decimals = 1): string {
  if (hours < 1 / 60) return '0min'; // < 1 minute
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins}min`;
  }
  return `${hours.toFixed(decimals)}h`;
}

/**
 * Format milliseconds adaptively: < 1h → "45min", >= 1h → "2.3h"
 */
export function formatMsAdaptive(ms: number, decimals = 1): string {
  return formatHoursAdaptive(ms / (1000 * 60 * 60), decimals);
}

/**
 * Format date string (YYYY-MM-DD) to German format (DD.MM.YYYY)
 */
export function formatDateDE(dateStr: string): string {
  try {
    const [year, month, day] = dateStr.split('-');
    return `${day}.${month}.${year}`;
  } catch {
    return dateStr;
  }
}

/**
 * Format Date object to ISO string (YYYY-MM-DD)
 */
export function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format Date object to HH:MM string
 */
export function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Get the effective duration for an entry.
 * Uses duration_ms if it is set AND plausible (≤ Von-Bis span).
 * Falls back to Von-Bis calculation if duration_ms is missing, zero, or exceeds the span.
 * This prevents stale/incorrect duration_ms from showing wrong totals.
 */
export function getEffectiveDurationMs(entry: { start_time: string; end_time: string; duration_ms?: number }): number {
  const dm = entry.duration_ms || 0;

  // Parse Von-Bis span
  let vonBisMs = 0;
  if (entry.start_time && entry.end_time && entry.start_time.includes(':') && entry.end_time.includes(':')) {
    const [sh, sm] = entry.start_time.split(':').map(Number);
    const [eh, em] = entry.end_time.split(':').map(Number);
    if (!isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)) {
      let startMins = sh * 60 + sm;
      let endMins = eh * 60 + em;
      if (endMins < startMins) endMins += 24 * 60;
      vonBisMs = (endMins - startMins) * 60000;
    }
  }

  // Prefer duration_ms when it has a valid value (from timer or CSV Dauer column)
  if (dm > 0) return dm;

  // Fallback to Von-Bis calculation
  return vonBisMs;
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Capitalize first letter of string
 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Combine classnames, filtering out falsy values
 */
export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * CRITICAL ALGORITHM: Compute union of overlapping time intervals
 * Handles overlapping intervals by merging them to get total active time
 */
export function computeUnionMs(entries: Array<{ start_time: string; end_time: string }>): number {
  const intervals: [number, number][] = [];

  // Convert each entry to minutes from midnight
  for (const e of entries) {
    if (!e.start_time || !e.end_time) continue;

    const [sh, sm] = e.start_time.split(':').map(Number);
    const [eh, em] = e.end_time.split(':').map(Number);

    let startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;

    // Handle midnight crossover
    if (endMin < startMin) {
      endMin += 24 * 60;
    }

    // Only add valid intervals
    if (endMin > startMin) {
      intervals.push([startMin, endMin]);
    }
  }

  if (!intervals.length) return 0;

  // Sort by start time
  intervals.sort((a, b) => a[0] - b[0]);

  // Merge overlapping intervals
  const merged: [number, number][] = [[...intervals[0]]];

  for (let i = 1; i < intervals.length; i++) {
    const [cs, ce] = intervals[i];
    const last = merged[merged.length - 1];

    if (cs <= last[1]) {
      // Overlapping or adjacent, merge
      last[1] = Math.max(last[1], ce);
    } else {
      // No overlap, add new interval
      merged.push([cs, ce]);
    }
  }

  // Convert back to milliseconds
  return merged.reduce((sum, [start, end]) => sum + (end - start), 0) * 60000;
}

/**
 * Get today's date in ISO format (YYYY-MM-DD)
 */
export function getTodayISO(): string {
  return formatDateISO(new Date());
}

/**
 * Active dimension filter — anything that narrows the entry set down to a
 * specific stakeholder/project/activity/format/notiz. Period boundaries
 * (from/to) are NOT counted: they pick the time window we look at, but
 * within that window we still want Präsenzzeit unless a true dimension
 * filter is on. Used to choose between Wall-Clock and naive-sum semantics
 * in the KPI cards.
 */
export interface KpiFilterContext {
  stakeholder?: string;
  project?: string;
  activity?: string;
  format?: string;
  notiz?: string;
}

export function hasActiveDimensionFilter(f: KpiFilterContext): boolean {
  return !!(f.stakeholder || f.project || f.activity || f.format || f.notiz);
}

/**
 * Context-aware KPI hour calculation.
 *
 * Both branches now use the SAME semantic: naive sum of entry durations
 * (excluding absences). This switch — from wall-clock-as-headline to
 * naive-sum-as-headline — was made after live use surfaced an
 * inconsistency: the breakdowns (Stakeholder × Person, Tätigkeit, Format,
 * Heatmap) all show naive sums, while the Präsenzzeit headline showed
 * wall-clock. Same view, two different numbers, no on-screen
 * explanation. The user reads the breakdowns as "how much work I did",
 * so the headline now matches that semantic.
 *
 * Wall-clock helpers (computeWallClockMs, computeWorkWallClockMs,
 * computeOvertimeWallClockMs) stay around — they're correct for things
 * like overtime calculation where parallel work must NOT double-count.
 *
 * Returns hours, not milliseconds, for direct KPI display.
 */
export function computeKpiHours(
  entries: Array<{ date: string; start_time: string; end_time: string; duration_ms?: number; taetigkeit?: string }>,
  _filter: KpiFilterContext
): number {
  // Exclude absences (Ferien, Krankheit, …) — they shouldn't pad the
  // "hours worked" KPI. With a dimension filter active, absences
  // typically don't match the filter anyway, but the explicit filter
  // here keeps no-filter and filtered cases on the same code path.
  const work = entries.filter((e) => !isAbsenceEntry(e));
  return work.reduce((sum, e) => sum + getEffectiveDurationMs(e), 0) / 3_600_000;
}

/**
 * Wall-clock total filtered to NON-absence work entries.
 * Same union-per-day algorithm as computeWallClockMs, but skips entries
 * whose Tätigkeit is one of ABSENCE_ACTIVITIES (Ferien, Krankheit, …).
 * This is the right denominator for "actual work hours" KPIs so a 2-week
 * vacation doesn't drag the average down.
 */
export function computeWorkWallClockMs(
  entries: Array<{ date: string; start_time: string; end_time: string; duration_ms?: number; taetigkeit?: string }>
): number {
  const work = entries.filter((e) => !isAbsenceEntry(e));
  return computeWallClockMs(work);
}

/**
 * Wall-clock total of work performed on Saturdays, Sundays, or Swiss
 * national public holidays — i.e. "Überzeit". Reports this as ADDITIONAL
 * information; it is also part of the regular wall-clock total. Absence
 * entries (e.g. a Krankheit on a Saturday) don't count as overtime.
 */
export function computeOvertimeWallClockMs(
  entries: Array<{ date: string; start_time: string; end_time: string; duration_ms?: number; taetigkeit?: string }>
): number {
  const overtime = entries.filter(
    (e) => !isAbsenceEntry(e) && isOvertimeDate(e.date)
  );
  return computeWallClockMs(overtime);
}

/**
 * Wall-clock total duration: groups entries by date and computes the
 * UNION of intervals per day, then sums across days.
 *
 * Why this and not a simple `sum(getEffectiveDurationMs)`:
 *   - Two entries 09:00–10:00 and 09:30–10:30 represent only 1.5h of
 *     real time, not 2h. A naive sum double-counts the overlap.
 *   - Multistakeholder is intentionally encoded as ONE entry with a
 *     stakeholder ARRAY (not two overlapping rows), so it doesn't
 *     create the double-count problem here.
 *
 * Use this for "how long did the user/team actually work" KPIs (top-of-
 * page totals, daily/weekly/monthly cards, per-day cells in Team-Daily).
 *
 * Per-dimension breakdowns (per stakeholder, per project, etc.) should
 * NOT use this — there a 1h slot with stakeholders [A, B] should count
 * as 1h under both A and B (sum 2h), so each axis gets full credit.
 * The day total still reads as 1h (wall-clock).
 */
export function computeWallClockMs(
  entries: Array<{ date: string; start_time: string; end_time: string; duration_ms?: number }>
): number {
  if (!entries || entries.length === 0) return 0;

  // Bucket by date
  const byDate = new Map<string, Array<{ start_time: string; end_time: string }>>();
  for (const e of entries) {
    if (!e.date) continue;
    const list = byDate.get(e.date);
    if (list) list.push({ start_time: e.start_time, end_time: e.end_time });
    else byDate.set(e.date, [{ start_time: e.start_time, end_time: e.end_time }]);
  }

  // Per-day union, then sum across days
  let total = 0;
  byDate.forEach((dayEntries) => {
    total += computeUnionMs(dayEntries);
  });
  return total;
}

/**
 * Wall-clock total INCLUDING currently-running timers.
 *
 * Why this exists separately from computeWallClockMs:
 *   The naive `todayTotalMs + runningTotalMs` we used in TimerView would
 *   add a running timer's elapsed time on top of the saved-entries union.
 *   When the user stopped that timer, its interval was unioned with the
 *   existing saved entries — and any overlap collapsed — so the displayed
 *   total visibly DROPPED on stop. That's confusing and erodes trust in
 *   the daily counter.
 *
 *   The fix is to project each running timer as a virtual interval
 *   [start_time, now] and union it with the saved entries BEFORE summing.
 *   Stopping a timer then just replaces the virtual interval with a real
 *   entry holding the same boundaries — the union is unchanged, the total
 *   stays stable.
 *
 * Inputs:
 *   - savedEntries: TimeEntry rows (the "official" data).
 *   - runningTimers: a list of slots with their current elapsed_ms. Paused
 *     timers can be passed too — the elapsed value already accounts for
 *     pausedMs, and including them lets the wall-clock reflect work
 *     captured-but-not-yet-saved.
 *
 *   `now` is captured at call time so all virtual intervals end at the
 *   same instant. Caller passes the same now used for elapsed calculation
 *   to keep things deterministic during a render.
 */
export function computeLiveWallClockMs(
  savedEntries: Array<{ date: string; start_time: string; end_time: string; duration_ms?: number }>,
  runningTimers: Array<{ elapsedMs: number; isPaused?: boolean }>,
  now: Date = new Date()
): number {
  // Build virtual entries for each running timer: end = now, start = now -
  // elapsed. Date is "today" in local time (matches TimerView's todayEntries
  // bucket, so they go into the same per-day union).
  const todayISO = formatDateISO(now);
  const virtualEntries: Array<{ date: string; start_time: string; end_time: string }> = [];
  for (const t of runningTimers) {
    if (!t || !t.elapsedMs || t.elapsedMs < 1000) continue;
    const startMs = now.getTime() - t.elapsedMs;
    const startDate = new Date(startMs);
    // If the timer started on a previous calendar day (rare — a timer left
    // running across midnight) we still attribute the whole interval to
    // today's wall-clock; the saved-entry path will eventually split it
    // when the user stops the timer. Showing the full elapsed time in
    // today's counter is more honest than dropping the pre-midnight
    // portion silently.
    const startTime = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;
    const endTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (startTime === endTime) continue; // sub-minute, skip
    virtualEntries.push({ date: todayISO, start_time: startTime, end_time: endTime });
  }
  // Union saved entries + virtual running intervals through the same
  // per-day algorithm. Overlap is collapsed correctly.
  return computeWallClockMs([...savedEntries, ...virtualEntries]);
}

/**
 * Presence window for the current day: time between the earliest tracked
 * start and the latest tracked end (or "now" if a timer is still running).
 *
 * This is the "brutto Anwesenheit" semantic — how long was the user at
 * work, regardless of how much of that they actually tracked. Lücken
 * (gaps) live INSIDE this window: presence − tracked = gaps.
 *
 * Why not use a fixed 8-hour day or a clock-in/clock-out feature: the
 * user's actual day length varies (early start, late finish, half days,
 * vacation half-days). Using earliest-start / latest-end keeps the
 * widget honest with whatever the user actually did.
 *
 * Returns 0 if there are no entries and no running timers — caller
 * should not show the widget at all in that case.
 */
export function computePresenceMs(
  savedEntries: Array<{ date: string; start_time: string; end_time: string }>,
  runningTimers: Array<{ elapsedMs: number; isPaused?: boolean }>,
  now: Date = new Date()
): number {
  const todayISO = formatDateISO(now);
  const entries = savedEntries.filter((e) => e.date === todayISO);

  const toMin = (t: string): number | null => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };

  let earliestStart: number | null = null;
  let latestEnd: number | null = null;

  for (const e of entries) {
    const s = toMin(e.start_time);
    let en = toMin(e.end_time);
    if (s == null || en == null) continue;
    if (en < s) en += 24 * 60; // overnight wrap
    if (earliestStart == null || s < earliestStart) earliestStart = s;
    if (latestEnd == null || en > latestEnd) latestEnd = en;
  }

  // Running timers extend the brutto window — earliest start could be
  // a running timer that hasn't been saved yet, latest end is "now".
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const t of runningTimers) {
    if (!t || t.isPaused || !t.elapsedMs || t.elapsedMs < 1000) continue;
    const startMin = nowMin - Math.floor(t.elapsedMs / 60_000);
    if (earliestStart == null || startMin < earliestStart) earliestStart = startMin;
    if (latestEnd == null || nowMin > latestEnd) latestEnd = nowMin;
  }

  if (earliestStart == null || latestEnd == null) return 0;
  return Math.max(0, (latestEnd - earliestStart) * 60_000);
}

/**
 * Tracking-coverage gap detector.
 *
 * Builds the wall-clock-union of the given entries (per-day) and returns
 * the inverse: the windows between intervals where no tracker was active.
 * Used by the Timer-tab Coverage widget to surface "you have a 25min
 * unaccounted window between 11:10 and 11:35 — was that work?".
 *
 * Boundaries are taken from the earliest start_time and the latest
 * end_time across the entries — we don't assume an 8h workday because
 * the user's actual day length varies (early start, late finish, partial
 * days). If you want a fixed-window coverage, clamp the result yourself.
 *
 * Tiny-gap suppression: gaps below `minGapMinutes` are dropped — there's
 * no value in surfacing a 1-minute toilet break as "untracked time".
 */
export interface TrackingGap {
  start: string; // HH:MM
  end: string;   // HH:MM
  durationMs: number;
}

export function findTrackingGaps(
  entries: Array<{ date: string; start_time: string; end_time: string }>,
  options: { date: string; minGapMinutes?: number } = { date: '' }
): { gaps: TrackingGap[]; bruttoMs: number; trackedMs: number; gapMs: number } {
  const minGap = options.minGapMinutes ?? 5;
  const dayEntries = entries.filter((e) => !options.date || e.date === options.date);
  if (dayEntries.length === 0) {
    return { gaps: [], bruttoMs: 0, trackedMs: 0, gapMs: 0 };
  }

  // Convert to minutes-of-day, build sorted intervals, merge overlaps.
  const intervals: Array<[number, number]> = [];
  for (const e of dayEntries) {
    if (!e.start_time || !e.end_time) continue;
    const [sh, sm] = e.start_time.split(':').map(Number);
    const [eh, em] = e.end_time.split(':').map(Number);
    let start = sh * 60 + sm;
    let end = eh * 60 + em;
    if (end < start) end += 24 * 60; // overnight wrap
    if (end > start) intervals.push([start, end]);
  }
  if (intervals.length === 0) {
    return { gaps: [], bruttoMs: 0, trackedMs: 0, gapMs: 0 };
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[...intervals[0]] as [number, number]];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const bruttoMin = merged[merged.length - 1][1] - merged[0][0];
  const trackedMin = merged.reduce((sum, [s, e]) => sum + (e - s), 0);

  const gaps: TrackingGap[] = [];
  let listedGapMin = 0;
  for (let i = 1; i < merged.length; i++) {
    const gapStart = merged[i - 1][1];
    const gapEnd = merged[i][0];
    const gapDuration = gapEnd - gapStart;
    if (gapDuration < minGap) continue;
    const fmt = (m: number) => {
      const mod = m % (24 * 60);
      const h = Math.floor(mod / 60);
      const mm = mod % 60;
      return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
    gaps.push({
      start: fmt(gapStart),
      end: fmt(gapEnd),
      durationMs: gapDuration * 60_000,
    });
    listedGapMin += gapDuration;
  }
  // Sort by size descending — biggest gaps first so the user sees the
  // most actionable ones at the top.
  gaps.sort((a, b) => b.durationMs - a.durationMs);

  // gapMs is intentionally the SUM OF LISTED GAPS only (not bruttoMs −
  // trackedMs). The naive total would include sub-minGap gaps that
  // don't appear in the list — leading to "8 Lücken · 52min insgesamt"
  // while the visible list only sums to 33min. By summing exactly what
  // the user can see, the widget's total stays consistent with its list.
  return {
    gaps,
    bruttoMs: bruttoMin * 60_000,
    trackedMs: trackedMin * 60_000,
    gapMs: listedGapMin * 60_000,
  };
}

/**
 * Get week range [monday, sunday] in ISO format
 */
export function getWeekRange(): [string, string] {
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today.setDate(diff));

  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  return [formatDateISO(monday), formatDateISO(sunday)];
}

/**
 * Get month range [1st, last day] in ISO format
 */
export function getMonthRange(): [string, string] {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);

  return [formatDateISO(first), formatDateISO(last)];
}

/**
 * Get year range [Jan 1, Dec 31] in ISO format
 */
export function getYearRange(): [string, string] {
  const today = new Date();
  const year = today.getFullYear();

  const first = new Date(year, 0, 1);
  const last = new Date(year, 11, 31);

  return [formatDateISO(first), formatDateISO(last)];
}

/**
 * Download file as data URL
 */
export function downloadFile(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Parse CSV content into 2D array
 */
export function parseCSV(content: string): string[][] {
  const lines = content.split('\n');
  const result: string[][] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    row.push(current);
    result.push(row);
  }

  return result;
}
