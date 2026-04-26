/**
 * Report Data Computation
 * ─────────────────────────────────────────────────────────────────────────
 * Pure functions that transform a list of TimeEntry rows into a structured
 * ReportData object — the input for the Word / HTML renderer.
 *
 * Semantic conventions (consistent with the rest of the app):
 *   - Top-level totals use computeWallClockMs (per-day union, summed across
 *     days). Two overlapping manual entries 09:00–10:00 + 09:30–10:30 count
 *     as 1.5h, not 2h.
 *   - Per-dimension breakdowns (per Stakeholder / Projekt / Tätigkeit /
 *     Format) sum entry durations naively. A 1h slot with stakeholder
 *     [A, B] counts as 1h under both A and B — multistakeholder semantic.
 *   - Daily goal: 8:24 (8.4h), matches the TimerView constant.
 *   - "Produktiv" tätigkeit is the productivity-quote numerator. Hard-coded
 *     here because that's the team-wide convention; can be made
 *     configurable later if needed.
 */

import type { TimeEntry } from '@/types';
import { computeWallClockMs, computeUnionMs, formatDateISO, getEffectiveDurationMs } from './utils';

const DAILY_GOAL_HOURS = 8.4; // 8h 24min — matches TimerView
const PRODUCTIVE_ACTIVITY_NAME = 'Produktiv';

// ── Public types ──────────────────────────────────────────────────────

export type SectionKey =
  | 'summary'
  | 'activity'
  | 'stakeholderProject'
  | 'timeline'
  | 'driver'
  | 'comparison'
  | 'notable';

export interface ReportConfig {
  /** Entries already filtered by the caller (period + dimensions). */
  entries: TimeEntry[];
  /** All entries from the same store (used for previous-period comparison). */
  allEntries: TimeEntry[];
  /** Period bounds in ISO date format (inclusive). null = all-time. */
  periodStart: string | null;
  periodEnd: string | null;
  /** Human-readable period label, e.g. "April 2026" or "KW 17". */
  periodLabel: string;
  /** Owner / codename shown in header. */
  ownerName: string;
  /** Sections to compute / render. Empty = all enabled. */
  sections: Set<SectionKey>;
  /** Whether to surface entry notes in the Zeitverlauf section. */
  includeNotes: boolean;
}

export interface ReportSummary {
  totalHours: number;            // Wall-clock
  workdays: number;              // Distinct dates with entries
  avgPerWorkday: number;         // totalHours / workdays
  avgVsGoalPct: number;          // avgPerWorkday / DAILY_GOAL_HOURS * 100
  productiveHours: number;       // Wall-clock filtered to "Produktiv" tätigkeit
  productivityPct: number;       // productiveHours / totalHours * 100
  stakeholderCount: number;
  projectCount: number;
  entriesCount: number;
}

export interface ActivityRow {
  name: string;
  hours: number;
  pct: number;
}

export interface ActivityBreakdown {
  byTaetigkeit: ActivityRow[];
  byFormat: ActivityRow[];
  /** Top-3 Tätigkeiten as highlight cards. */
  topThree: ActivityRow[];
}

export interface StakeholderRow {
  name: string;
  hours: number;
  pct: number;
}

export interface StakeholderProjectMatrix {
  stakeholders: StakeholderRow[];
  projects: StakeholderRow[];
  /** Cross-tab: matrix[stakeholder][project] = hours. */
  matrix: Record<string, Record<string, number>>;
  /** Stable column order for matrix rendering. */
  matrixProjectOrder: string[];
  matrixStakeholderOrder: string[];
}

export interface TimelineDay {
  date: string;            // YYYY-MM-DD
  weekday: string;         // Mo, Di, ...
  hours: number;           // Wall-clock for the day
  dominantProject: string | null;
  dominantStakeholder: string | null;
  notes: string[];         // Distinct non-empty notes from that day
  entryCount: number;
}

export interface TimelineWeek {
  weekStart: string;       // Monday ISO
  weekLabel: string;       // "KW 17 (22.04 – 28.04)"
  totalHours: number;      // Wall-clock for the whole week
  days: TimelineDay[];
}

export interface DriverRow {
  /** "Stakeholder · Projekt" combo */
  label: string;
  stakeholder: string;
  projekt: string;
  hours: number;
  pct: number;
  /** Number of distinct days this combo appeared on. */
  daysActive: number;
}

export interface ComparisonRow {
  label: string;
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null; // null if previous == 0
}

export interface PeriodComparison {
  /** Previous period bounds. null = no comparable period. */
  prevStart: string | null;
  prevEnd: string | null;
  prevLabel: string;
  rows: ComparisonRow[];
  /** Stakeholder ranking shifts (top 5). */
  topShifts: { name: string; currentHours: number; previousHours: number; rankCurrent: number; rankPrevious: number | null }[];
}

export interface NotableItem {
  kind: 'low' | 'high' | 'longSession' | 'streak';
  label: string;
  value: string;
  detail?: string;
}

export interface ReportData {
  generatedAt: string;     // ISO timestamp
  ownerName: string;
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  includeNotes: boolean;
  sections: Set<SectionKey>;

  summary?: ReportSummary;
  activity?: ActivityBreakdown;
  stakeholderProject?: StakeholderProjectMatrix;
  timeline?: { days: TimelineDay[]; weeks: TimelineWeek[] };
  driver?: DriverRow[];
  comparison?: PeriodComparison;
  notable?: NotableItem[];
}

// ── Helper: filter "productive" entries ──────────────────────────────
function isProductive(e: TimeEntry): boolean {
  return (e.taetigkeit || '').toLowerCase() === PRODUCTIVE_ACTIVITY_NAME.toLowerCase();
}

// ── Helper: extract stakeholders as array regardless of legacy shape ─
function shArr(e: TimeEntry): string[] {
  return Array.isArray(e.stakeholder) ? e.stakeholder : [e.stakeholder].filter(Boolean) as string[];
}

// ── Helper: previous-period bounds derived from current period ──────
/**
 * Heuristic period detection: the duration of the period determines what
 * "previous" means.
 *   1 day        → previous day
 *   2-9 days     → previous block of same length
 *   10-40 days   → previous month (approx)
 *   40-200 days  → previous quarter
 *   >200 days    → previous year
 * If period is unbounded (all-time / no filter), no comparison is computed.
 */
export function previousPeriodBounds(
  start: string | null,
  end: string | null
): { prevStart: string; prevEnd: string; label: string } | null {
  if (!start || !end) return null;
  const startD = new Date(start);
  const endD = new Date(end);
  const dayMs = 24 * 60 * 60 * 1000;
  const lengthDays = Math.round((endD.getTime() - startD.getTime()) / dayMs) + 1;

  if (lengthDays <= 0) return null;

  // Default: shift back by exactly the same length
  const prevEndD = new Date(startD.getTime() - dayMs);
  const prevStartD = new Date(prevEndD.getTime() - (lengthDays - 1) * dayMs);

  let label = 'Vorzeitraum';
  if (lengthDays === 1) label = 'Vortag';
  else if (lengthDays <= 9) label = 'Vorwoche';
  else if (lengthDays <= 40) label = 'Vormonat';
  else if (lengthDays <= 100) label = 'Vorquartal';
  else label = 'Vorjahr';

  return {
    prevStart: formatDateISO(prevStartD),
    prevEnd: formatDateISO(prevEndD),
    label,
  };
}

// ── Section computers ────────────────────────────────────────────────

function computeSummary(entries: TimeEntry[]): ReportSummary {
  const totalMs = computeWallClockMs(entries);
  const totalHours = totalMs / 3_600_000;
  const dates = new Set(entries.map((e) => e.date));
  const workdays = dates.size;
  const avgPerWorkday = workdays > 0 ? totalHours / workdays : 0;
  const avgVsGoalPct = DAILY_GOAL_HOURS > 0 ? (avgPerWorkday / DAILY_GOAL_HOURS) * 100 : 0;

  const productiveEntries = entries.filter(isProductive);
  const productiveHours = computeWallClockMs(productiveEntries) / 3_600_000;
  const productivityPct = totalHours > 0 ? (productiveHours / totalHours) * 100 : 0;

  const stakeholders = new Set<string>();
  for (const e of entries) for (const s of shArr(e)) if (s) stakeholders.add(s);
  const projects = new Set(entries.map((e) => e.projekt).filter(Boolean));

  return {
    totalHours,
    workdays,
    avgPerWorkday,
    avgVsGoalPct,
    productiveHours,
    productivityPct,
    stakeholderCount: stakeholders.size,
    projectCount: projects.size,
    entriesCount: entries.length,
  };
}

function computeActivity(entries: TimeEntry[]): ActivityBreakdown {
  // Naive sum per dimension — multistakeholder semantic
  const taetigkeitMap = new Map<string, number>();
  const formatMap = new Map<string, number>();

  for (const e of entries) {
    const dur = getEffectiveDurationMs(e) / 3_600_000;
    const t = e.taetigkeit || '—';
    const f = e.format || '—';
    taetigkeitMap.set(t, (taetigkeitMap.get(t) || 0) + dur);
    formatMap.set(f, (formatMap.get(f) || 0) + dur);
  }

  const totalT = Array.from(taetigkeitMap.values()).reduce((a, b) => a + b, 0);
  const totalF = Array.from(formatMap.values()).reduce((a, b) => a + b, 0);

  const byTaetigkeit = Array.from(taetigkeitMap.entries())
    .map(([name, hours]) => ({ name, hours, pct: totalT > 0 ? (hours / totalT) * 100 : 0 }))
    .sort((a, b) => b.hours - a.hours);
  const byFormat = Array.from(formatMap.entries())
    .map(([name, hours]) => ({ name, hours, pct: totalF > 0 ? (hours / totalF) * 100 : 0 }))
    .sort((a, b) => b.hours - a.hours);

  return {
    byTaetigkeit,
    byFormat,
    topThree: byTaetigkeit.slice(0, 3),
  };
}

function computeStakeholderProject(entries: TimeEntry[]): StakeholderProjectMatrix {
  const stakeholderMap = new Map<string, number>();
  const projectMap = new Map<string, number>();
  const matrix: Record<string, Record<string, number>> = {};

  for (const e of entries) {
    const dur = getEffectiveDurationMs(e) / 3_600_000;
    const sh = shArr(e);
    const project = e.projekt || '—';

    for (const s of sh.length > 0 ? sh : ['—']) {
      stakeholderMap.set(s, (stakeholderMap.get(s) || 0) + dur);
      if (!matrix[s]) matrix[s] = {};
      matrix[s][project] = (matrix[s][project] || 0) + dur;
    }
    projectMap.set(project, (projectMap.get(project) || 0) + dur);
  }

  const totalSh = Array.from(stakeholderMap.values()).reduce((a, b) => a + b, 0);
  const totalPr = Array.from(projectMap.values()).reduce((a, b) => a + b, 0);

  const stakeholders = Array.from(stakeholderMap.entries())
    .map(([name, hours]) => ({ name, hours, pct: totalSh > 0 ? (hours / totalSh) * 100 : 0 }))
    .sort((a, b) => b.hours - a.hours);
  const projects = Array.from(projectMap.entries())
    .map(([name, hours]) => ({ name, hours, pct: totalPr > 0 ? (hours / totalPr) * 100 : 0 }))
    .sort((a, b) => b.hours - a.hours);

  return {
    stakeholders,
    projects,
    matrix,
    matrixStakeholderOrder: stakeholders.map((s) => s.name),
    matrixProjectOrder: projects.map((p) => p.name),
  };
}

function computeTimeline(entries: TimeEntry[], includeNotes: boolean): { days: TimelineDay[]; weeks: TimelineWeek[] } {
  const dayBuckets = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const list = dayBuckets.get(e.date) || [];
    list.push(e);
    dayBuckets.set(e.date, list);
  }

  const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const days: TimelineDay[] = Array.from(dayBuckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, dayEntries]) => {
      const hours = computeUnionMs(dayEntries) / 3_600_000;
      // Dominant project: highest sum (naive — projects per entry don't overlap conceptually)
      const projectMap = new Map<string, number>();
      const stakeholderMap = new Map<string, number>();
      for (const e of dayEntries) {
        const dur = getEffectiveDurationMs(e) / 3_600_000;
        const p = e.projekt || '—';
        projectMap.set(p, (projectMap.get(p) || 0) + dur);
        for (const s of shArr(e)) {
          stakeholderMap.set(s, (stakeholderMap.get(s) || 0) + dur);
        }
      }
      const dominantProject = Array.from(projectMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const dominantStakeholder = Array.from(stakeholderMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const notes = includeNotes
        ? Array.from(new Set(dayEntries.map((e) => (e.notiz || '').trim()).filter(Boolean)))
        : [];

      const dayOfWeek = new Date(date).getDay();
      return {
        date,
        weekday: wd[dayOfWeek],
        hours,
        dominantProject,
        dominantStakeholder,
        notes,
        entryCount: dayEntries.length,
      };
    });

  // Group days into ISO weeks
  const weekBuckets = new Map<string, TimelineDay[]>();
  for (const d of days) {
    const dt = new Date(d.date);
    const day = dt.getDay() || 7; // 1..7, Mo=1
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - (day - 1));
    const weekKey = formatDateISO(monday);
    const list = weekBuckets.get(weekKey) || [];
    list.push(d);
    weekBuckets.set(weekKey, list);
  }

  const weeks: TimelineWeek[] = Array.from(weekBuckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, weekDays]) => {
      const monday = new Date(weekStart);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const isoWeek = getISOWeekNumber(monday);
      const fmt = (d: Date) =>
        `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      const totalHours = weekDays.reduce((s, d) => s + d.hours, 0);
      return {
        weekStart,
        weekLabel: `KW ${isoWeek} (${fmt(monday)} – ${fmt(sunday)})`,
        totalHours,
        days: weekDays,
      };
    });

  return { days, weeks };
}

function getISOWeekNumber(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/**
 * Aufwandstreiber: top stakeholder × projekt combinations by hours.
 * Returns at most 10 rows; rows are sorted by hours descending.
 */
function computeDriver(entries: TimeEntry[]): DriverRow[] {
  const comboMap = new Map<string, { stakeholder: string; projekt: string; hours: number; dates: Set<string> }>();
  let totalHours = 0;

  for (const e of entries) {
    const dur = getEffectiveDurationMs(e) / 3_600_000;
    totalHours += dur;
    const sh = shArr(e);
    const project = e.projekt || '—';
    for (const s of sh.length > 0 ? sh : ['—']) {
      const key = `${s}__${project}`;
      const prev = comboMap.get(key);
      if (prev) {
        prev.hours += dur;
        prev.dates.add(e.date);
      } else {
        comboMap.set(key, { stakeholder: s, projekt: project, hours: dur, dates: new Set([e.date]) });
      }
    }
  }

  return Array.from(comboMap.values())
    .map((row) => ({
      label: `${row.stakeholder} · ${row.projekt}`,
      stakeholder: row.stakeholder,
      projekt: row.projekt,
      hours: row.hours,
      pct: totalHours > 0 ? (row.hours / totalHours) * 100 : 0,
      daysActive: row.dates.size,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 10);
}

function computeComparison(
  currentEntries: TimeEntry[],
  allEntries: TimeEntry[],
  periodStart: string | null,
  periodEnd: string | null
): PeriodComparison | undefined {
  const bounds = previousPeriodBounds(periodStart, periodEnd);
  if (!bounds) return undefined;

  const previousEntries = allEntries.filter(
    (e) => e.date >= bounds.prevStart && e.date <= bounds.prevEnd
  );

  const curSummary = computeSummary(currentEntries);
  const prevSummary = computeSummary(previousEntries);

  const rows: ComparisonRow[] = [
    {
      label: 'Gesamtstunden',
      current: curSummary.totalHours,
      previous: prevSummary.totalHours,
      delta: curSummary.totalHours - prevSummary.totalHours,
      deltaPct: prevSummary.totalHours > 0
        ? ((curSummary.totalHours - prevSummary.totalHours) / prevSummary.totalHours) * 100
        : null,
    },
    {
      label: 'Arbeitstage',
      current: curSummary.workdays,
      previous: prevSummary.workdays,
      delta: curSummary.workdays - prevSummary.workdays,
      deltaPct: prevSummary.workdays > 0
        ? ((curSummary.workdays - prevSummary.workdays) / prevSummary.workdays) * 100
        : null,
    },
    {
      label: 'Ø Stunden / Arbeitstag',
      current: curSummary.avgPerWorkday,
      previous: prevSummary.avgPerWorkday,
      delta: curSummary.avgPerWorkday - prevSummary.avgPerWorkday,
      deltaPct: prevSummary.avgPerWorkday > 0
        ? ((curSummary.avgPerWorkday - prevSummary.avgPerWorkday) / prevSummary.avgPerWorkday) * 100
        : null,
    },
    {
      label: 'Produktivitätsquote',
      current: curSummary.productivityPct,
      previous: prevSummary.productivityPct,
      delta: curSummary.productivityPct - prevSummary.productivityPct,
      deltaPct: prevSummary.productivityPct > 0
        ? ((curSummary.productivityPct - prevSummary.productivityPct) / prevSummary.productivityPct) * 100
        : null,
    },
    {
      label: 'Anzahl Stakeholder',
      current: curSummary.stakeholderCount,
      previous: prevSummary.stakeholderCount,
      delta: curSummary.stakeholderCount - prevSummary.stakeholderCount,
      deltaPct: prevSummary.stakeholderCount > 0
        ? ((curSummary.stakeholderCount - prevSummary.stakeholderCount) / prevSummary.stakeholderCount) * 100
        : null,
    },
  ];

  // Top stakeholder ranking shift
  const curSh = computeStakeholderProject(currentEntries).stakeholders;
  const prevSh = computeStakeholderProject(previousEntries).stakeholders;
  const prevRank = new Map(prevSh.map((s, i) => [s.name, i + 1]));
  const topShifts = curSh.slice(0, 5).map((s, i) => ({
    name: s.name,
    currentHours: s.hours,
    previousHours: prevSh.find((p) => p.name === s.name)?.hours || 0,
    rankCurrent: i + 1,
    rankPrevious: prevRank.get(s.name) || null,
  }));

  return {
    prevStart: bounds.prevStart,
    prevEnd: bounds.prevEnd,
    prevLabel: bounds.label,
    rows,
    topShifts,
  };
}

function computeNotable(entries: TimeEntry[]): NotableItem[] {
  const dayBuckets = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const list = dayBuckets.get(e.date) || [];
    list.push(e);
    dayBuckets.set(e.date, list);
  }

  const dayHours = Array.from(dayBuckets.entries())
    .map(([date, dayEntries]) => ({ date, hours: computeUnionMs(dayEntries) / 3_600_000 }))
    .filter((d) => d.hours > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (dayHours.length === 0) return [];

  const avg = dayHours.reduce((s, d) => s + d.hours, 0) / dayHours.length;
  const items: NotableItem[] = [];

  // High-load days: >150% of average
  const highDays = dayHours.filter((d) => d.hours >= avg * 1.5).slice(0, 3);
  for (const d of highDays) {
    items.push({
      kind: 'high',
      label: `Mehrarbeit am ${formatDay(d.date)}`,
      value: `${d.hours.toFixed(1)}h`,
      detail: `≈ ${(d.hours / avg).toFixed(1)}× Tagesdurchschnitt`,
    });
  }

  // Low-load days: <50% of average AND >0
  const lowDays = dayHours.filter((d) => d.hours > 0 && d.hours <= avg * 0.5).slice(0, 3);
  for (const d of lowDays) {
    items.push({
      kind: 'low',
      label: `Schwacher Tag am ${formatDay(d.date)}`,
      value: `${d.hours.toFixed(1)}h`,
      detail: `≈ ${((d.hours / avg) * 100).toFixed(0)}% Tagesdurchschnitt`,
    });
  }

  // Longest single session
  const longest = entries
    .map((e) => ({ entry: e, ms: getEffectiveDurationMs(e) }))
    .sort((a, b) => b.ms - a.ms)[0];
  if (longest && longest.ms > 0) {
    items.push({
      kind: 'longSession',
      label: 'Längste Einzel-Session',
      value: `${(longest.ms / 3_600_000).toFixed(1)}h`,
      detail: `${formatDay(longest.entry.date)} · ${longest.entry.projekt || '—'}`,
    });
  }

  // Streak: longest run of consecutive days with entries
  let curStreak = 1;
  let bestStreak = 1;
  for (let i = 1; i < dayHours.length; i++) {
    const d1 = new Date(dayHours[i - 1].date);
    const d2 = new Date(dayHours[i].date);
    const diff = Math.round((d2.getTime() - d1.getTime()) / (24 * 3600 * 1000));
    if (diff === 1) {
      curStreak += 1;
      bestStreak = Math.max(bestStreak, curStreak);
    } else {
      curStreak = 1;
    }
  }
  if (bestStreak > 2) {
    items.push({
      kind: 'streak',
      label: 'Längste Tagesserie',
      value: `${bestStreak} Tage`,
      detail: 'aufeinanderfolgende Erfassungen',
    });
  }

  return items;
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

// ── Public entry point ───────────────────────────────────────────────

export function buildReportData(cfg: ReportConfig): ReportData {
  const sections = cfg.sections.size > 0
    ? cfg.sections
    : new Set<SectionKey>(['summary', 'activity', 'stakeholderProject', 'timeline', 'driver', 'comparison', 'notable']);

  const data: ReportData = {
    generatedAt: new Date().toISOString(),
    ownerName: cfg.ownerName,
    periodLabel: cfg.periodLabel,
    periodStart: cfg.periodStart,
    periodEnd: cfg.periodEnd,
    includeNotes: cfg.includeNotes,
    sections,
  };

  if (sections.has('summary')) data.summary = computeSummary(cfg.entries);
  if (sections.has('activity')) data.activity = computeActivity(cfg.entries);
  if (sections.has('stakeholderProject')) data.stakeholderProject = computeStakeholderProject(cfg.entries);
  if (sections.has('timeline')) data.timeline = computeTimeline(cfg.entries, cfg.includeNotes);
  if (sections.has('driver')) data.driver = computeDriver(cfg.entries);
  if (sections.has('comparison')) {
    data.comparison = computeComparison(cfg.entries, cfg.allEntries, cfg.periodStart, cfg.periodEnd);
  }
  if (sections.has('notable')) data.notable = computeNotable(cfg.entries);

  return data;
}
