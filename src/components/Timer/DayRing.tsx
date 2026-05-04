import React from 'react';
import { useI18n } from '../../i18n';
import { formatDurationHM } from '../../lib/utils';

interface Segment {
  color: string;
  ms: number;
  label?: string;
}

interface DayRingProps {
  /** Per-task colored slices for the inner ring (Erfasst / naive sum). */
  segments: Segment[];
  /** Total naive sum (= sum of segments.ms). Drives the inner ring fill. */
  totalMs: number;
  /** Wall-clock-union of today's tracking. Drives the outer ring fill. */
  wallclockMs: number;
  /** Daily presence goal — the outer ring fills proportionally to this. */
  goalMs: number;
}

/**
 * Two concentric rings:
 *   - Outer = Präsenzzeit (wall-clock-union). Fills toward the daily goal.
 *     Hits the "✓ Ziel erreicht" state when actual physical work meets
 *     the goal, NOT when the naive sum coincidentally crosses (which
 *     could happen via heavy multitasking with little actual presence).
 *   - Inner = Erfasste Zeit (naive sum). Coloured per-task segments.
 *     Same circumference as outer, so visually the inner ring filling
 *     "past" the outer arc means the user did more multitasking than
 *     wall-clock time would suggest. That's the visual story we want
 *     the user to read at a glance.
 *
 * Both rings use the same goal scale for direct visual comparison.
 * The naive total can exceed the goal — we allow up to ~15% overshoot
 * before clipping; in extreme multitasking days the inner ring just
 * looks "fuller than full", which is the right signal.
 */
const DayRing: React.FC<DayRingProps> = ({ segments, totalMs, wallclockMs, goalMs }) => {
  const { t } = useI18n();
  // Outer ring (Präsenz)
  const rOuter = 62;
  // Inner ring (Erfasst) — leave breathing room so the two are clearly
  // separated visually.
  const rInner = 48;
  const cx = 78;
  const cy = 78;
  const circOuter = 2 * Math.PI * rOuter;
  const circInner = 2 * Math.PI * rInner;

  // Scaling: cap visual fill at 1.15 of goal to prevent the arc from
  // swallowing itself on extreme overshoot, but the actual numeric
  // values still render truthfully in the centre.
  const wallclockPct = Math.min(wallclockMs / goalMs, 1.15);
  const naivePct = Math.min(totalMs / goalMs, 1.15);
  const overGoal = wallclockMs >= goalMs;

  // Outer ring is a single solid arc — wall-clock has no per-task
  // breakdown (overlapping tasks already merged into one interval).
  const outerOffset = circOuter * (1 - wallclockPct);

  // Inner ring: stack segments around the circle proportional to each
  // segment's share of the naive total. We treat the goal as the scale
  // so 8:24 worth of work fills the ring; multitasking past that just
  // visually overshoots.
  const innerArcs: { color: string; dashoffset: number }[] = [];
  let cum = 0;
  const totalForScale = Math.max(totalMs, 1);
  segments.forEach((seg) => {
    const p = (seg.ms / totalForScale) * naivePct;
    innerArcs.push({ color: seg.color, dashoffset: circInner * (1 - cum - p) });
    cum += p;
  });

  return (
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
        {/* Goal marker dot at 12 o'clock — indicates 100% on outer ring */}
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
        {/* Inner ring — Erfasste Zeit, segmented per task */}
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
        {/* Big number = naive Erfasst (matches Dashboard headline) */}
        <span
          className="font-mono"
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: 'var(--text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
          }}
        >
          {formatDurationHM(totalMs)}
        </span>
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          {t('ring.recorded')}
        </span>
        {/* Smaller line = wall-clock Präsenz, with goal-reached feedback */}
        <span
          className="font-mono"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: overGoal ? 'var(--success)' : 'var(--text-muted)',
            marginTop: 4,
            letterSpacing: '-0.01em',
          }}
        >
          {formatDurationHM(wallclockMs)}
          <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.7 }}>
            / {formatDurationHM(goalMs)}
          </span>
        </span>
        <span
          style={{
            fontSize: 9,
            color: overGoal ? 'var(--success)' : 'var(--text-muted)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          {overGoal ? `✓ ${t('timer.goalReached')}` : t('ring.presence')}
        </span>
      </div>
    </div>
  );
};

export default DayRing;
