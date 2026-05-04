/**
 * DeletedEntriesPanel — Verwaltung-Sektion zum Wiederherstellen von
 * versehentlich gelöschten Einträgen aus den Soft-Delete-Tombstones.
 *
 * Triggert manuelles Laden (kein Auto-Pull bei Mount, weil das eine
 * extra Supabase-Query ist und nicht jeder Verwaltungs-Aufruf eine
 * Recovery-Session ist). Beim Klick auf „Gelöschte Einträge laden"
 * werden die Tombstones der letzten 30 Tage geholt und angezeigt.
 *
 * Pro Eintrag: Wiederherstellen-Button setzt deleted_at = NULL in
 * Supabase und fügt den Eintrag wieder in local entries[] ein. Der
 * nächste Pull synchronisiert das auf alle anderen Geräte.
 */

import React, { useState } from 'react';
import { Trash2, RotateCcw, Search } from 'lucide-react';
import {
  fetchDeletedEntries,
  restoreDeletedEntry,
} from '../../stores/entriesStore';
import { useUiStore } from '../../stores/uiStore';
import { useI18n } from '../../i18n';
import type { TimeEntry } from '@/types';
import { formatDuration } from '../../lib/utils';

const DeletedEntriesPanel: React.FC = () => {
  const { t } = useI18n();
  const showToast = useUiStore((s) => s.showToast);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [hasLoaded, setHasLoaded] = useState(false);
  const [deleted, setDeleted] = useState<TimeEntry[]>([]);

  const loadDeleted = async () => {
    setLoading(true);
    try {
      const r = await fetchDeletedEntries(30);
      if (r.error) {
        showToast(r.error, 'error');
      } else {
        setDeleted(r.entries);
        setHasLoaded(true);
        if (r.entries.length === 0) {
          showToast(t('manage.deletedNone'), 'info');
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('toast.error'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const restoreOne = async (entry: TimeEntry) => {
    setRestoring((prev) => new Set(prev).add(entry.id));
    try {
      const r = await restoreDeletedEntry(entry);
      if (r.error) {
        showToast(r.error, 'error');
      } else {
        // Drop from list optimistically.
        setDeleted((prev) => prev.filter((e) => e.id !== entry.id));
        showToast(t('manage.deletedRestored'), 'success');
      }
    } finally {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  };

  const restoreAll = async () => {
    for (const e of deleted) {
      // eslint-disable-next-line no-await-in-loop
      await restoreOne(e);
    }
  };

  return (
    <div
      className="card p-4 space-y-3"
      style={{ borderColor: 'rgba(212,112,110,0.3)' }}
    >
      <div className="flex items-center gap-2">
        <Trash2 className="w-4 h-4" style={{ color: 'var(--danger)' }} />
        <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">
          {t('manage.deletedRecover')}
        </h3>
        {hasLoaded && deleted.length > 0 && (
          <span
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '10px',
              background: 'rgba(212,112,110,0.18)',
              color: 'var(--danger)',
              fontWeight: 600,
            }}
          >
            {deleted.length}
          </span>
        )}
      </div>
      <p style={{ color: 'var(--text-muted)' }} className="text-xs">
        {t('manage.deletedRecoverHint')}
      </p>

      {!hasLoaded && (
        <button
          type="button"
          className="btn btn-secondary flex items-center gap-2"
          onClick={loadDeleted}
          disabled={loading}
          style={{ opacity: loading ? 0.5 : 1 }}
        >
          <Search className="w-4 h-4" />
          {loading ? t('ui.loading') : t('manage.deletedLoad')}
        </button>
      )}

      {hasLoaded && deleted.length === 0 && (
        <div style={{ color: 'var(--text-muted)' }} className="text-xs italic">
          {t('manage.deletedNone')}
        </div>
      )}

      {deleted.length > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {deleted.map((e) => {
              const ctx =
                (Array.isArray(e.stakeholder)
                  ? e.stakeholder.join(', ')
                  : e.stakeholder) || '—';
              const isRestoring = restoring.has(e.id);
              const deletedAt = e.deleted_at
                ? new Date(e.deleted_at).toLocaleString('de-CH', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })
                : '?';
              return (
                <div
                  key={e.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 10px',
                    background: 'var(--card-bg, rgba(0,0,0,0.04))',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {e.date} · {e.start_time}–{e.end_time} ·{' '}
                      {formatDuration(e.duration_ms || 0)}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {ctx} / {e.projekt || '—'}
                      {e.taetigkeit ? ` · ${e.taetigkeit}` : ''}
                      {e.notiz ? ` · ${e.notiz}` : ''}
                    </div>
                    <div
                      style={{
                        fontSize: '10px',
                        color: 'var(--text-muted)',
                        marginTop: '2px',
                      }}
                    >
                      {t('manage.deletedAt')} {deletedAt}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => restoreOne(e)}
                    disabled={isRestoring}
                    style={{ fontSize: '12px', padding: '6px 12px' }}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    {isRestoring ? t('ui.loading') : t('manage.deletedRestore')}
                  </button>
                </div>
              );
            })}
          </div>

          {deleted.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={restoreAll}
                disabled={restoring.size > 0}
                style={{ fontSize: '12px', padding: '6px 12px' }}
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                {t('manage.deletedRestoreAll')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default DeletedEntriesPanel;
