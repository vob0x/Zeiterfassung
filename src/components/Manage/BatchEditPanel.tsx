import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useEntriesStore } from '../../stores/entriesStore';
import { useMasterStore } from '../../stores/masterStore';
import { useTeamStore } from '../../stores/teamStore';
import { useUiStore } from '../../stores/uiStore';
import type { BulkFilter, BulkChanges } from '../../stores/entriesStore';
import { ChevronDown, ChevronRight, Wand2, AlertTriangle } from 'lucide-react';
import ConfirmDialog from '../UI/ConfirmDialog';
import { formatDateDE, formatDurationHM, getEffectiveDurationMs } from '../../lib/utils';

/**
 * Admin-only batch editor: filter team-wide entries, then apply a single set
 * of field changes to all matches. Designed for data hygiene tasks like
 * "all 'Konzept' entries → 'Konzeption'" or "all entries with no Format set
 * → 'Einzelarbeit'".
 *
 * Filter is exact-match on dimensions (case-insensitive), substring on notiz.
 * Target fields: leave a row blank to keep that field unchanged. To clear a
 * field, type a single space then trim — UI offers an explicit "leeren"
 * checkbox per field so empty-string clears are deliberate.
 */
export default function BatchEditPanel() {
  const { t } = useI18n();
  const { stakeholders, projects, activities, formats } = useMasterStore();
  const showToast = useUiStore((s) => s.showToast);
  const teamMembers = useTeamStore((s) => s.members);
  const teamConnected = useTeamStore((s) => s.connected);

  const [expanded, setExpanded] = useState(false);

  // Filter state
  const [filter, setFilter] = useState<BulkFilter>({});
  // Target changes — each field uses an "applyEmpty" flag for explicit clear semantics
  const [chgStakeholder, setChgStakeholder] = useState<string>('');
  const [chgProjekt, setChgProjekt] = useState<string>('');
  const [chgTaetigkeit, setChgTaetigkeit] = useState<string>('');
  const [chgFormat, setChgFormat] = useState<string>('');
  const [chgNotiz, setChgNotiz] = useState<string>('');
  // "Wert übernehmen" toggles — only fields whose checkbox is on are written.
  // This avoids ambiguity between "Feld leer = unverändert" vs. "Feld leeren".
  const [applyStakeholder, setApplyStakeholder] = useState(false);
  const [applyProjekt, setApplyProjekt] = useState(false);
  const [applyTaetigkeit, setApplyTaetigkeit] = useState(false);
  const [applyFormat, setApplyFormat] = useState(false);
  const [applyNotiz, setApplyNotiz] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const setF = <K extends keyof BulkFilter>(key: K, value: BulkFilter[K]) => {
    setFilter((prev) => ({ ...prev, [key]: value || undefined }));
  };

  // Live preview: re-evaluates whenever filter or store contents change
  const matches = useEntriesStore((s) => s.bulkPreview)(filter);

  // Build the BulkChanges payload from the apply-toggles and inputs
  const changes: BulkChanges = useMemo(() => {
    const c: BulkChanges = {};
    if (applyStakeholder) c.stakeholder = chgStakeholder.trim();
    if (applyProjekt) c.projekt = chgProjekt.trim();
    if (applyTaetigkeit) c.taetigkeit = chgTaetigkeit.trim();
    if (applyFormat) c.format = chgFormat.trim();
    if (applyNotiz) c.notiz = chgNotiz; // notiz preserves whitespace/casing
    return c;
  }, [applyStakeholder, applyProjekt, applyTaetigkeit, applyFormat, applyNotiz,
      chgStakeholder, chgProjekt, chgTaetigkeit, chgFormat, chgNotiz]);

  const hasChanges = Object.keys(changes).length > 0;
  const canApply = matches.length > 0 && hasChanges && !running;

  const inputCls = 'select text-sm';
  const previewSlice = matches.slice(0, 5);

  async function handleApply() {
    setRunning(true);
    try {
      const result = await useEntriesStore.getState().bulkUpdateMatching(filter, changes);
      if (result.failed === 0) {
        showToast(`${result.updated} ${t('batch.updatedSuffix')}`, 'success');
      } else {
        showToast(
          `${result.updated} ${t('batch.updatedSuffix')} · ${result.failed} ${t('batch.failedSuffix')}`,
          'warning'
        );
      }
      // Reset apply toggles so the same change isn't accidentally re-applied
      setApplyStakeholder(false);
      setApplyProjekt(false);
      setApplyTaetigkeit(false);
      setApplyFormat(false);
      setApplyNotiz(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('toast.error'), 'error');
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="card p-4 space-y-3" style={{ borderColor: 'rgba(155,142,196,0.3)' }}>
      {/* Header — collapsible (the panel is heavy; default collapsed) */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between gap-3"
        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4" style={{ color: 'var(--neon-violet, #9B8EC4)' }} />
          <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">{t('batch.title')}</h3>
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
            style={{ background: 'rgba(155,142,196,0.1)', color: 'var(--neon-violet, #9B8EC4)' }}
          >
            {t('team.roleAdmin')}
          </span>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>

      {!expanded && (
        <p style={{ color: 'var(--text-muted)' }} className="text-xs italic">
          {t('batch.subtitle')}
        </p>
      )}

      {expanded && (
        <>
          <p style={{ color: 'var(--text-muted)' }} className="text-xs">
            {t('batch.intro')}
          </p>

          {/* ── Filter section ─────────────────────────────────── */}
          <div className="space-y-2">
            <h4 style={{ color: 'var(--text-secondary)' }} className="text-sm font-semibold uppercase tracking-wide">
              {t('batch.filterTitle')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <select className={inputCls} value={filter.stakeholder || ''} onChange={(e) => setF('stakeholder', e.target.value)}>
                <option value="">{t('all.stakeholder')}</option>
                {stakeholders.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className={inputCls} value={filter.projekt || ''} onChange={(e) => setF('projekt', e.target.value)}>
                <option value="">{t('all.projekte')}</option>
                {projects.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select className={inputCls} value={filter.taetigkeit || ''} onChange={(e) => setF('taetigkeit', e.target.value)}>
                <option value="">{t('all.taetigkeiten')}</option>
                {activities.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <select className={inputCls} value={filter.format || ''} onChange={(e) => setF('format', e.target.value)}>
                <option value="">{t('all.formate')}</option>
                {formats.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <input
                type="date"
                className={inputCls}
                value={filter.date_from || ''}
                onChange={(e) => setF('date_from', e.target.value)}
                placeholder={t('filter.from')}
                aria-label={t('filter.from')}
              />
              <input
                type="date"
                className={inputCls}
                value={filter.date_to || ''}
                onChange={(e) => setF('date_to', e.target.value)}
                placeholder={t('filter.to')}
                aria-label={t('filter.to')}
              />
              <input
                type="text"
                className={inputCls}
                value={filter.notiz_contains || ''}
                onChange={(e) => setF('notiz_contains', e.target.value)}
                placeholder={t('batch.notizContains')}
                aria-label={t('batch.notizContains')}
              />
              {teamConnected && teamMembers.length > 0 && (
                <select
                  className={inputCls}
                  value={(filter.member_user_ids || [])[0] || ''}
                  onChange={(e) => setF('member_user_ids', e.target.value ? [e.target.value] : undefined)}
                >
                  <option value="">{t('batch.allMembers')}</option>
                  {teamMembers.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{m.display_name || m.user_id}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* ── Live preview ───────────────────────────────────── */}
          <div
            className="rounded p-3 space-y-2"
            style={{
              background: matches.length > 0 ? 'rgba(110,196,158,0.05)' : 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold" style={{ color: matches.length > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                {matches.length}
              </span>
              <span style={{ color: 'var(--text-secondary)' }} className="text-sm">
                {t('batch.matchedSuffix')}
              </span>
            </div>
            {previewSlice.length > 0 && (
              <div style={{ color: 'var(--text-muted)' }} className="text-xs space-y-0.5">
                {previewSlice.map((e, i) => {
                  const sh = Array.isArray(e.stakeholder) ? e.stakeholder.join(', ') : e.stakeholder;
                  return (
                    <div key={e.id || i}>
                      {formatDateDE(e.date)} · {e._ownerName || '—'} · {sh} → {e.projekt} ({e.taetigkeit})
                      {' · '}
                      <span className="font-mono">{formatDurationHM(getEffectiveDurationMs(e))}</span>
                    </div>
                  );
                })}
                {matches.length > previewSlice.length && (
                  <div style={{ opacity: 0.6 }}>
                    … +{matches.length - previewSlice.length} {t('batch.more')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Target changes ─────────────────────────────────── */}
          <div className="space-y-2">
            <h4 style={{ color: 'var(--text-secondary)' }} className="text-sm font-semibold uppercase tracking-wide">
              {t('batch.changesTitle')}
            </h4>
            <p style={{ color: 'var(--text-muted)' }} className="text-xs">{t('batch.changesHint')}</p>

            <ApplyRow
              label={t('label.stakeholder')}
              checked={applyStakeholder}
              onCheckedChange={setApplyStakeholder}
            >
              <select className={inputCls} value={chgStakeholder} onChange={(e) => setChgStakeholder(e.target.value)} disabled={!applyStakeholder}>
                <option value="">{t('batch.empty')}</option>
                {stakeholders.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </ApplyRow>

            <ApplyRow
              label={t('label.projekt')}
              checked={applyProjekt}
              onCheckedChange={setApplyProjekt}
            >
              <select className={inputCls} value={chgProjekt} onChange={(e) => setChgProjekt(e.target.value)} disabled={!applyProjekt}>
                <option value="">{t('batch.empty')}</option>
                {projects.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </ApplyRow>

            <ApplyRow
              label={t('label.taetigkeit')}
              checked={applyTaetigkeit}
              onCheckedChange={setApplyTaetigkeit}
            >
              <select className={inputCls} value={chgTaetigkeit} onChange={(e) => setChgTaetigkeit(e.target.value)} disabled={!applyTaetigkeit}>
                <option value="">{t('batch.empty')}</option>
                {activities.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </ApplyRow>

            <ApplyRow
              label={t('label.format')}
              checked={applyFormat}
              onCheckedChange={setApplyFormat}
            >
              <select className={inputCls} value={chgFormat} onChange={(e) => setChgFormat(e.target.value)} disabled={!applyFormat}>
                <option value="">{t('batch.empty')}</option>
                {formats.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </ApplyRow>

            <ApplyRow
              label={t('label.notiz')}
              checked={applyNotiz}
              onCheckedChange={setApplyNotiz}
            >
              <input
                type="text"
                className={inputCls}
                value={chgNotiz}
                onChange={(e) => setChgNotiz(e.target.value)}
                placeholder={t('batch.empty')}
                disabled={!applyNotiz}
              />
            </ApplyRow>
          </div>

          {/* ── Apply ──────────────────────────────────────────── */}
          <div className="flex items-center gap-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={!canApply}
              className="btn btn-primary"
              style={{ opacity: canApply ? 1 : 0.4 }}
            >
              {running ? t('ui.loading') : t('batch.apply')}
            </button>
            {!hasChanges && matches.length > 0 && (
              <span style={{ color: 'var(--text-muted)' }} className="text-xs italic">
                {t('batch.noChanges')}
              </span>
            )}
            {matches.length === 0 && (
              <span style={{ color: 'var(--text-muted)' }} className="text-xs italic">
                {t('batch.noMatches')}
              </span>
            )}
          </div>

          {/* Confirmation dialog with summary */}
          <ConfirmDialog
            isOpen={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title={t('batch.confirmTitle')}
            message={
              `${t('batch.confirmIntro')}\n\n` +
              `${matches.length} ${t('batch.matchedSuffix')}\n\n` +
              Object.entries(changes)
                .map(([k, v]) => `${k}: "${v || t('batch.emptyMark')}"`)
                .join('\n')
            }
            confirmText={t('batch.apply')}
            cancelText={t('btn.cancel')}
            onConfirm={handleApply}
            isDanger
          />

          {/* Safety warning when user is about to clear (empty value applied) */}
          {hasChanges && Object.values(changes).some((v) => v === '') && (
            <div
              className="flex items-center gap-2 text-xs"
              style={{ color: 'var(--warning)' }}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('batch.clearWarning')}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Row helper: checkbox toggle + label + inline editor child.
 * Keeps the apply/value relationship visually obvious — the editor is grayed
 * when not applied so it's clear no write happens unless the box is checked.
 */
function ApplyRow({
  label,
  checked,
  onCheckedChange,
  children,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_140px_1fr] gap-2 items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        aria-label={label}
      />
      <span style={{ color: 'var(--text-secondary)' }} className="text-sm">{label}</span>
      <div style={{ opacity: checked ? 1 : 0.5 }}>{children}</div>
    </div>
  );
}
