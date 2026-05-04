import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { formatHoursAdaptive } from '../../lib/utils';
import InfoTooltip from '../UI/InfoTooltip';

interface KpiCardsProps {
  today: number;   // hours (float)
  period: number;  // hours (float)
  entries: number;  // count
  /** Optional override for the "Heute" label (e.g. "Präsenzzeit Heute"). */
  todayLabel?: string;
  /**
   * Optional override for the period label. Used by the Dashboard to switch
   * between "Präsenzzeit Zeitraum" (no filter) and "Arbeit für X"
   * (filter active).
   */
  periodLabel?: string;
  onDrillDown?: () => void;
}

/**
 * Animated counter that formats adaptively:
 * - hours mode (default): < 1h → "45min", >= 1h → "2.3h"
 * - count mode (suffix=""): just the number
 */
function AnimatedValue({ value, mode = 'hours' }: { value: number; mode?: 'hours' | 'count' }) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const start = displayValue;
    const end = value;
    const duration = 600;
    const startTime = Date.now();

    const animate = () => {
      const now = Date.now();
      const progress = Math.min((now - startTime) / duration, 1);
      const current = start + (end - start) * progress;
      setDisplayValue(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    animate();
  }, [value]);

  if (mode === 'count') {
    return <span>{Math.round(displayValue)}</span>;
  }

  return <span>{formatHoursAdaptive(displayValue)}</span>;
}

export function KpiCards({ today, period, entries, todayLabel, periodLabel, onDrillDown }: KpiCardsProps) {
  const { t } = useI18n();
  const cardCursor = onDrillDown ? 'pointer' : undefined;
  const todayLbl = todayLabel || t('kpi.today');
  const periodLbl = periodLabel || t('period.label');

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Today's Hours */}
      <div
        className="relative overflow-hidden rounded-lg backdrop-blur-xl border p-6 shadow-2xl"
        style={{ background: 'linear-gradient(to bottom right, rgba(var(--surface-rgb), 0.8), rgba(var(--surface-rgb), 0.8))', borderColor: 'rgba(201, 169, 98, 0.3)', cursor: cardCursor }}
        onClick={onDrillDown}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom right, rgba(201,169,98,0.05), rgba(110,196,158,0.05))' }} />
        <div className="relative z-10">
          <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
            {todayLbl}
            <InfoTooltip text={t('kpi.tooltipToday')} />
          </div>
          <div className="text-4xl font-bold" style={{ color: 'var(--neon-cyan)' }}>
            <AnimatedValue value={today} mode="hours" />
          </div>
          <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{t('kpi.todaySubtitle')}</div>
        </div>
      </div>

      {/* Period Hours */}
      <div
        className="relative overflow-hidden rounded-lg backdrop-blur-xl border p-6 shadow-2xl"
        style={{ background: 'linear-gradient(to bottom right, rgba(var(--surface-rgb), 0.8), rgba(var(--surface-rgb), 0.8))', borderColor: 'rgba(110, 196, 158, 0.3)', cursor: cardCursor }}
        onClick={onDrillDown}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom right, rgba(110,196,158,0.05), rgba(91,164,217,0.05))' }} />
        <div className="relative z-10">
          <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
            {periodLbl}
            <InfoTooltip text={t('kpi.tooltipPeriod')} />
          </div>
          <div className="text-4xl font-bold" style={{ color: '#6EC49E' }}>
            <AnimatedValue value={period} mode="hours" />
          </div>
          <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{t('kpi.periodSubtitle')}</div>
        </div>
      </div>

      {/* Entry Count */}
      <div
        className="relative overflow-hidden rounded-lg backdrop-blur-xl border p-6 shadow-2xl"
        style={{ background: 'linear-gradient(to bottom right, rgba(var(--surface-rgb), 0.8), rgba(var(--surface-rgb), 0.8))', borderColor: 'rgba(155, 142, 196, 0.3)', cursor: cardCursor }}
        onClick={onDrillDown}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom right, rgba(155,142,196,0.05), rgba(212,112,110,0.05))' }} />
        <div className="relative z-10">
          <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
            {t('kpi.entries')}
            <InfoTooltip text={t('kpi.tooltipEntries')} />
          </div>
          <div className="text-4xl font-bold" style={{ color: '#9B8EC4' }}>
            <AnimatedValue value={entries} mode="count" />
          </div>
          <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{t('kpi.entriesSubtitle')}</div>
        </div>
      </div>
    </div>
  );
}
