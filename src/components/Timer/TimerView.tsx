import React, { useMemo, useState } from 'react';
import { useTimerStore, findMatchingSlot } from '../../stores/timerStore';
import { useEntriesStore } from '../../stores/entriesStore';
import { useUiStore } from '../../stores/uiStore';
import { useI18n } from '../../i18n';
import { useIsMitarbeiter } from '../../hooks/useRole';
import { formatDurationHM, getTodayISO, getEffectiveDurationMs, computeLiveWallClockMs, computePresenceMs } from '../../lib/utils';
import { isAbsenceEntry } from '../../lib/absences';
import { Plus } from 'lucide-react';
import TimerLane from './TimerLane';
import FuzzySearch from './FuzzySearch';
import ManualEntry from './ManualEntry';
import DayRing from './DayRing';
import RecoveryBanner from './RecoveryBanner';
import TrackingCoverage from './TrackingCoverage';

// Inject orb breathing animation once
const styleId = 'stack-timer-orb-breathe';
if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @keyframes orbBreathe {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      50% { transform: scale(1.35); opacity: 0.15; }
    }
    @keyframes orbPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.07); }
    }
  `;
  document.head.appendChild(style);
}

const TimerView: React.FC = () => {
  const { t } = useI18n();
  const { taskSlots, addSlot, stopAllTimers, getSlotElapsed } = useTimerStore();
  const { entries } = useEntriesStore();
  const showToast = useUiStore((s) => s.showToast);
  // Mitarbeiter sees a focused task list — no DayRing, no goal-reach animations.
  const isMitarbeiter = useIsMitarbeiter();
  // Click-debounce for End-Day. stopAllTimers iterates sequentially through
  // every running slot — that's seconds of awaits where a fast second click
  // would re-fire the whole loop and re-process the same slots, producing
  // duplicate entries. The flag locks the button for the duration.
  const [isEndingDay, setIsEndingDay] = useState(false);
  const handleEndDay = async () => {
    if (isEndingDay) return;
    setIsEndingDay(true);
    try {
      await stopAllTimers();
    } finally {
      setIsEndingDay(false);
    }
  };

  // Today's saved entries
  const todayEntries = useMemo(() => {
    const todayISO = getTodayISO();
    return entries.filter((e) => e.date === todayISO);
  }, [entries]);

  // Today's saved-entry total: naive sum of non-absence durations.
  // Switched from wall-clock-union together with the dashboard headline
  // KPIs so the live counter, the dashboard "Erfasst Heute", and the
  // dimension breakdowns all agree on a single number. Parallel work
  // counts in full — two media calls at 09:00 and 09:15 contribute
  // both their durations.
  const todayTotalMs = useMemo(
    () =>
      todayEntries
        .filter((e) => !isAbsenceEntry(e))
        .reduce((sum, e) => sum + getEffectiveDurationMs(e), 0),
    [todayEntries]
  );

  // Daily goal: 8:24
  const dailyGoalMs = 8 * 3600 * 1000 + 24 * 60 * 1000;

  // (Naive sum of saved + running was the previous DayRing centre value;
  // the ring now shows Präsenz/Getrackt instead, so this value is no
  // longer needed. The naive sum still drives the Dashboard headline,
  // which has its own computation.)

  // Tracked time (wall-clock-union) — drives the INNER ring of DayRing.
  // Stable across stop transitions: when a running timer is saved, the
  // virtual interval is replaced by an identical real entry, union
  // doesn't move.
  const trackedMs = useMemo(() => {
    const runningSlotsForUnion = taskSlots
      .filter((s) => !s.isPaused)
      .map((s) => ({ elapsedMs: getSlotElapsed(s.id), isPaused: false }));
    return computeLiveWallClockMs(todayEntries, runningSlotsForUnion);
  }, [todayEntries, taskSlots, getSlotElapsed]);

  // Brutto presence window — first start to last end (or to "now" if a
  // timer is still running). Drives the OUTER ring and the goal-reached
  // status. Always ≥ trackedMs by construction. The visual gap between
  // the two rings is exactly the un-tracked time inside the day.
  const presenceMs = useMemo(() => {
    const runningSlots = taskSlots
      .filter((s) => !s.isPaused)
      .map((s) => ({ elapsedMs: getSlotElapsed(s.id), isPaused: false }));
    return computePresenceMs(todayEntries, runningSlots);
  }, [todayEntries, taskSlots, getSlotElapsed]);

  const hasActiveTimers = taskSlots.some((s) => !s.isPaused || s.pausedMs > 0);
  const runningTimers = taskSlots.filter((s) => !s.isPaused);
  const pausedTimers = taskSlots.filter((s) => s.isPaused);

  // Segments for DayRing — one per active task + one for saved entries
  const segments = useMemo(() => {
    const segs: { color: string; ms: number; label: string }[] = [];

    // Active timer segments
    taskSlots.forEach((slot) => {
      const elapsed = getSlotElapsed(slot.id);
      if (elapsed > 0) {
        segs.push({
          color: slot.color,
          ms: elapsed,
          label: (slot.stakeholder[0] || slot.projekt || t('stack.untitled')),
        });
      }
    });

    // Saved entries as a single "completed" segment (muted gold)
    if (todayTotalMs > 0) {
      segs.push({
        color: '#4D4941',
        ms: todayTotalMs,
        label: t('timer.saved'),
      });
    }

    return segs;
  }, [taskSlots, todayTotalMs, getSlotElapsed, t]);

  // Fuzzy search → create a new lane (or resume an existing match).
  //
  // Dedup guard: a stray click on the FuzzySearch top-result while a timer is
  // already running used to spawn a second identical lane that started ticking
  // alongside the first one — the source of duplicate entries on stop. Now we
  // detect an exact dimension match against existing slots and either resume
  // the paused match or surface a toast for the running one.
  const handleFuzzySelect = (combo: { stakeholder: string; projekt: string; taetigkeit: string; format: string }) => {
    const dims = {
      stakeholder: [combo.stakeholder],
      projekt: combo.projekt,
      taetigkeit: combo.taetigkeit || 'Produktiv',
      format: combo.format || 'Einzelarbeit',
    };
    const existing = findMatchingSlot(useTimerStore.getState().taskSlots, dims);
    if (existing) {
      if (existing.isPaused) {
        useTimerStore.getState().resumeTimer(existing.id);
        showToast(t('timer.resumedExisting'), 'info');
      } else {
        showToast(t('timer.alreadyRunning'), 'info');
      }
      return;
    }
    addSlot({ ...dims, notiz: '' });
    // Auto-start the new timer
    setTimeout(() => {
      const state = useTimerStore.getState();
      const newest = state.taskSlots[state.taskSlots.length - 1];
      if (newest) {
        useTimerStore.getState().resumeTimer(newest.id);
      }
    }, 50);
  };

  // "+" empty timer — defaults to Einzelarbeit / Produktiv per UX request.
  // Dedup: if the user already has an empty unstarted timer, focus on it
  // instead of stacking yet another empty lane.
  const handleAddEmpty = () => {
    const dims = { stakeholder: [], projekt: '', taetigkeit: 'Produktiv', format: 'Einzelarbeit' };
    const existing = findMatchingSlot(useTimerStore.getState().taskSlots, dims);
    if (existing) {
      if (existing.isPaused) {
        useTimerStore.getState().resumeTimer(existing.id);
        showToast(t('timer.resumedExisting'), 'info');
      } else {
        showToast(t('timer.alreadyRunning'), 'info');
      }
      return;
    }
    addSlot({ ...dims, notiz: '' });
    // Auto-start
    setTimeout(() => {
      const state = useTimerStore.getState();
      const newest = state.taskSlots[state.taskSlots.length - 1];
      if (newest) {
        useTimerStore.getState().resumeTimer(newest.id);
      }
    }, 50);
  };

  return (
    <div className="py-4">
      {/* Recovery banner — surfaces stop attempts that the journal couldn't
          verify landed in entries[]. Self-hides when there's nothing open
          (and is the canonical user-facing UI for the timer-stop journal,
          paired with lib/stopJournal.ts). */}
      <RecoveryBanner />

      {/* Mitarbeiter: single full-width column (no DayRing / goal sidebar).
          Admin / solo: 2-column grid with DayRing on the right. */}
      <div
        className={isMitarbeiter ? '' : 'grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6'}
        style={{ alignItems: 'start' }}
      >
        {/* ── Left Column: Stack Timer ── */}
        <div>
          {/* Header */}
          <div className="flex items-center justify-between mb-4" style={{ padding: '0 4px' }}>
            <div>
              <div className="flex items-center gap-2">
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: runningTimers.length > 0 ? 'var(--success)' : 'var(--text-muted)',
                    boxShadow: runningTimers.length > 0 ? '0 0 8px rgba(110,196,158,0.5)' : 'none',
                  }}
                />
                <div
                  className="font-display font-semibold"
                  style={{ fontSize: '16px', color: 'var(--text)', letterSpacing: '-0.01em' }}
                >
                  {t('timer.tasks')}
                </div>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0 15px' }}>
                {runningTimers.length === 0
                  ? t('timer.noActive')
                  : runningTimers.length === 1
                    ? t('timer.oneActive')
                    : t('timer.nActive').replace('{{n}}', String(runningTimers.length))}
                {pausedTimers.length > 0 && ` · ${pausedTimers.length} ${t('timer.paused')}`}
              </p>
            </div>

            {hasActiveTimers && (
              <button
                onClick={handleEndDay}
                disabled={isEndingDay}
                className="px-3 py-1 text-xs font-semibold rounded transition-all"
                style={{
                  background: 'rgba(212, 112, 110, 0.08)',
                  color: 'var(--danger)',
                  border: '1px solid rgba(212, 112, 110, 0.18)',
                  cursor: isEndingDay ? 'wait' : 'pointer',
                  opacity: isEndingDay ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (isEndingDay) return;
                  e.currentTarget.style.background = 'rgba(212, 112, 110, 0.15)';
                }}
                onMouseLeave={(e) => {
                  if (isEndingDay) return;
                  e.currentTarget.style.background = 'rgba(212, 112, 110, 0.08)';
                }}
              >
                {isEndingDay ? t('timer.endingDay') : t('timer.endDay')}
              </button>
            )}
          </div>

          {/* Search + "+" Button */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
            <div style={{ flex: 1 }}>
              <FuzzySearch onSelect={handleFuzzySelect} />
            </div>
            {/* Start empty timer button */}
            {taskSlots.length < 8 && (
              <button
                onClick={handleAddEmpty}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '12px',
                  border: '1.5px solid var(--border)',
                  background: 'rgba(255,255,255,0.02)',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--success)';
                  e.currentTarget.style.color = 'var(--success)';
                  e.currentTarget.style.background = 'rgba(110,196,158,0.06)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.color = 'var(--text-muted)';
                  e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                }}
                title={t('stack.startEmpty')}
              >
                <Plus className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Timer Lanes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {/* Running timers first */}
            {runningTimers.map((slot) => (
              <TimerLane key={slot.id} slot={slot} />
            ))}

            {/* Separator if both running and paused */}
            {pausedTimers.length > 0 && runningTimers.length > 0 && (
              <div
                style={{
                  fontSize: '9px',
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  padding: '6px 4px 2px',
                }}
              >
                {t('timer.paused')}
              </div>
            )}

            {/* Paused timers */}
            {pausedTimers.filter((s) => getSlotElapsed(s.id) > 0).map((slot) => (
              <TimerLane key={slot.id} slot={slot} />
            ))}

            {/* New (empty, no time yet) timers */}
            {pausedTimers.filter((s) => getSlotElapsed(s.id) === 0).map((slot) => (
              <TimerLane key={slot.id} slot={slot} />
            ))}
          </div>

          {/* Empty state */}
          {taskSlots.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '48px 20px',
                color: 'var(--text-muted)',
                borderRadius: '14px',
                border: '1px dashed var(--border)',
                marginTop: '6px',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.4 }}>⚡</div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('timer.startHint')}
              </div>
              <div style={{ fontSize: '12px', marginTop: '6px', lineHeight: 1.7 }}>
                {t('stack.searchOrPlus')}
              </div>
            </div>
          )}

          {/* Manual Entry */}
          <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border)' }}>
            <ManualEntry embedded />
          </div>
        </div>

        {/* ── Right Column: DayRing + Saved Log — admin / solo only ── */}
        {!isMitarbeiter && (
        <div className="lg:sticky lg:top-20" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* DayRing */}
          <div
            className="card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '24px 16px',
            }}
          >
            <DayRing
              segments={segments}
              trackedMs={trackedMs}
              presenceMs={presenceMs}
              goalMs={dailyGoalMs}
            />

            {/* Tracking-Coverage — surfaces gaps in today's tracking so
                the user can see at-a-glance whether they forgot to start
                a timer somewhere. Hides when there's nothing tracked yet. */}
            <div style={{ width: '100%' }}>
              <TrackingCoverage />
            </div>

            {/* Active lanes mini-summary */}
            {taskSlots.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  marginTop: '14px',
                  width: '100%',
                }}
              >
                {taskSlots.map((slot) => {
                  const running = !slot.isPaused;
                  const elapsed = getSlotElapsed(slot.id);
                  const label =
                    (slot.stakeholder[0]) ||
                    slot.projekt ||
                    t('stack.untitled');
                  return (
                    <div
                      key={slot.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '10px',
                        background: running ? `${slot.color}0A` : 'transparent',
                        border: `1px solid ${running ? slot.color + '30' : 'var(--border)'}`,
                        fontSize: '10px',
                      }}
                    >
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: slot.color,
                          opacity: running ? 1 : 0.4,
                          boxShadow: running ? `0 0 6px ${slot.color}40` : 'none',
                        }}
                      />
                      <span
                        style={{
                          color: running ? 'var(--text)' : 'var(--text-muted)',
                          maxWidth: '60px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 500,
                        }}
                      >
                        {label}
                      </span>
                      <span
                        className="font-mono"
                        style={{
                          color: running ? slot.color : 'var(--text-muted)',
                          fontSize: '9px',
                        }}
                      >
                        {formatDurationHM(elapsed)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Today saved log */}
          {todayEntries.length > 0 && (
            <div
              className="card"
              style={{ padding: '14px 16px' }}
            >
              <div
                style={{
                  fontSize: '9px',
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: '8px',
                }}
              >
                {t('timer.savedToday')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {todayEntries.slice(-6).reverse().map((entry, i) => {
                  const sh = Array.isArray(entry.stakeholder)
                    ? entry.stakeholder[0]
                    : entry.stakeholder;
                  return (
                    <div
                      key={entry.id || i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '4px 0',
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        fontSize: '11px',
                      }}
                    >
                      <span style={{ color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sh || '—'} <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>›</span> {entry.projekt || '—'}
                      </span>
                      <span className="font-mono" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                        {formatDurationHM(entry.duration_ms)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Keyboard hints */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '10px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border)',
              fontSize: '10px',
              color: 'var(--text-muted)',
              lineHeight: 1.7,
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '3px' }}>
              {t('timer.shortcuts')}
            </div>
            <div>⌨ {t('timer.shortcutType')}</div>
            <div><span style={{ color: 'var(--success)' }}>+</span> {t('timer.shortcutEmpty')}</div>
            <div>🔵 {t('timer.shortcutOrb')}</div>
            <div>■ {t('timer.shortcutStop')}</div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default TimerView;
