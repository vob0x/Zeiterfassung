import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useEntriesStore } from '../../stores/entriesStore';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import Modal from '../UI/Modal';
import { FileText, Download, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { TimeEntry } from '@/types';
import { buildReportData, generateNarratives, type SectionKey, type NarrativeBundle } from '../../lib/reportData';
import { downloadReport } from '../../lib/reportRenderer';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Filter result from the active dashboard view (period + dimension filters). */
  filteredEntries: TimeEntry[];
  /** Period label, e.g. "April 2026". */
  periodLabel: string;
  /** Period bounds (used for previous-period comparison). */
  periodStart: string | null;
  periodEnd: string | null;
}

interface SectionDef {
  key: SectionKey;
  label: string;
  hint: string;
}

const ALL_SECTIONS: SectionDef[] = [
  { key: 'summary', label: 'Executive Summary', hint: 'Total, Tage, ⌀/Tag, Produktivitätsquote' },
  { key: 'activity', label: 'Aktivitäts-Verteilung', hint: 'Stunden je Tätigkeit + Format' },
  { key: 'stakeholderProject', label: 'Stakeholder & Projekt', hint: 'Tabellen + Kreuztabelle' },
  { key: 'driver', label: 'Aufwandstreiber', hint: 'Top 10 Stakeholder × Projekt nach Stunden' },
  { key: 'comparison', label: 'Veränderung Vorzeitraum', hint: 'Δ vs. vorherigem Zeitraum gleicher Länge' },
  { key: 'timeline', label: 'Zeitverlauf', hint: 'Tagesweise + Wochen-Aggregat' },
  { key: 'notable', label: 'Auffälligkeiten', hint: 'Über-/Unterdurchschnittliche Tage, längste Sessions' },
];

export default function ReportModal({
  isOpen,
  onClose,
  filteredEntries,
  periodLabel,
  periodStart,
  periodEnd,
}: ReportModalProps) {
  const { t } = useI18n();
  const allEntries = useEntriesStore((s) => s.entries);
  const profile = useAuthStore((s) => s.profile);
  const showToast = useUiStore((s) => s.showToast);

  // Default: all sections enabled
  const [enabledSections, setEnabledSections] = useState<Set<SectionKey>>(
    new Set(ALL_SECTIONS.map((s) => s.key))
  );
  const [includeNotes, setIncludeNotes] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Narrative editor state. Auto-populated from the data each time a
  // structural input changes (sections / period / notes flag), but the
  // user can override each field. Empty string means "render this without
  // prose" — a deliberate user choice we want to honor.
  const [narratives, setNarratives] = useState<NarrativeBundle>({ managementSummary: '', bySection: {} });
  const [narrativeOpen, setNarrativeOpen] = useState(false);
  // Track which fields the user has touched, so re-generation doesn't blow
  // away their edits when they toggle a section or the notes flag.
  const [overridden, setOverridden] = useState<Record<string, boolean>>({});

  const toggleSection = (key: SectionKey) => {
    setEnabledSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allOn = enabledSections.size === ALL_SECTIONS.length;
  const toggleAll = () => {
    if (allOn) setEnabledSections(new Set());
    else setEnabledSections(new Set(ALL_SECTIONS.map((s) => s.key)));
  };

  // Live counter so the user sees what'll be in scope
  const matchSummary = useMemo(() => {
    const dates = new Set(filteredEntries.map((e) => e.date));
    return { entries: filteredEntries.length, days: dates.size };
  }, [filteredEntries]);

  const ownerName = profile?.codename || 'User';

  // Auto-fill narratives whenever the structural inputs change, but PRESERVE
  // any field the user has manually edited. This way picking "include notes"
  // won't wipe a paragraph the user already polished. Reset by clicking
  // "Auto-Texte zurücksetzen" in the panel header.
  useEffect(() => {
    if (!isOpen || filteredEntries.length === 0) return;
    try {
      const data = buildReportData({
        entries: filteredEntries,
        allEntries,
        periodStart,
        periodEnd,
        periodLabel,
        ownerName,
        sections: enabledSections,
        includeNotes,
      });
      const fresh = generateNarratives(data);
      setNarratives((prev) => ({
        managementSummary: overridden.managementSummary ? prev.managementSummary : fresh.managementSummary,
        bySection: { ...fresh.bySection, ...Object.fromEntries(
          Object.entries(prev.bySection).filter(([k]) => overridden[`s:${k}`])
        ) },
      }));
    } catch {
      // Defensive — auto-narrative generation is best-effort
    }
    // overridden intentionally NOT a dep — we read it but don't track
    // changes (Object.fromEntries snapshot is enough)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filteredEntries, periodStart, periodEnd, periodLabel, includeNotes, enabledSections]);

  const setManagementSummary = (v: string) => {
    setNarratives((prev) => ({ ...prev, managementSummary: v }));
    setOverridden((prev) => ({ ...prev, managementSummary: true }));
  };
  const setSectionNarrative = (key: SectionKey, v: string) => {
    setNarratives((prev) => ({ ...prev, bySection: { ...prev.bySection, [key]: v } }));
    setOverridden((prev) => ({ ...prev, [`s:${key}`]: true }));
  };
  const resetNarratives = () => {
    if (filteredEntries.length === 0) return;
    const data = buildReportData({
      entries: filteredEntries,
      allEntries,
      periodStart,
      periodEnd,
      periodLabel,
      ownerName,
      sections: enabledSections,
      includeNotes,
    });
    setNarratives(generateNarratives(data));
    setOverridden({});
  };

  async function handleDownload(format: 'html' | 'word') {
    if (filteredEntries.length === 0) {
      showToast(t('report.noData'), 'warning');
      return;
    }
    setGenerating(true);
    try {
      const data = buildReportData({
        entries: filteredEntries,
        allEntries,
        periodStart,
        periodEnd,
        periodLabel,
        ownerName,
        sections: enabledSections,
        includeNotes,
      });
      // Inject user-edited narratives — these override the auto-generated
      // defaults that buildReportData() seeded.
      data.narratives = narratives;
      // Yield to React so the spinner state shows before the heavy render.
      await new Promise((r) => setTimeout(r, 0));
      downloadReport(data, format);
      showToast(t('report.generated'), 'success');
      onClose();
    } catch (e) {
      console.error('[Report] Failed to generate:', e);
      showToast(e instanceof Error ? e.message : t('toast.error'), 'error');
    } finally {
      setGenerating(false);
    }
  }

  const cantGenerate = enabledSections.size === 0 || matchSummary.entries === 0 || generating;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('report.title')}>
      <div className="space-y-4 p-1">
        {/* Period & data scope summary */}
        <div
          className="rounded-lg p-3"
          style={{ background: 'var(--surface-solid)', border: '1px solid var(--border)' }}
        >
          <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
            {t('report.scope')}
          </div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            {periodLabel || t('report.allTime')}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {matchSummary.entries} {t('entries.count')} · {matchSummary.days} {t('report.days')}
          </div>
        </div>

        {/* Section toggles */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              {t('report.sections')}
            </h4>
            <button
              onClick={toggleAll}
              className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
              style={{ background: 'var(--surface-solid)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {allOn ? t('batch.deselectAll') : t('batch.selectAll')}
            </button>
          </div>
          <div className="space-y-1.5">
            {ALL_SECTIONS.map((section) => (
              <label
                key={section.key}
                className="flex items-start gap-2 p-2 rounded cursor-pointer"
                style={{
                  background: enabledSections.has(section.key) ? 'rgba(201,169,98,0.06)' : 'transparent',
                  border: '1px solid transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={enabledSections.has(section.key)}
                  onChange={() => toggleSection(section.key)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>{section.label}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{section.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Notes toggle */}
        <label
          className="flex items-start gap-2 p-2 rounded cursor-pointer"
          style={{ background: 'var(--surface-solid)', border: '1px solid var(--border)' }}
        >
          <input
            type="checkbox"
            checked={includeNotes}
            onChange={(e) => setIncludeNotes(e.target.checked)}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>{t('report.includeNotes')}</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('report.includeNotesHint')}</div>
          </div>
        </label>

        {/* ── Narratives editor (collapsible, default closed) ─────
            Each section gets a small textarea pre-filled with the auto-
            generated prose. The user can edit, clear, or reset to defaults.
            Clearing a field renders the section without a narrative — a
            deliberate choice we preserve on re-render. */}
        <div
          className="rounded-lg"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-solid)' }}
        >
          <button
            type="button"
            onClick={() => setNarrativeOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' }}
          >
            <div className="flex items-center gap-2">
              {narrativeOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <span className="text-sm font-semibold">{t('report.narrativeTitle')}</span>
              {Object.values(overridden).some(Boolean) && (
                <span
                  className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
                  style={{ background: 'rgba(155,142,196,0.15)', color: 'var(--neon-violet, #9B8EC4)' }}
                >
                  {t('report.narrativeEdited')}
                </span>
              )}
            </div>
            {narrativeOpen && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); resetNarratives(); }}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                title={t('report.narrativeReset')}
              >
                <RotateCcw className="w-3 h-3" />
                {t('report.narrativeReset')}
              </button>
            )}
          </button>
          {narrativeOpen && (
            <div className="px-3 pb-3 space-y-3" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="pt-3">
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-secondary)' }}>
                  {t('report.managementSummary')}
                </label>
                <textarea
                  value={narratives.managementSummary}
                  onChange={(e) => setManagementSummary(e.target.value)}
                  rows={4}
                  className="w-full px-2 py-1.5 rounded text-sm"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--font)', resize: 'vertical' }}
                  placeholder={t('report.narrativePlaceholder')}
                />
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {t('report.managementSummaryHint')}
                </p>
              </div>

              {/* Per-section commentaries — one textarea each, only for
                  sections that are currently enabled. */}
              {ALL_SECTIONS.filter((s) => enabledSections.has(s.key)).map((section) => (
                <div key={section.key}>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {section.label}
                  </label>
                  <textarea
                    value={narratives.bySection[section.key] || ''}
                    onChange={(e) => setSectionNarrative(section.key, e.target.value)}
                    rows={2}
                    className="w-full px-2 py-1.5 rounded text-sm"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--font)', resize: 'vertical' }}
                    placeholder={t('report.narrativePlaceholder')}
                  />
                </div>
              ))}

              <p className="text-[11px] italic" style={{ color: 'var(--text-muted)' }}>
                {t('report.narrativeFooterHint')}
              </p>
            </div>
          )}
        </div>

        {/* HTML download — Word is intentionally not exposed in the MVP.
            The renderer already supports a Word path (forWord=true), so
            re-enabling it later only requires a second button here. */}
        <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => handleDownload('html')}
            disabled={cantGenerate}
            className="btn btn-primary flex items-center justify-center gap-2 w-full"
            style={{ opacity: cantGenerate ? 0.4 : 1 }}
          >
            <FileText className="w-4 h-4" />
            {t('report.downloadHtml')}
          </button>
          <p className="text-[11px] mt-2 text-center italic" style={{ color: 'var(--text-muted)' }}>
            {t('report.htmlOnlyHint')}
          </p>
        </div>

        {generating && (
          <div className="flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <Download className="w-4 h-4 animate-pulse" />
            {t('ui.loading')}
          </div>
        )}

        {matchSummary.entries === 0 && (
          <p className="text-xs italic text-center" style={{ color: 'var(--text-muted)' }}>
            {t('report.noData')}
          </p>
        )}
      </div>
    </Modal>
  );
}
