import { useMemo } from 'react';
import { TimeEntry, TeamMember } from '@/types';
import { useI18n } from '../../i18n';
import { getEffectiveDurationMs } from '../../lib/utils';

/**
 * Per-member presence over a date range: sum of per-day brutto windows
 * (first start_time → last end_time, per date). The "geleistete Arbeit"
 * answer to "how long was this person actually working" — matches the
 * "wer war wann aktiv"-Semantik that the bottom Total row needs.
 *
 * Returns hours.
 */
function memberPresenceHours(memberEntries: TimeEntry[]): number {
  // Bucket by date
  const byDate = new Map<string, TimeEntry[]>();
  for (const e of memberEntries) {
    if (!e.date) continue;
    const list = byDate.get(e.date) || [];
    list.push(e);
    byDate.set(e.date, list);
  }
  let totalMin = 0;
  byDate.forEach((dayEntries) => {
    let earliest: number | null = null;
    let latest: number | null = null;
    for (const e of dayEntries) {
      if (!e.start_time || !e.end_time) continue;
      const [sh, sm] = e.start_time.split(':').map(Number);
      const [eh, em] = e.end_time.split(':').map(Number);
      if ([sh, sm, eh, em].some((v) => Number.isNaN(v))) continue;
      let s = sh * 60 + sm;
      let en = eh * 60 + em;
      if (en < s) en += 24 * 60;
      if (earliest == null || s < earliest) earliest = s;
      if (latest == null || en > latest) latest = en;
    }
    if (earliest != null && latest != null && latest > earliest) {
      totalMin += latest - earliest;
    }
  });
  return totalMin / 60;
}

interface TeamMatrixProps {
  dimension: 'stakeholder' | 'project';
  entries: TimeEntry[];
  members: TeamMember[];
}

function getIntensityColor(hours: number): { background: string; borderColor: string } {
  if (hours === 0) return { background: 'var(--surface-hover)', borderColor: 'var(--border)' };
  if (hours < 2) return { background: 'rgba(16, 185, 129, 0.4)', borderColor: 'rgba(16, 185, 129, 0.3)' };
  if (hours < 5) return { background: 'rgba(16, 185, 129, 0.6)', borderColor: 'rgba(16, 185, 129, 0.4)' };
  if (hours < 10) return { background: 'rgba(234, 179, 8, 0.6)', borderColor: 'rgba(202, 138, 4, 0.4)' };
  if (hours < 20) return { background: 'rgba(234, 88, 12, 0.6)', borderColor: 'rgba(194, 65, 12, 0.4)' };
  return { background: 'rgba(239, 68, 68, 0.6)', borderColor: 'rgba(220, 38, 38, 0.4)' };
}

export function TeamMatrix({ dimension, entries, members }: TeamMatrixProps) {
  const { t } = useI18n();
  const { items, memberIds, matrix, totals } = useMemo(() => {
    const isStakeholder = dimension === 'stakeholder';

    // Extract unique dimension values — flatten stakeholder arrays
    const uniqueItemSet = new Set<string>();
    entries.forEach((e) => {
      if (isStakeholder) {
        const shArray = Array.isArray(e.stakeholder) ? e.stakeholder : [e.stakeholder];
        shArray.forEach((sh) => { if (sh) uniqueItemSet.add(sh); });
      } else {
        if (e.projekt) uniqueItemSet.add(e.projekt);
      }
    });
    const uniqueItems = Array.from(uniqueItemSet).sort();

    // Use display_name for column headers, user_id for data matching
    const memberIdList = members.map((m) => m.display_name || m.user_id).sort();
    const memberUserIds = members.reduce<Record<string, string>>((acc, m) => {
      acc[m.display_name || m.user_id] = m.user_id;
      return acc;
    }, {});

    const matrix: Record<string, Record<string, number>> = {};
    const itemTotals: Record<string, number> = {};
    const memberTotals: Record<string, number> = {};

    // Initialize
    for (const item of uniqueItems) {
      matrix[item] = {};
      itemTotals[item] = 0;
      for (const memberId of memberIdList) {
        matrix[item][memberId] = 0;
      }
    }

    for (const memberId of memberIdList) {
      memberTotals[memberId] = 0;
    }

    // Fill matrix
    for (const item of uniqueItems) {
      for (const memberId of memberIdList) {
        const uid = memberUserIds[memberId];
        const memberItemEntries = entries.filter((e) => {
          const matchesDimension = isStakeholder
            ? (Array.isArray(e.stakeholder) ? e.stakeholder : [e.stakeholder]).includes(item)
            : e.projekt === item;
          return matchesDimension && e.user_id === uid;
        });

        const total = memberItemEntries.reduce((sum, e) => {
          const durationMs = getEffectiveDurationMs(e);
          // For stakeholder dimension: divide duration proportionally among all stakeholders
          // so that totals remain consistent across views (a 1h meeting with 2 stakeholders = 0.5h each)
          if (isStakeholder) {
            const shCount = Array.isArray(e.stakeholder) ? e.stakeholder.filter(Boolean).length : 1;
            return sum + durationMs / Math.max(shCount, 1);
          }
          return sum + durationMs;
        }, 0) / (1000 * 60 * 60);

        matrix[item][memberId] = total;
        itemTotals[item] += total;
        memberTotals[memberId] += total;
      }
    }

    // Per-member presence (geleistete Arbeit) for the bottom Total row.
    // Replaces the previous "sum-of-cells" semantic, which was the naive
    // attribution sum and could over-count multitasking — confusing in a
    // row labelled "Total" right under columns labelled by person.
    const memberPresence: Record<string, number> = {};
    for (const memberId of memberIdList) {
      const uid = memberUserIds[memberId];
      const allMemberEntries = entries.filter((e) => e.user_id === uid);
      memberPresence[memberId] = memberPresenceHours(allMemberEntries);
    }

    return {
      items: uniqueItems,
      memberIds: memberIdList,
      matrix,
      totals: { item: itemTotals, member: memberTotals, memberPresence },
    };
  }, [dimension, entries, members]);

  if (items.length === 0 || memberIds.length === 0) {
    return <div style={{ color: 'var(--text-muted)' }}>{t('dash.noData')}</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="p-2 text-left text-sm font-semibold border" style={{ color: 'var(--text-muted)', background: 'var(--surface-hover)', borderColor: 'var(--border)' }}>
              {dimension === 'stakeholder' ? t('label.stakeholder') : t('label.projekt')}
            </th>
            {memberIds.map((memberId) => (
              <th
                key={memberId}
                className="p-2 text-center text-sm font-semibold border"
                style={{ color: 'var(--text-secondary)', background: 'var(--surface-hover)', borderColor: 'var(--border)' }}
              >
                {memberId}
              </th>
            ))}
            <th className="p-2 text-center text-sm font-semibold border" style={{ color: 'var(--neon-cyan)', background: 'var(--surface-hover)', borderColor: 'var(--border)' }}>
              {t('team.total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item}>
              <td className="p-2 text-sm font-medium border sticky left-0" style={{ color: 'var(--text-secondary)', background: 'var(--surface)', borderColor: 'var(--border)' }}>
                {item}
              </td>
              {memberIds.map((memberId) => {
                const hours = matrix[item][memberId];
                return (
                  <td
                    key={`${item}-${memberId}`}
                    className={`p-2 text-center text-sm font-medium border ${getIntensityColor(hours)}`}
                    style={{ color: 'var(--text)', borderColor: 'var(--border)' }}
                  >
                    {hours > 0 ? hours.toFixed(1) : '—'}
                  </td>
                );
              })}
              <td className="p-2 text-center text-sm font-semibold border" style={{ color: '#cffafe', background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
                {(totals.item[item] || 0).toFixed(1)}
              </td>
            </tr>
          ))}
          {/* Bottom row: per-member Präsenz (geleistete Arbeit, also sum of
              per-day first→last windows). NOT the column-sum of cells —
              that would be the attribution sum (naive) and overcounts
              parallel work. The per-stakeholder/-projekt totals on the
              right-most column still ARE attribution sums (correct for
              "how much team time on this stakeholder"). */}
          <tr style={{ borderTop: '2px solid var(--border)' }}>
            <td className="p-2 text-sm font-semibold border" style={{ color: 'var(--neon-cyan)', background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
              {t('team.presenceLabel')}
            </td>
            {memberIds.map((memberId) => (
              <td
                key={`presence-${memberId}`}
                className="p-2 text-center text-sm font-semibold border"
                style={{ color: '#cffafe', background: 'var(--surface-solid)', borderColor: 'var(--border)' }}
                title={t('team.presenceCellTooltip')}
              >
                {(totals.memberPresence[memberId] || 0).toFixed(1)}
              </td>
            ))}
            <td className="p-2 text-center text-sm font-bold border" style={{ color: 'var(--neon-cyan)', background: 'var(--surface-hover)', borderColor: 'var(--border)' }}>
              {Object.values(totals.memberPresence).reduce((a, b) => a + b, 0).toFixed(1)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
