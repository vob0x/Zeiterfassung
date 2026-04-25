/**
 * Utility functions for Zeiterfassung app
 */

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
