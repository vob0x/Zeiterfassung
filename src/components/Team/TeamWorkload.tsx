import { useMemo } from 'react';
import { TimeEntry } from '@/types';
import { useI18n } from '../../i18n';
import { getEffectiveDurationMs } from '../../lib/utils';

interface TeamWorkloadProps {
  memberEntries: Map<string, TimeEntry[]>;
  entries: TimeEntry[];
}

// Muted palette matching the app's earth/gold design language
const COLORS = [
  '#C9A962', // gold (--primary)
  '#6EC49E', // sage green (--success)
  '#9B8EC4', // soft violet (--neon-violet)
  '#D4706E', // muted coral (--danger)
  '#5BA4D9', // soft steel blue
  '#D4956A', // warm terracotta
  '#C48B9F', // dusty rose
  '#4ECDC4', // teal
];

export function TeamWorkload({ memberEntries, entries }: TeamWorkloadProps) {
  const { t } = useI18n();
  const { memberWorkload, uniqueProjects } = useMemo(() => {
    const uniqueProjects = [...new Set(entries.map((e) => e.projekt))].sort();
    const memberIds = Array.from(memberEntries.keys()).sort();

    const memberWorkload = memberIds.map((memberId) => {
      const memberEntries_ = memberEntries.get(memberId) || [];
      const projectHours: Record<string, number> = {};

      for (const project of uniqueProjects) {
        const projectEntries = memberEntries_.filter((e) => e.projekt === project);
        let total = 0;

        for (const date of [...new Set(projectEntries.map((e) => e.date))]) {
          const dateEntries = projectEntries.filter((e) => e.date === date);
          total += dateEntries.reduce((sum, e) => sum + getEffectiveDurationMs(e), 0) / (1000 * 60 * 60);
        }

        projectHours[project] = total;
      }

      const totalHours = Object.values(projectHours).reduce((a, b) => a + b, 0);

      return { memberId, projectHours, totalHours };
    });

    return { memberWorkload, uniqueProjects };
  }, [memberEntries, entries]);

  if (memberWorkload.length === 0) {
    return <div style={{ color: 'var(--text-muted)' }}>{t('dash.noData')}</div>;
  }

  return (
    <div className="space-y-4">
      {memberWorkload.map((item) => (
        <div key={item.memberId} className="space-y-1">
          <div className="flex justify-between items-center text-sm">
            <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{item.memberId}</span>
            <span className="font-semibold" style={{ color: 'var(--neon-cyan)' }}>{item.totalHours.toFixed(1)}h</span>
          </div>
          <div className="w-full rounded-full h-8 overflow-hidden border flex" style={{ background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
            {item.totalHours > 0 &&
              uniqueProjects.map((project, idx) => {
                const hours = item.projectHours[project] || 0;
                const percentage = (hours / item.totalHours) * 100;

                return (
                  <div
                    key={project}
                    className="h-full transition-all duration-300 flex items-center justify-center"
                    style={{
                      width: `${percentage}%`,
                      backgroundColor: COLORS[idx % COLORS.length],
                      opacity: 0.85,
                    }}
                    title={`${project}: ${hours.toFixed(1)}h`}
                  >
                    {percentage > 15 && (
                      <span className="text-xs font-semibold" style={{ color: 'var(--text)' }}>{project.slice(0, 3)}</span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      ))}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-4 pt-4" style={{ borderTop: `1px solid var(--border)` }}>
        {uniqueProjects.map((project, idx) => (
          <div key={project} className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded"
              style={{ backgroundColor: COLORS[idx % COLORS.length] }}
            />
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{project}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
