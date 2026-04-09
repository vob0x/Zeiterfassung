import { useMemo } from 'react';
import { TimeEntry, FilterState } from '@/types';
import { useI18n } from '../../i18n';
import { formatHoursAdaptive, getEffectiveDurationMs } from '../../lib/utils';

interface TimelineChartProps {
  entries: TimeEntry[];
  onDrillDown?: (filters: Partial<FilterState>) => void;
}

// Muted palette matching the app's earth/gold design language
const PROJECT_COLORS = [
  '#C9A962', // gold (--neon-cyan / --primary)
  '#6EC49E', // sage green (--success)
  '#9B8EC4', // soft violet (--neon-violet)
  '#D4706E', // muted coral (--danger)
  '#E5A84B', // warm amber (--warning)
  '#5BA4D9', // soft steel blue
  '#D4956A', // warm terracotta (--neon-orange)
  '#C48B9F', // dusty rose (--neon-magenta)
];

export function TimelineChart({ entries, onDrillDown }: TimelineChartProps) {
  const { t, tArray } = useI18n();
  const wdShort = tArray('wd.short');

  const { chartData, uniqueProjects, maxHours } = useMemo(() => {
    if (entries.length === 0) return { chartData: [], uniqueProjects: [], maxHours: 0 };

    // Get last 14 days or all unique dates
    const uniqueDates = [...new Set(entries.map((e) => e.date))].sort();
    const chartDates = uniqueDates.slice(Math.max(0, uniqueDates.length - 14));

    const uniqueProjects = [...new Set(entries.map((e) => e.projekt))].sort();

    let maxHours = 0;

    const chartData = chartDates.map((date) => {
      const dayEntries = entries.filter((e) => e.date === date);
      const projectHours: Record<string, number> = {};

      for (const project of uniqueProjects) {
        const projectEntries = dayEntries.filter((e) => e.projekt === project);
        const hours = projectEntries.reduce((sum, e) => sum + getEffectiveDurationMs(e), 0) / (1000 * 60 * 60);
        projectHours[project] = hours;
      }

      const totalHours = Object.values(projectHours).reduce((a, b) => a + b, 0);
      maxHours = Math.max(maxHours, totalHours);

      const dateObj = new Date(date);
      const dayShort = (wdShort.length === 7 ? wdShort : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'])[dateObj.getDay()];
      const dayNum = dateObj.getDate();

      return {
        date,
        dayLabel: `${dayShort} ${dayNum}`,
        projectHours,
        totalHours,
      };
    });

    return { chartData, uniqueProjects, maxHours };
  }, [entries, wdShort]);

  if (chartData.length === 0) {
    return <div style={{ color: 'var(--text-muted)' }}>{t('dash.noData')}</div>;
  }

  // Bar sizing: cap the per-bar width so a chart with few days doesn't
  // produce a single huge bar that overflows the mobile viewport.
  const MAX_BAR_WIDTH = 56;
  const SLOT_WIDTH = 40; // horizontal space allocated per day
  // Make the canvas wide enough for all bars at SLOT_WIDTH each. With only
  // a few days the canvas stays narrow (no forced 600px min) so the chart
  // fits on a phone screen without horizontal cut-off.
  const canvasWidth = Math.max(320, chartData.length * SLOT_WIDTH + 80);
  const canvasHeight = 300;
  const padding = 40;
  const chartWidth = canvasWidth - padding * 2;
  const chartHeight = canvasHeight - padding * 2;
  const barSpacing = chartWidth / chartData.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, barSpacing * 0.8);

  return (
    <div className="overflow-x-auto pb-4">
      <svg width={canvasWidth} height={canvasHeight} className="mx-auto">
        {/* Y-axis */}
        <line
          x1={padding}
          y1={padding}
          x2={padding}
          y2={canvasHeight - padding}
          stroke="var(--surface-hover)"
          strokeWidth="1"
        />

        {/* X-axis */}
        <line
          x1={padding}
          y1={canvasHeight - padding}
          x2={canvasWidth - padding}
          y2={canvasHeight - padding}
          stroke="var(--surface-hover)"
          strokeWidth="1"
        />

        {/* Y-axis labels and grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const hours = maxHours * ratio;
          const y = canvasHeight - padding - ratio * chartHeight;

          return (
            <g key={`y-${ratio}`}>
              <line
                x1={padding - 5}
                y1={y}
                x2={padding}
                y2={y}
                stroke="var(--surface-hover)"
                strokeWidth="1"
              />
              <text
                x={padding - 10}
                y={y + 4}
                textAnchor="end"
                fontSize="12"
                fill="var(--text-muted)"
              >
                {formatHoursAdaptive(hours, 0)}
              </text>
              {ratio > 0 && (
                <line
                  x1={padding}
                  y1={y}
                  x2={canvasWidth - padding}
                  y2={y}
                  stroke="var(--surface-solid)"
                  strokeWidth="1"
                  strokeDasharray="4"
                />
              )}
            </g>
          );
        })}

        {/* Bars */}
        {chartData.map((data, idx) => {
          let bottomY = canvasHeight - padding;
          const xPos = padding + idx * barSpacing + (barSpacing - barWidth) / 2;

          return (
            <g key={data.date}>
              {/* Stacked bars by project */}
              {data.totalHours > 0 &&
                Object.entries(data.projectHours).map(([project, hours]) => {
                  if (hours === 0) return null;

                  const barHeight = (hours / maxHours) * chartHeight;
                  const color = Object.fromEntries(
                    [...new Set(Object.keys(data.projectHours))].map((p, i) => [
                      p,
                      PROJECT_COLORS[i % PROJECT_COLORS.length],
                    ])
                  )[project];

                  const rect = (
                    <rect
                      key={`bar-${data.date}-${project}`}
                      x={xPos}
                      y={bottomY - barHeight}
                      width={barWidth}
                      height={barHeight}
                      fill={color}
                      opacity="0.85"
                      rx="2"
                      style={{ cursor: onDrillDown ? 'pointer' : undefined }}
                      onClick={() => onDrillDown?.({ project, from: data.date, to: data.date })}
                    />
                  );

                  bottomY -= barHeight;
                  return rect;
                })}

              {/* X-axis label */}
              <text
                x={xPos + barWidth / 2}
                y={canvasHeight - padding + 20}
                textAnchor="middle"
                fontSize="12"
                fill="var(--text-secondary)"
              >
                {data.dayLabel}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-4 justify-center">
        {uniqueProjects.map((project, idx) => (
          <div
            key={project}
            className="flex items-center gap-2 transition-opacity"
            style={{ cursor: onDrillDown ? 'pointer' : undefined }}
            onClick={() => onDrillDown?.({ project })}
            onMouseEnter={(e) => { if (onDrillDown) e.currentTarget.style.opacity = '0.7'; }}
            onMouseLeave={(e) => { if (onDrillDown) e.currentTarget.style.opacity = '1'; }}
            title={onDrillDown ? t('dash.clickToFilter') : undefined}
          >
            <div
              className="w-4 h-4 rounded"
              style={{ backgroundColor: PROJECT_COLORS[idx % PROJECT_COLORS.length] }}
            />
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{project}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
