/**
 * EntryDuplicatesPanel — Verwaltung-Sektion zum Aufräumen von Near-
 * Duplicates in den Time-Entries. Sichtbar nur für Admin / Solo.
 *
 * findNearDuplicateGroups gibt jetzt PAARE zurück (kein transitives
 * Clustering mehr — siehe lib/duplicates.ts). Pro Paar ist die längere
 * Erfassung als Default-Keeper vorgeschlagen, aber der User kann per
 * Klick die Auswahl umkehren. Erst wenn er „Duplikat entfernen" drückt,
 * wird tatsächlich gelöscht.
 *
 * UX-Entscheidung: keine Auto-Aktion. Doppelte Einträge zu löschen ist
 * destruktiv — der User soll jeden Vorschlag aktiv bestätigen UND
 * jederzeit umkehren können. Default-Vorschlag spart Klicks im
 * Standardfall, blockiert aber nicht den Edge-Case wo der User den
 * KÜRZEREN behalten will.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Trash2, Layers, Check } from 'lucide-react';
import { useEntriesStore } from '../../stores/entriesStore';
import { useUiStore } from '../../stores/uiStore';
import { useI18n } from '../../i18n';
import { findNearDuplicateGroups, DuplicateGroup } from '../../lib/duplicates';
import { formatDuration } from '../../lib/utils';
import type { TimeEntry } from '@/types';

/** Stable identifier for a pair (for state-keying and resolution tracking). */
function pairKey(g: DuplicateGroup): string {
  // Sort the two entry-ids so the key doesn't depend on which is keeper.
  const ids = [g.keeper.id, ...g.duplicates.map((d) => d.id)].sort();
  return ids.join('|');
}

const EntryDuplicatesPanel: React.FC = () => {
  const { t } = useI18n();
  const { entries, delete: deleteEntry } = useEntriesStore();
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  // resolvedKeys: pairs the user already acted on (or skipped) — drop
  // them from the active list mid-session.
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());
  // toDeleteByKey: per-pair, which entry-id the user has marked for
  // deletion. Initialised from the algorithm's suggestion (the shorter
  // one) and updatable by clicking the entries.
  const [toDeleteByKey, setToDeleteByKey] = useState<Record<string, string>>({});

  const groups = useMemo<DuplicateGroup[]>(() => {
    const all = findNearDuplicateGroups(entries);
    return all.filter((g) => !resolvedKeys.has(pairKey(g)));
  }, [entries, resolvedKeys]);

  // Seed default selection (= algorithm's suggestion) for newly-appeared
  // pairs. We don't overwrite existing selections so a mid-session toggle
  // by the user persists.
  useEffect(() => {
    setToDeleteByKey((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of groups) {
        const k = pairKey(g);
        if (!(k in next)) {
          next[k] = g.duplicates[0]?.id || '';
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups]);

  const total = groups.length;

  const toggleSelection = (g: DuplicateGroup, entryId: string) => {
    const k = pairKey(g);
    const all = [g.keeper, ...g.duplicates];
    if (all.length !== 2) return; // pair-only invariant
    setToDeleteByKey((prev) => ({ ...prev, [k]: entryId }));
  };

  const applyOne = async (g: DuplicateGroup) => {
    const k = pairKey(g);
    const idToDelete = toDeleteByKey[k];
    if (!idToDelete) return;
    setBusy(true);
    try {
      await deleteEntry(idToDelete);
      setResolvedKeys((prev) => new Set(prev).add(k));
      showToast(`1 ${t('manage.dupesRemoved')}`, 'success');
    } catch (e) {
      console.error('[EntryDuplicates] applyOne failed:', e);
      showToast(t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const applyAll = async () => {
    setBusy(true);
    try {
      let removed = 0;
      for (const g of groups) {
        const k = pairKey(g);
        const idToDelete = toDeleteByKey[k];
        if (!idToDelete) continue;
        // eslint-disable-next-line no-await-in-loop
        await deleteEntry(idToDelete);
        removed++;
      }
      setResolvedKeys((prev) => {
        const next = new Set(prev);
        for (const g of groups) next.add(pairKey(g));
        return next;
      });
      showToast(`${removed} ${t('manage.dupesRemoved')}`, 'success');
    } catch (e) {
      console.error('[EntryDuplicates] applyAll failed:', e);
      showToast(t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const skipPair = (g: DuplicateGroup) => {
    setResolvedKeys((prev) => new Set(prev).add(pairKey(g)));
  };

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
            onClick={applyAll}
            disabled={busy}
            style={{ fontSize: '12px', padding: '6px 12px' }}
          >
            <Check className="w-4 h-4 mr-1" />
            {t('manage.entryDupesApplyAll')}
          </button>
        )}
      </div>

      <p style={{ color: 'var(--text-muted)' }} className="text-xs">
        {t('manage.entryDupesHintV2')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {groups.map((g) => {
          const all: TimeEntry[] = [g.keeper, ...g.duplicates];
          if (all.length !== 2) return null;
          const k = pairKey(g);
          const selectedDeleteId = toDeleteByKey[k] || g.duplicates[0]?.id;
          const ctx =
            (Array.isArray(g.keeper.stakeholder)
              ? g.keeper.stakeholder.join(', ')
              : g.keeper.stakeholder) || '—';
          const proj = g.keeper.projekt || '—';

          return (
            <div
              key={k}
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
                {g.keeper.notiz ? ` · ${g.keeper.notiz}` : ''}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {all.map((e) => {
                  const isSelectedForDelete = e.id === selectedDeleteId;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => toggleSelection(g, e.id)}
                      disabled={busy}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        background: isSelectedForDelete
                          ? 'rgba(212,112,110,0.10)'
                          : 'rgba(110,196,158,0.10)',
                        border: `1px solid ${isSelectedForDelete ? 'rgba(212,112,110,0.45)' : 'rgba(110,196,158,0.45)'}`,
                        fontSize: '13px',
                        cursor: busy ? 'wait' : 'pointer',
                        textAlign: 'left',
                        color: 'var(--text)',
                        transition: 'all 0.15s',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: isSelectedForDelete ? 'var(--danger)' : 'var(--success)',
                          minWidth: '70px',
                        }}
                      >
                        {isSelectedForDelete ? `▸ ${t('manage.entryDupesDelete')}` : t('manage.entryDupesKeep')}
                      </span>
                      <span style={{ flex: 1 }}>
                        {e.start_time}–{e.end_time} · {formatDuration(e.duration_ms || 0)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => skipPair(g)}
                  disabled={busy}
                  style={{ fontSize: '12px', padding: '6px 12px' }}
                >
                  {t('manage.entryDupesSkip')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => applyOne(g)}
                  disabled={busy || !selectedDeleteId}
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
