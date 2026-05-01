/**
 * RecoveryBanner — surfaces stop-journal entries that we couldn't verify
 * landed in entries[]. The user one-click restores or discards each one.
 *
 * The component is the visible half of the stop-journal mechanism (see
 * lib/stopJournal.ts). It mounts inside TimerView; on every render of
 * TimerView it pulls the current entries[] and asks getRecoveryCandidates
 * which journal rows truly need attention. Already-saved attempts are
 * silently auto-confirmed inside that helper, so the banner only ever
 * shows the genuine recovery cases.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { useEntriesStore } from '../../stores/entriesStore';
import { useUiStore } from '../../stores/uiStore';
import { useI18n } from '../../i18n';
import {
  StopJournalEntry,
  getRecoveryCandidates,
  removeStopAttempt,
  confirmStopSucceeded,
} from '../../lib/stopJournal';
import { formatDuration } from '../../lib/utils';

const RecoveryBanner: React.FC = () => {
  const { t } = useI18n();
  const { entries, add: addEntry } = useEntriesStore();
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Local "dismissed-this-session" set so users can hide individual rows
  // mid-session without us re-running getRecoveryCandidates and resurrecting
  // them on the next render. Persistent dismissal goes through removeStopAttempt.
  const [dismissedThisSession, setDismissedThisSession] = useState<Set<string>>(new Set());

  // Recompute every time entries[] changes — successful restores remove
  // candidates from the journal automatically.
  const candidates = useMemo<StopJournalEntry[]>(() => {
    const all = getRecoveryCandidates(entries);
    return all.filter((c) => !dismissedThisSession.has(c.journalId));
  }, [entries, dismissedThisSession]);

  const restoreOne = useCallback(
    async (attempt: StopJournalEntry) => {
      setBusy((prev) => new Set(prev).add(attempt.journalId));
      try {
        await addEntry({ ...attempt.payload, id: attempt.entryId });
        confirmStopSucceeded(attempt.journalId);
        showToast(t('recovery.restored'), 'success');
      } catch (e) {
        console.error('[RecoveryBanner] restore failed:', e);
        showToast(t('recovery.restoreFailed'), 'error');
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(attempt.journalId);
          return next;
        });
      }
    },
    [addEntry, showToast, t]
  );

  const discardOne = useCallback(
    (attempt: StopJournalEntry) => {
      removeStopAttempt(attempt.journalId);
      // Optimistic UI: also drop from session set so the banner row vanishes
      // immediately even if the journal write is slow.
      setDismissedThisSession((prev) => new Set(prev).add(attempt.journalId));
    },
    []
  );

  const restoreAll = useCallback(async () => {
    for (const c of candidates) {
      // Sequential await — same reason as stopAllTimers: we don't want
      // parallel addEntry calls to race on the local entries[] state.
      // eslint-disable-next-line no-await-in-loop
      await restoreOne(c);
    }
  }, [candidates, restoreOne]);

  const discardAll = useCallback(() => {
    for (const c of candidates) discardOne(c);
  }, [candidates, discardOne]);

  if (candidates.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        background: 'rgba(236, 183, 97, 0.10)', // warning-tinted, low intensity
        border: '1px solid var(--warning, #ECB761)',
        borderRadius: '12px',
        padding: '14px 16px',
        marginBottom: '16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <AlertTriangle
          size={20}
          color="var(--warning, #ECB761)"
          style={{ flexShrink: 0, marginTop: '2px' }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {t('recovery.title').replace('{count}', String(candidates.length))}
          </div>
          <div
            style={{
              fontSize: '13px',
              color: 'var(--text-muted)',
              marginBottom: '12px',
            }}
          >
            {t('recovery.subtitle')}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {candidates.map((c) => {
              const ctx =
                (Array.isArray(c.payload.stakeholder)
                  ? c.payload.stakeholder.join(', ')
                  : c.payload.stakeholder) || '—';
              const proj = c.payload.projekt || '—';
              const isBusy = busy.has(c.journalId);
              return (
                <div
                  key={c.journalId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 10px',
                    background: 'var(--card-bg, rgba(0,0,0,0.04))',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    flexWrap: 'wrap',
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
                      {c.payload.date} · {c.payload.start_time}–{c.payload.end_time} ·{' '}
                      {formatDuration(c.payload.duration_ms)}
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
                      {ctx} / {proj}
                      {c.payload.notiz ? ` · ${c.payload.notiz}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ padding: '6px 10px', fontSize: '12px' }}
                      onClick={() => restoreOne(c)}
                      disabled={isBusy}
                      title={t('recovery.restore')}
                    >
                      <RotateCcw size={14} style={{ marginRight: '4px' }} />
                      {t('recovery.restore')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '6px 10px', fontSize: '12px' }}
                      onClick={() => discardOne(c)}
                      disabled={isBusy}
                      title={t('recovery.discard')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {candidates.length > 1 && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                marginTop: '12px',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '12px' }}
                onClick={discardAll}
              >
                {t('recovery.discardAll')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: '6px 12px', fontSize: '12px' }}
                onClick={restoreAll}
              >
                {t('recovery.restoreAll')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RecoveryBanner;
