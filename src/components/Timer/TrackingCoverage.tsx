/**
 * TrackingCoverage — surfaces gaps in today's tracking so the user can
 * decide whether to backfill.
 *
 * Why this exists: the wall-clock-union of an unfinished tracking day
 * is the metric "for how many minutes of the day was a tracker active".
 * If the user remembers being at work 9 hours but only has 6h45 of
 * tracker-active time, they have ~2h15 of unaccounted work — typically
 * because they forgot to start a timer or already had something running
 * and didn't switch. Showing the gaps inline makes that gap visible
 * (and recoverable) without confronting the user with two competing
 * top-level numbers.
 */

import React, { useMemo, useState } from 'react';
import { Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { useEntriesStore } from '../../stores/entriesStore';
import { useI18n } from '../../i18n';
import { findTrackingGaps, getTodayISO, formatDuration } from '../../lib/utils';

const TrackingCoverage: React.FC = () => {
  const { t } = useI18n();
  const { entries } = useEntriesStore();
  const [expanded, setExpanded] = useState(false);

  const { gaps, bruttoMs, trackedMs, gapMs } = useMemo(() => {
    const todayISO = getTodayISO();
    return findTrackingGaps(entries, { date: todayISO, minGapMinutes: 5 });
  }, [entries]);

  // Don't render at all if there's nothing to track yet today.
  if (bruttoMs === 0) return null;

  const coveragePct = bruttoMs > 0 ? Math.round((trackedMs / bruttoMs) * 100) : 0;
  const hasGaps = gaps.length > 0;

  return (
    <div
      style={{
        marginTop: '12px',
        padding: '10px 12px',
        background: 'var(--card-bg, rgba(0,0,0,0.04))',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        fontSize: '12px',
      }}
    >
      <div
        onClick={() => hasGaps && setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: hasGaps ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        <Clock size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text)' }}>
            <span style={{ color: 'var(--text-muted)', marginRight: '4px' }}>
              {t('coverage.label')}
            </span>
            <strong>{formatDuration(trackedMs)}</strong>{' '}
            <span style={{ color: 'var(--text-muted)' }}>
              {t('coverage.of')} {formatDuration(bruttoMs)} {t('coverage.brutto')}
            </span>
            <span
              style={{
                marginLeft: '6px',
                color: coveragePct >= 90 ? 'var(--success)' : 'var(--text-muted)',
              }}
            >
              ({coveragePct}%)
            </span>
          </div>
          <div
            style={{
              color: 'var(--text-muted)',
              fontSize: '10px',
              marginTop: '2px',
              fontStyle: 'italic',
            }}
          >
            {t('coverage.subtitle')}
          </div>
          {hasGaps && (
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: '11px',
                marginTop: '2px',
              }}
            >
              {gaps.length === 1
                ? t('coverage.oneGap').replace('{dur}', formatDuration(gapMs))
                : t('coverage.nGaps')
                    .replace('{n}', String(gaps.length))
                    .replace('{dur}', formatDuration(gapMs))}
            </div>
          )}
        </div>
        {hasGaps && (
          <div style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </div>
        )}
      </div>

      {expanded && hasGaps && (
        <div
          style={{
            marginTop: '10px',
            paddingTop: '10px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          {gaps.map((g, i) => (
            <div
              key={`${g.start}-${g.end}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 8px',
                background: 'var(--surface-solid, transparent)',
                borderRadius: '6px',
                fontSize: '11px',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--text)',
                  minWidth: '88px',
                }}
              >
                {g.start} – {g.end}
              </span>
              <span
                style={{
                  color:
                    g.durationMs >= 30 * 60_000
                      ? 'var(--warning, #ECB761)'
                      : 'var(--text-muted)',
                  fontWeight: g.durationMs >= 30 * 60_000 ? 600 : 400,
                }}
              >
                {formatDuration(g.durationMs)}
              </span>
            </div>
          ))}
          <div
            style={{
              fontSize: '10px',
              color: 'var(--text-muted)',
              marginTop: '4px',
              fontStyle: 'italic',
            }}
          >
            {t('coverage.hint')}
          </div>
        </div>
      )}
    </div>
  );
};

export default TrackingCoverage;
