/**
 * Absence & Overtime Helpers
 * ─────────────────────────────────────────────────────────────────────────
 * Two related concepts that affect KPI calculations across the app:
 *
 *   1. ABSENCE — Ferien, Krankheit, Militär/Zivildienst, Bezahlte Freistellung.
 *      Encoded as Tätigkeit values (no schema change required). Entries
 *      with these activities are excluded from work-time totals, averages,
 *      and the productivity quote, so a 2-week vacation doesn't drag the
 *      Ø/Erfassungstag down. They ARE counted toward absence-day KPIs.
 *
 *   2. OVERTIME — Wall-clock work on Saturdays, Sundays or Swiss national
 *      public holidays. Auto-detected by date — no field on the entry.
 *      Treated as ADDITIONAL information; the same hours also appear in
 *      the regular total. So overtime is reported separately, not deducted.
 *
 * Both concepts are derived (no DB columns), keeping the implementation
 * backward-compatible with existing entries.
 */

import type { TimeEntry } from '@/types';

// ── Absence ──────────────────────────────────────────────────────────

/**
 * Tätigkeit names that mark an entry as an absence (vacation, sickness, etc.).
 * Match is case-insensitive and trimmed so user-typed variations still hit.
 */
export const ABSENCE_ACTIVITIES: readonly string[] = [
  'Ferien',
  'Krankheit',
  'Militär/Zivildienst',
  'Bezahlte Freistellung',
];

/** Lowercased lookup for fast membership checks. */
const ABSENCE_ACTIVITIES_LOWER = new Set(
  ABSENCE_ACTIVITIES.map((a) => a.toLowerCase().trim())
);

export function isAbsenceActivity(name: string | null | undefined): boolean {
  if (!name) return false;
  return ABSENCE_ACTIVITIES_LOWER.has(name.toLowerCase().trim());
}

export function isAbsenceEntry(entry: { taetigkeit?: string | null }): boolean {
  return isAbsenceActivity(entry.taetigkeit);
}

/**
 * Split a list of entries into work entries (everything that contributes to
 * KPIs like totalHours, productivity, average per workday) and absence
 * entries (Ferien, Krankheit, …) which are tracked separately.
 */
export function splitByAbsence(entries: TimeEntry[]): {
  work: TimeEntry[];
  absence: TimeEntry[];
} {
  const work: TimeEntry[] = [];
  const absence: TimeEntry[] = [];
  for (const e of entries) {
    if (isAbsenceEntry(e)) absence.push(e);
    else work.push(e);
  }
  return { work, absence };
}

/**
 * Per-category absence-day counts. A "day" is a distinct calendar date with
 * at least one absence entry of that category. Multiple entries on the
 * same date count once (typical for partial-day absences).
 */
export interface AbsenceDayCounts {
  ferien: number;
  krankheit: number;
  militaer: number;        // Militär/Zivildienst
  freistellung: number;    // Bezahlte Freistellung
  total: number;
}

export function countAbsenceDays(entries: TimeEntry[]): AbsenceDayCounts {
  const dates = {
    ferien: new Set<string>(),
    krankheit: new Set<string>(),
    militaer: new Set<string>(),
    freistellung: new Set<string>(),
  };
  for (const e of entries) {
    const t = (e.taetigkeit || '').toLowerCase().trim();
    if (t === 'ferien') dates.ferien.add(e.date);
    else if (t === 'krankheit') dates.krankheit.add(e.date);
    else if (t === 'militär/zivildienst' || t === 'militaer/zivildienst') dates.militaer.add(e.date);
    else if (t === 'bezahlte freistellung') dates.freistellung.add(e.date);
  }
  const total = new Set([
    ...dates.ferien,
    ...dates.krankheit,
    ...dates.militaer,
    ...dates.freistellung,
  ]).size;
  return {
    ferien: dates.ferien.size,
    krankheit: dates.krankheit.size,
    militaer: dates.militaer.size,
    freistellung: dates.freistellung.size,
    total,
  };
}

// ── Overtime / Holidays ─────────────────────────────────────────────

/**
 * Compute Easter Sunday for a given year (Gauss / Anonymous Gregorian
 * algorithm). Returns a Date at local midnight.
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/**
 * Swiss national public holidays for a given year. Returns a map
 * `YYYY-MM-DD` → human-readable label. Includes the four federally
 * observed feast days plus the most widely recognised cantonal-but-
 * national-in-spirit ones (Neujahr, Berchtoldstag, Karfreitag,
 * Ostermontag, Tag der Arbeit, Auffahrt, Pfingstmontag, Bundesfeier,
 * Weihnachten, Stephanstag).
 *
 * Cantonal-only holidays (Sechseläuten, Knabenschiessen, Mariä
 * Himmelfahrt, Allerheiligen, Mariä Empfängnis etc.) are intentionally
 * excluded — they vary too much. A future iteration can let the user
 * configure their canton in Settings.
 */
export function getSwissHolidays(year: number): Map<string, string> {
  const map = new Map<string, string>();
  const easter = easterSunday(year);

  const addFixed = (m: number, d: number, label: string) => {
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    map.set(iso, label);
  };
  const addOffset = (offsetDays: number, label: string) => {
    const dt = new Date(easter);
    dt.setDate(dt.getDate() + offsetDays);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    map.set(iso, label);
  };

  addFixed(1, 1, 'Neujahr');
  addFixed(1, 2, 'Berchtoldstag');
  addOffset(-2, 'Karfreitag');
  addOffset(1, 'Ostermontag');
  addFixed(5, 1, 'Tag der Arbeit');
  addOffset(39, 'Auffahrt');
  addOffset(50, 'Pfingstmontag');
  addFixed(8, 1, 'Bundesfeier');
  addFixed(12, 25, 'Weihnachten');
  addFixed(12, 26, 'Stephanstag');

  return map;
}

// Cache holiday maps per year — they're stable, so we compute once.
const _holidayCache = new Map<number, Map<string, string>>();
function getHolidayMap(year: number): Map<string, string> {
  let m = _holidayCache.get(year);
  if (!m) {
    m = getSwissHolidays(year);
    _holidayCache.set(year, m);
  }
  return m;
}

export function getHolidayName(dateISO: string): string | null {
  if (!dateISO || dateISO.length < 4) return null;
  const year = parseInt(dateISO.slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  return getHolidayMap(year).get(dateISO) || null;
}

export function isHoliday(dateISO: string): boolean {
  return getHolidayName(dateISO) !== null;
}

export function isWeekend(dateISO: string): boolean {
  const d = new Date(dateISO);
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

/**
 * Overtime semantic: any work performed on a Saturday, Sunday, or Swiss
 * national public holiday. Used to flag entries and compute the
 * "Überzeit" KPI.
 */
export function isOvertimeDate(dateISO: string): boolean {
  return isWeekend(dateISO) || isHoliday(dateISO);
}

/**
 * Human-readable overtime tag for a date — e.g. 'Sa', 'So', 'Karfreitag'.
 * Returns null for normal weekdays. Useful for timeline badges.
 */
export function overtimeLabel(dateISO: string): string | null {
  const holiday = getHolidayName(dateISO);
  if (holiday) return holiday;
  const d = new Date(dateISO);
  const dow = d.getDay();
  if (dow === 6) return 'Samstag';
  if (dow === 0) return 'Sonntag';
  return null;
}
