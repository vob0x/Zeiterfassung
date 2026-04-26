import { useMemo, useState, useCallback } from 'react';
import { useI18n } from '../../i18n';
import { useEntriesStore } from '../../stores/entriesStore';
import { useMasterStore } from '../../stores/masterStore';
import { useUiStore } from '../../stores/uiStore';
import { PeriodType, FilterState, TimeEntry } from '@/types';
import { formatDateISO, formatDateDE, computeWallClockMs } from '../../lib/utils';
import { KpiCards } from './KpiCards';
import { Heatmap } from './Heatmap';
import { ActivityBars } from './ActivityBars';
import { TimelineChart } from './TimelineChart';
import { Inbox, ChevronLeft, ChevronRight, RotateCcw, ArrowLeft, FileDown } from 'lucide-react';
import ReportModal from './ReportModal';

// Helper: get ISO week number
function getISOWeek(date: Date): number {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

const MONTH_NAMES_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTH_NAMES_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const DAY_NAMES_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAY_NAMES_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

/**
 * Optional props enable an "embedded" / "scoped" mode used by the Team-View
 * admin drill-down. When `scopedEntries` is provided, the dashboard renders
 * those entries instead of the current user's, uses local filter state
 * (no global pollution), and disables the drill-down → entries-view
 * navigation (which only knows the current user's data).
 */
export interface DashboardViewProps {
  /** When set, render this list instead of the current user's entries. */
  scopedEntries?: TimeEntry[];
  /** Subtitle / context label shown above the period selector. */
  viewerLabel?: string;
  /** Back-button callback. When set, a back-button is rendered in the header. */
  onBack?: () => void;
  /** When true, drill-down clicks no-op (used in scoped mode). */
  disableDrillDown?: boolean;
}

export default function DashboardView({
  scopedEntries,
  viewerLabel,
  onBack,
  disableDrillDown,
}: DashboardViewProps = {}) {
  const { t, language } = useI18n();
  const isScoped = scopedEntries !== undefined;
  const ownEntries = useEntriesStore((state) => state.entries);
  const entries = isScoped ? scopedEntries! : ownEntries;
  const globalFilters = useEntriesStore((s) => s.filters);
  const setGlobalFilter = useEntriesStore((s) => s.setFilter);
  const clearGlobalFilters = useEntriesStore((s) => s.clearFilters);

  // In scoped mode keep filter state local — pushing filters into the global
  // entries store would leak member-context into the user's own Entries view.
  const [localFilters, setLocalFilters] = useState<FilterState>({
    from: '', to: '', stakeholder: '', project: '', activity: '', format: '', notiz: '',
  });
  const filters = isScoped ? localFilters : globalFilters;
  const setFilter = useCallback(
    (key: keyof FilterState, value: string) => {
      if (isScoped) {
        setLocalFilters((prev) => ({ ...prev, [key]: value }));
      } else {
        setGlobalFilter(key, value);
      }
    },
    [isScoped, setGlobalFilter]
  );
  const clearFilters = useCallback(() => {
    if (isScoped) {
      setLocalFilters({ from: '', to: '', stakeholder: '', project: '', activity: '', format: '', notiz: '' });
    } else {
      clearGlobalFilters();
    }
  }, [isScoped, clearGlobalFilters]);

  const { stakeholders, projects, activities, formats } = useMasterStore();
  const [period, setPeriod] = useState<PeriodType>('week');
  // offset: 0 = current period, -1 = previous, +1 = next (capped at 0 for future)
  const [offset, setOffset] = useState(0);
  // Report modal: only available on the user's own dashboard, not the
  // admin-scoped member view (the report is a personal management report).
  const [reportOpen, setReportOpen] = useState(false);

  const monthNames = language === 'fr' ? MONTH_NAMES_FR : MONTH_NAMES_DE;
  const dayNames = language === 'fr' ? DAY_NAMES_FR : DAY_NAMES_DE;

  // Compute date range based on period + offset
  const { dateRange, periodLabel } = useMemo(() => {
    const today = new Date();
    const todayISO = formatDateISO(today);

    switch (period) {
      case 'day': {
        const d = new Date(today);
        d.setDate(d.getDate() + offset);
        const iso = formatDateISO(d);
        const label = offset === 0
          ? t('dash.today')
          : `${dayNames[d.getDay()]}, ${formatDateDE(iso)}`;
        return { dateRange: { start: iso, end: iso }, periodLabel: label };
      }
      case 'week': {
        // Get Monday of current week, then shift by offset weeks
        const day = today.getDay();
        const diff = day === 0 ? 6 : day - 1;
        const monday = new Date(today);
        monday.setDate(today.getDate() - diff + offset * 7);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const end = sunday > today && offset === 0 ? todayISO : formatDateISO(sunday);
        const weekNum = getISOWeek(monday);
        const label = offset === 0
          ? `KW ${weekNum} (${t('dash.thisWeek')})`
          : `KW ${weekNum} · ${formatDateDE(formatDateISO(monday))} – ${formatDateDE(end)}`;
        return { dateRange: { start: formatDateISO(monday), end }, periodLabel: label };
      }
      case 'month': {
        const m = new Date(today.getFullYear(), today.getMonth() + offset, 1);
        const lastDay = new Date(m.getFullYear(), m.getMonth() + 1, 0);
        const end = lastDay > today && offset === 0 ? todayISO : formatDateISO(lastDay);
        const label = offset === 0
          ? `${monthNames[m.getMonth()]} ${m.getFullYear()} (${t('dash.thisMonth')})`
          : `${monthNames[m.getMonth()]} ${m.getFullYear()}`;
        return { dateRange: { start: formatDateISO(m), end }, periodLabel: label };
      }
      case 'year': {
        const y = today.getFullYear() + offset;
        const jan1 = new Date(y, 0, 1);
        const dec31 = new Date(y, 11, 31);
        const end = dec31 > today && offset === 0 ? todayISO : formatDateISO(dec31);
        const label = offset === 0
          ? `${y} (${t('dash.thisYear')})`
          : `${y}`;
        return { dateRange: { start: formatDateISO(jan1), end }, periodLabel: label };
      }
      case 'all':
        return { dateRange: { start: null, end: null }, periodLabel: t('dash.all') };
      default:
        return { dateRange: { start: null, end: null }, periodLabel: '' };
    }
  }, [period, offset, t, language, monthNames, dayNames]);

  // Filter entries by period
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (dateRange?.start && entry.date < dateRange.start) return false;
      if (dateRange?.end && entry.date > dateRange.end) return false;

      // Handle stakeholder as array
      if (filters.stakeholder) {
        const stakeholderArray = Array.isArray(entry.stakeholder) ? entry.stakeholder : [entry.stakeholder];
        if (!stakeholderArray.includes(filters.stakeholder)) return false;
      }
      if (filters.project && entry.projekt !== filters.project) return false;
      if (filters.activity && entry.taetigkeit !== filters.activity) return false;
      if (filters.format && entry.format !== filters.format) return false;

      if (filters.notiz) {
        const searchTerm = filters.notiz.toLowerCase();
        const entryNotiz = (entry.notiz || '').toLowerCase();
        if (!entryNotiz.includes(searchTerm)) return false;
      }

      return true;
    });
  }, [entries, dateRange, filters]);

  // Compute today's entries (using local date, not UTC)
  const todayStr = formatDateISO(new Date());
  const todayEntries = entries.filter((e) => e.date === todayStr);

  // Sum using effective duration (plausibility-checked against Von-Bis)
  // Wall-clock totals: a 09:00–10:00 + 09:30–10:30 pair counts as 1.5h,
  // not 2h, by computing per-day unions and summing across days.
  const kpiToday = computeWallClockMs(todayEntries) / (1000 * 60 * 60);

  const kpiPeriod = useMemo(() => {
    return computeWallClockMs(filteredEntries) / (1000 * 60 * 60);
  }, [filteredEntries]);

  const kpiEntries = filteredEntries.length;

  const hasActiveFilters = Object.values(filters).some((v) => v !== '');
  const { setCurrentView } = useUiStore();

  // Drill-down: set filters and navigate to entries view.
  // In scoped (admin-member) mode, the entries view doesn't understand the
  // member context yet — drill-down is treated as a chart-internal filter
  // refinement only (no navigation), preventing footgun navigation that
  // would jump to the admin's OWN entries.
  const drillDown = useCallback((drillFilters: Partial<FilterState>) => {
    if (disableDrillDown || isScoped) {
      // Apply the drill-filters as local filter refinement, no navigation
      for (const [key, value] of Object.entries(drillFilters)) {
        if (value) setFilter(key as keyof FilterState, value);
      }
      return;
    }
    clearFilters();
    // Apply date range from current period
    if (dateRange?.start) setFilter('from', dateRange.start);
    if (dateRange?.end) setFilter('to', dateRange.end);
    // Apply any active dashboard filters first
    if (filters.stakeholder) setFilter('stakeholder', filters.stakeholder);
    if (filters.project) setFilter('project', filters.project);
    if (filters.activity) setFilter('activity', filters.activity);
    if (filters.format) setFilter('format', filters.format);
    // Then override with drill-down specific filters
    for (const [key, value] of Object.entries(drillFilters)) {
      if (value) setFilter(key as keyof FilterState, value);
    }
    setCurrentView('entries');
  }, [dateRange, filters, clearFilters, setFilter, setCurrentView, disableDrillDown, isScoped]);

  return (
    <div className={isScoped ? 'space-y-6' : 'w-full max-w-7xl mx-auto p-4 space-y-6'}>
      {/* Optional header — only shown in scoped (admin-member) mode */}
      {(viewerLabel || onBack) && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="px-3 py-2 rounded font-medium transition-all flex items-center gap-2"
                style={{ background: 'var(--surface-solid)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              >
                <ArrowLeft className="w-4 h-4" />
                {t('team.backToOverview')}
              </button>
            )}
            {viewerLabel && (
              <div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('team.viewingMember')}</div>
                <h3 className="text-xl font-bold" style={{ color: 'var(--neon-violet, #9B8EC4)' }}>{viewerLabel}</h3>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Period Selector */}
      <div className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(['day', 'week', 'month', 'year', 'all'] as PeriodType[]).map((p) => (
            <button
              key={p}
              onClick={() => { setPeriod(p); setOffset(0); }}
              className={`btn btn-sm rounded-lg font-medium transition-all ${
                period === p
                  ? 'btn-primary'
                  : 'btn-secondary'
              }`}
            >
              {t(`dash.${p}`)}
            </button>
          ))}
        </div>

        {/* Date Navigation */}
        {period !== 'all' && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOffset(o => o - 1)}
              className="btn-icon"
              aria-label={t('dash.prev')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span
              className="text-sm font-medium min-w-[180px] text-center"
              style={{ color: 'var(--text-secondary)' }}
            >
              {periodLabel}
            </span>

            <button
              onClick={() => setOffset(o => Math.min(o + 1, 0))}
              className="btn-icon"
              disabled={offset >= 0}
              style={{ opacity: offset >= 0 ? 0.3 : 1 }}
              aria-label={t('dash.next')}
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            {offset !== 0 && (
              <button
                onClick={() => setOffset(0)}
                className="btn btn-sm btn-secondary rounded-lg flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                {t('dash.today')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex gap-2 flex-wrap">
          <select
            value={filters.stakeholder}
            onChange={(e) => setFilter('stakeholder', e.target.value)}
            className="select"
          >
            <option value="">{t('all.stakeholder')}</option>
            {stakeholders.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <select
            value={filters.project}
            onChange={(e) => setFilter('project', e.target.value)}
            className="select"
          >
            <option value="">{t('all.projekte')}</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <select
            value={filters.format}
            onChange={(e) => setFilter('format', e.target.value)}
            className="select"
          >
            <option value="">{t('all.formate')}</option>
            {formats.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          <select
            value={filters.activity}
            onChange={(e) => setFilter('activity', e.target.value)}
            className="select"
          >
            <option value="">{t('all.taetigkeiten')}</option>
            {activities.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>

          <input
            type="text"
            placeholder={t('filter.notiz')}
            value={filters.notiz}
            onChange={(e) => setFilter('notiz', e.target.value)}
            className="input flex-1"
          />

          {hasActiveFilters && (
            <button
              onClick={() => clearFilters()}
              className="btn btn-secondary btn-sm"
            >
              {t('filter.clearAll')}
            </button>
          )}
        </div>

        {hasActiveFilters && (
          <div style={{ color: 'var(--primary)' }} className="text-sm">
            {filteredEntries.length} {t('entries.count')}
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <KpiCards today={kpiToday} period={kpiPeriod} entries={kpiEntries} onDrillDown={() => drillDown({})} />

      {/* Report button — only on the user's own dashboard, not in admin
          scoped-member view. Wrapped in its own card to give it visual
          weight under the heavy KPI card shadows; uses btn-primary so the
          gold fill stays visible against the new dark mode palette.
          (Drill-down hint removed — KPI cards rely on cursor:pointer +
          tooltip, the floating "Klicken zum Filtern…" line was visually
          glued to the cards by a negative margin and looked like a layout
          artifact.) */}
      {!isScoped && (
        <div
          className="card p-4 flex flex-col sm:flex-row items-center justify-between gap-3"
          style={{ borderColor: 'rgba(201,169,98,0.25)' }}
        >
          <div className="text-center sm:text-left">
            <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
              {t('report.create')}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('report.cardHint')}
            </div>
          </div>
          <button
            onClick={() => setReportOpen(true)}
            disabled={filteredEntries.length === 0}
            className="btn btn-primary flex items-center gap-2 flex-shrink-0"
            style={{ opacity: filteredEntries.length === 0 ? 0.4 : 1 }}
          >
            <FileDown className="w-4 h-4" />
            {t('report.create')}
          </button>
        </div>
      )}

      {/* Report Modal — controlled by the button above */}
      {!isScoped && (
        <ReportModal
          isOpen={reportOpen}
          onClose={() => setReportOpen(false)}
          filteredEntries={filteredEntries}
          periodLabel={periodLabel}
          periodStart={dateRange?.start || null}
          periodEnd={dateRange?.end || null}
        />
      )}

      {/* Empty State */}
      {filteredEntries.length === 0 ? (
        <div className="card text-center py-16 px-6">
          <Inbox className="w-10 h-10 mx-auto mb-4" style={{ opacity: 0.4, color: 'var(--text-muted)' }} />
          <p className="text-lg font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
            {t('dash.noEntries')}
          </p>
        </div>
      ) : (
        <>
          {/* Heatmap */}
          <div className="card p-4">
            <h2 style={{ color: 'var(--text)' }} className="text-lg font-semibold mb-4">{t('dash.shxpr')}</h2>
            <Heatmap entries={filteredEntries} onDrillDown={drillDown} />
          </div>

          {/* Activity Breakdown */}
          <div className="card p-4">
            <h2 style={{ color: 'var(--text)' }} className="text-lg font-semibold mb-4">{t('dash.byActivity')}</h2>
            <ActivityBars entries={filteredEntries} onDrillDown={drillDown} />
          </div>

          {/* Format Breakdown */}
          <div className="card p-4">
            <h2 style={{ color: 'var(--text)' }} className="text-lg font-semibold mb-4">{t('dash.byFormat')}</h2>
            <ActivityBars entries={filteredEntries} isFormat onDrillDown={drillDown} />
          </div>

          {/* Timeline Chart */}
          <div className="card p-4">
            <h2 style={{ color: 'var(--text)' }} className="text-lg font-semibold mb-4">{t('dash.timeline')}</h2>
            <TimelineChart entries={filteredEntries} onDrillDown={drillDown} />
          </div>
        </>
      )}
    </div>
  );
}
