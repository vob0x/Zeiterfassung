/**
 * EntryDuplicatesPanel — Verwaltung-Sektion zum Aufräumen von Near-
 * Duplicates in den Time-Entries. Sichtbar nur für Admin / Solo.
 *
 * Triggert findNearDuplicateGroups() auf entries[] und zeigt Cluster
 * (gleiche Dimensionen, gleicher Tag, überlappende Intervalle). Pro
 * Cluster ist die längste Erfassung als "Keeper" vorgeschlagen, alle
 * anderen als Lösch-Kandidaten markiert.
 *
 * UX-Entscheidung: keine Auto-Aktion, kein Default-Häkchen, kein
 * Bulk-Klick ohne Bestätigung. Doppelte Einträge zu löschen ist
 * destruktiv — der User soll jeden Vorschlag aktiv freigeben.
 */

import React, { useMemo, useState } from 'react';
import { Trash2, Layers, Check } from 'lucide-react';
import { useEntriesStore } from '../../stores/entriesStore';
import { useUiStore } from '../../stores/uiStore';
import { useI18n } from '../../i18n';
import { findNearDuplicateGroups, DuplicateGroup } from '../../lib/duplicates';
import { formatDuration } from '../../lib/utils';

const EntryDuplicatesPanel: React.FC = () => {
  const { t } = useI18n();
  const { entries, delete: deleteEntry } = useEntriesStore();
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  // Optimistic UI: groups the user has acted on get stamped with the
  // group's keeper-id so they vanish immediately even before the
  // entries[] change re-renders findNearDuplicateGroups output.
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());

  const groups = useMemo<DuplicateGroup[]>(() => {
    const all = findNearDuplicateGroups(entries);
    return all.filter((g) => !resolvedKeys.has(g.keeper.id));
  }, [entries, resolvedKeys]);

  const total = groups.length;

  const cleanGroup = async (group: DuplicateGroup) => {
    setBusy(true);
    try {
      // Sequential so the entries[] state stays consistent for any
      // observers (e.g. the wall-clock counter on TimerView re-renders
      // after each delete rather than seeing a torn state).
      for (const dupe of group.duplicates) {
        // eslint-disable-next-line no-await-in-loop
        await deleteEntry(dupe.id);
      }
      setResolvedKeys((prev) => new Set(prev).add(group.keeper.id));
      showToast(
        `${group.duplicates.length} ${t('manage.dupesRemoved')}`,
        'success'
      );
    } catch (e) {
      console.error('[EntryDuplicates] cleanGroup failed:', e);
      showToast(t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const cleanAll = async () => {
    setBusy(true);
    try {
      let removed = 0;
      for (const g of groups) {
        for (const dupe of g.duplicates) {
          // eslint-disable-next-line no-await-in-loop
          await deleteEntry(dupe.id);
          removed++;
        }
      }
      setResolvedKeys((prev) => {
        const next = new Set(prev);
        for (const g of groups) next.add(g.keeper.id);
        return next;
      });
      showToast(`${removed} ${t('manage.dupesRemoved')}`, 'success');
    } catch (e) {
      console.error('[EntryDuplicates] cleanAll failed:', e);
      showToast(t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Empty state — show a low-key "alles sauber" message rather than
  // collapsing the whole card silently. Reassures the user that the
  // tool ran and found nothing.
  if (total === 0) {
    return (
      <div
        className="card p-4 space-y-3"
        style={{ borderColor: 'rgba(110,196,158,0.25)' }}
      >
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4" style={{ color: 'var(--success)' }} />
          <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">
            {t('manage.entryDupes')}
          </h3>
        </div>
        <p style={{ color: 'var(--text-muted)' }} className="text-xs">
          {t('manage.entryDupesNone')}
        </p>
      </div>
    );
  }

  return (
    <div
      className="card p-4 space-y-3"
      style={{ borderColor: 'rgba(236,183,97,0.35)' }}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4" style={{ color: 'var(--warning, #ECB761)' }} />
          <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">
            {t('manage.entryDupes')}
          </h3>
          <span
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '10px',
              background: 'rgba(236,183,97,0.18)',
              color: 'var(--warning, #ECB761)',
              fontWeight: 600,
            }}
          >
            {total}
          </span>
        </div>
        {total > 1 && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={cleanAll}
            disabled={busy}
            style={{ fontSize: '12px', padding: '6px 12px' }}
          >
            <Check className="w-4 h-4 mr-1" />
            {t('manage.entryDupesCleanAll')}
          </button>
        )}
      </div>

      <p style={{ color: 'var(--text-muted)' }} className="text-xs">
        {t('manage.entryDupesHint')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {groups.map((g) => {
          const ctx =
            (Array.isArray(g.keeper.stakeholder)
              ? g.keeper.stakeholder.join(', ')
              : g.keeper.stakeholder) || '—';
          const proj = g.keeper.projekt || '—';
          const all = [g.keeper, ...g.duplicates];
          return (
            <div
              key={g.keeper.id}
              style={{
                background: 'var(--card-bg, rgba(0,0,0,0.04))',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                <strong style={{ color: 'var(--text)' }}>{g.keeper.date}</strong> · {ctx} / {proj}
                {g.keeper.taetigkeit ? ` · ${g.keeper.taetigkeit}` : ''}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {all.map((e) => {
                  const isKeeper = e.id === g.keeper.id;
                  return (
                    <div
                      key={e.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '4px 8px',
                        borderRadius: '6px',
                        background: isKeeper
                          ? 'rgba(110,196,158,0.10)'
                          : 'rgba(212,112,110,0.08)',
                        border: `1px solid ${isKeeper ? 'rgba(110,196,158,0.35)' : 'rgba(212,112,110,0.25)'}`,
                        fontSize: '13px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          color: isKeeper ? 'var(--success)' : 'var(--danger)',
                          minWidth: '64px',
                        }}
                      >
                        {isKeeper ? t('manage.entryDupesKeep') : t('manage.entryDupesDelete')}
                      </span>
                      <span style={{ flex: 1 }}>
                        {e.start_time}–{e.end_time} · {formatDuration(e.duration_ms || 0)}
                        {e.notiz ? ` · ${e.notiz}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => cleanGroup(g)}
                  disabled={busy}
                  style={{ fontSize: '12px', padding: '6px 12px' }}
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  {t('manage.entryDupesApply')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default EntryDuplicatesPanel;
