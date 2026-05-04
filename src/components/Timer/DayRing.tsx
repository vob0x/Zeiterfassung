import React from 'react';
import { useI18n } from '../../i18n';
import { formatDurationHM } from '../../lib/utils';

interface Segment {
  color: string;
  ms: number;
  label?: string;
}

interface DayRingProps {
  /** Per-task colored slices for visual breakdown. We use them only as
   *  hint colors on the inner ring (each running task contributes its
   *  share of the tracked-time slice). */
  segments: Segment[];
  /** Wall-clock-union of today's tracked time (= "Getrackte Zeit"). */
  trackedMs: number;
  /** Brutto presence window: earliest entry start → latest entry end
   *  (extended to "now" if a timer is still running). */
  presenceMs: number;
  /** Daily presence goal — drives the goal-reached state. */
  goalMs: number;
}

/**
 * Two concentric rings — fundamentally a "tracking-coverage" widget:
 *   - Outer  = Präsenzzeit (brutto window: first entry start → last
 *              entry end, extended to "now" by any running timer).
 *              Drives the daily goal indicator: "Ziel erreicht" fires
 *              when actual presence ≥ goalMs.
 *   - Inner  = Getrackte Zeit (wall-clock-union of all intervals where
 *              a timer was active). By definition tracked ≤ presence.
 *              The visible gap between the two rings is the "Lücken"
 *              total — exactly what the gap list below the ring spells
 *              out, so the disclaimer makes sense.
 *
 * Naive "Erfasst Heute" (multitasking sum from the Dashboard) lives in
 * the Dashboard headline — it answers a different question ("how much
 * work effort did I produce") and doesn't belong inside the ring widget,
 * which is about day-shape (presence + coverage).
 */
const DayRing: React.FC<DayRingProps> = ({ segments, trackedMs, presenceMs, goalMs }) => {
  const { t } = useI18n();
  const rOuter = 62;
  const rInner = 48;
  const cx = 78;
  const cy = 78;
  const circOuter = 2 * Math.PI * rOuter;
  const circInner = 2 * Math.PI * rInner;

  // Both rings scale against the daily goal so they're directly comparable.
  // 1.15× cap prevents the arc from overlapping itself on heavy overshoot;
  // the truthful numbers still render in the centre.
  const presencePct = Math.min(presenceMs / Math.max(goalMs, 1), 1.15);
  const trackedPct = Math.min(trackedMs / Math.max(goalMs, 1), 1.15);
  const overGoal = presenceMs >= goalMs;

  const outerOffset = circOuter * (1 - presencePct);

  // Inner ring: by default a single solid arc proportional to trackedMs.
  // If we have segment colors and multiple non-trivial slices, we split
  // the inner arc proportionally — pure visual flavor; the numeric
  // truth is just `trackedMs`.
  const innerArcs: { color: string; dashoffset: number }[] = [];
  const validSegments = segments.filter((s) => s.ms >= 1000);
  if (validSegments.length > 1) {
    const segTotal = validSegments.reduce((s, x) => s + x.ms, 0) || 1;
    let cum = 0;
    for (const seg of validSegments) {
      const p = (seg.ms / segTotal) * trackedPct;
      innerArcs.push({ color: seg.color, dashoffset: circInner * (1 - cum - p) });
      cum += p;
    }
  } else {
    // single solid arc for the tracked total
    innerArcs.push({
      color: 'var(--accent, #C9A962)',
      dashoffset: circInner * (1 - trackedPct),
    });
  }

  const coveragePct =
    presenceMs > 0 ? Math.round((trackedMs / presenceMs) * 100) : 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        width: '100%',
      }}
    >
      <div style={{ position: 'relative', width: 156, height: 156, flexShrink: 0 }}>
        <svg width={156} height={156} viewBox="0 0 156 156">
          {/* Outer background */}
          <circle
            cx={cx}
            cy={cy}
            r={rOuter}
            fill="none"
            stroke="currentColor"
            strokeWidth={7}
            opacity={0.08}
            style={{ color: 'var(--text)' }}
          />
          {/* Outer ring — Präsenzzeit */}
          <circle
            cx={cx}
            cy={cy}
            r={rOuter}
            fill="none"
            stroke={overGoal ? '#6EC49E' : 'var(--text-muted)'}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray={circOuter}
            strokeDashoffset={outerOffset}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: 'stroke-dashoffset 1s ease, stroke 0.4s ease', opacity: 0.85 }}
          />
          {/* Goal marker dot at 12 o'clock */}
          <circle
            cx={cx}
            cy={cy - rOuter}
            r={2.5}
            fill={overGoal ? '#6EC49E' : '#4D4941'}
          />

          {/* Inner background */}
          <circle
            cx={cx}
            cy={cy}
            r={rInner}
            fill="none"
            stroke="currentColor"
            strokeWidth={6}
            opacity={0.06}
            style={{ color: 'var(--text)' }}
          />
          {/* Inner ring — Getrackte Zeit */}
          {innerArcs.map((a, i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={rInner}
              fill="none"
              stroke={a.color}
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={circInner}
              strokeDashoffset={a.dashoffset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: 'stroke-dashoffset 1s ease', opacity: 0.85 }}
            />
          ))}
        </svg>

        {/* Center text — single big number = Präsenzzeit (the goal-relevant
            number), with goal status. Tracked time is shown in the legend
            below the ring with full label. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0,
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: 'var(--text)',
              letterSpacing: '-0.02em',
              lineHeight: 1.05,
            }}
          >
            {formatDurationHM(presenceMs)}
          </span>
          <span
            style={{
              fontSize: 9,
              color: overGoal ? 'var(--success)' : 'var(--text-muted)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            {overGoal ? `✓ ${t('timer.goalReached')}` : `/ ${formatDurationHM(goalMs)}`}
          </span>
        </div>
      </div>

      {/* Labelled legend below the ring — explicit names, no abbreviations,
          no label collision with the Dashboard. */}
      <div
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                border: `2px solid ${overGoal ? '#6EC49E' : 'var(--text-muted)'}`,
                opacity: 0.85,
                flexShrink: 0,
              }}
            />
            <span style={{ color: 'var(--text)' }}>{t('ring.presenceLabel')}</span>
          </span>
          <span
            className="font-mono"
            style={{ color: 'var(--text)', fontWeight: 600 }}
          >
            {formatDurationHM(presenceMs)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: 'var(--accent, #C9A962)',
                opacity: 0.85,
                flexShrink: 0,
              }}
            />
            <span style={{ color: 'var(--text)' }}>{t('ring.trackedLabel')}</span>
          </span>
          <span
            className="font-mono"
            style={{ color: 'var(--text)', fontWeight: 600 }}
          >
            {formatDurationHM(trackedMs)}
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                marginLeft: 6,
                fontWeight: 400,
              }}
            >
              ({coveragePct}%)
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};

export default DayRing;
