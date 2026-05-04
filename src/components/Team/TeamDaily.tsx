import { useMemo } from 'react';
import { TimeEntry } from '@/types';
import { useI18n } from '../../i18n';
// Cell-level metric is Präsenz per (member, date) — first start_time
// to last end_time of that person's entries on that day. Matches the
// "wer war wann aktiv"-Semantik der Card. Multitasking-Aufschlüsselung
// findet sich in den Stakeholder×Person / Projekt×Person Tabellen.
function presenceMinutes(entries: Array<{ start_time: string; end_time: string }>): number {
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const e of entries) {
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
  if (earliest == null || latest == null) return 0;
  return Math.max(0, latest - earliest);
}
import { isAbsenceEntry, isOvertimeDate, overtimeLabel } from '../../lib/absences';

interface TeamDailyProps {
  memberEntries: Map<string, TimeEntry[]>;
  entries: TimeEntry[];
}

function getIntensityColor(hours: number): { background: string; color: string } {
  if (hours === 0) return { background: 'var(--surface-solid)', color: 'var(--text-muted)' };
  if (hours < 4) return { background: 'var(--surface-hover)', color: '#e5e7eb' };
  if (hours < 8) return { background: '#1e3a8a', color: '#dbeafe' };
  if (hours < 12) return { background: '#155e75', color: '#cffafe' };
  return { background: '#15803d', color: '#dcfce7' };
}

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
const MONTH_NAMES_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

export function TeamDaily({ memberEntries, entries }: TeamDailyProps) {
  const { t, tArray, language } = useI18n();
  const wdShort = tArray('wd.short');
  const monthNames = language === 'fr' ? MONTH_NAMES_FR : MONTH_NAMES_DE;
  const { dates, memberIds, matrix, averages } = useMemo(() => {
    const uniqueDates = [...new Set(entries.map((e) => e.date))].sort();
    const uniqueMemberIds = Array.from(memberEntries.keys()).sort();

    const matrix: Record<string, Record<string, number>> = {};
    const averages: Record<string, number> = {};

    for (const memberId of uniqueMemberIds) {
      matrix[memberId] = {};
      let total = 0;
      let dayCount = 0;

      for (const date of uniqueDates) {
        const memberDateEntries = (memberEntries.get(memberId) || []).filter((e) => e.date === date);
        // Cell hours = Präsenz per member per day: first entry start →
        // last entry end. Matches the "wer war wann aktiv"-Card-Titel.
        // Naive multitasking-Sum lebt in den Stakeholder×Person und
        // Projekt×Person Cards weiter unten — dort macht
        // Doppelzählung als Attribution Sinn, hier in der
        // Tagesübersicht aber nicht (wir waren NICHT 11.3h aktiv,
        // sondern 9:37h).
        const workEntries = memberDateEntries.filter((e) => !isAbsenceEntry(e));
        const hours = presenceMinutes(workEntries) / 60;
        matrix[memberId][date] = hours;
        // Only count weekdays (Mo–Fr) for the average — weekend work
        // is voluntary/exceptional and shouldn't dilute the daily average.
        const dayOfWeek = new Date(date).getDay(); // 0=So, 6=Sa
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
        if (hours > 0 && isWeekday) {
          total += hours;
          dayCount += 1;
        }
      }

      averages[memberId] = dayCount > 0 ? total / dayCount : 0;
    }

    return { dates: uniqueDates, memberIds: uniqueMemberIds, matrix, averages };
  }, [memberEntries, entries]);

  if (dates.length === 0 || memberIds.length === 0) {
    return <div style={{ color: 'var(--text-muted)' }}>{t('dash.noData')}</div>;
  }

  // Group consecutive dates by month/year for the top header row.
  // Without this it's impossible to tell which month a "Mi 5" belongs to
  // when the period spans multiple months — a regression reported after
  // the role rollout.
  const monthGroups: { label: string; count: number }[] = [];
  {
    let curMonth = -1;
    let curYear = -1;
    for (const date of dates) {
      const d = new Date(date);
      const m = d.getMonth();
      const y = d.getFullYear();
      if (m !== curMonth || y !== curYear) {
        monthGroups.push({ label: `${monthNames[m]} ${y}`, count: 1 });
        curMonth = m;
        curYear = y;
      } else {
        monthGroups[monthGroups.length - 1].count += 1;
      }
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          {/* Month grouping row — colSpan covers all days in that month */}
          <tr>
            <th
              className="p-1 text-left font-semibold border sticky left-0 z-10"
              style={{ color: 'var(--text-muted)', background: 'var(--surface-solid)', borderColor: 'var(--border)', fontSize: 11 }}
            />
            {monthGroups.map((g, i) => (
              <th
                key={`month-${i}`}
                colSpan={g.count}
                className="p-1 text-center font-semibold border"
                style={{
                  color: 'var(--neon-cyan)',
                  background: 'var(--surface-solid)',
                  borderColor: 'var(--border)',
                  fontSize: 11,
                  letterSpacing: '0.02em',
                }}
              >
                {g.label}
              </th>
            ))}
            <th
              className="p-1 text-center font-semibold border"
              style={{ background: 'var(--surface-solid)', borderColor: 'var(--border)' }}
            />
          </tr>
          <tr>
            <th className="p-2 text-left font-semibold border sticky left-0 z-10" style={{ color: 'var(--text-muted)', background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
              {t('team.persons')}
            </th>
            {dates.map((date) => {
              const dateObj = new Date(date);
              const dayShort = (wdShort.length === 7 ? wdShort : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'])[dateObj.getDay()];
              const day = dateObj.getDate();
              // Mark weekend/holiday columns so the reader sees at a glance
              // when overtime applies. Holiday gets the holiday name as
              // tooltip; weekend just gets the warm gold tint.
              const isOT = isOvertimeDate(date);
              const otTooltip = isOT ? overtimeLabel(date) || 'Wochenende' : undefined;
              return (
                <th
                  key={date}
                  className="p-2 text-center font-semibold border"
                  style={{
                    color: isOT ? 'var(--warning)' : 'var(--text-secondary)',
                    background: isOT ? 'rgba(229,168,75,0.08)' : 'var(--surface-solid)',
                    borderColor: 'var(--border)',
                  }}
                  title={otTooltip}
                >
                  <div className="text-xs">{dayShort}</div>
                  <div>{day}</div>
                </th>
              );
            })}
            <th className="p-2 text-center font-semibold border" style={{ color: 'var(--neon-cyan)', background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
              ⌀
            </th>
          </tr>
        </thead>
        <tbody>
          {memberIds.map((memberId) => (
            <tr key={memberId}>
              <td className="p-2 font-medium border sticky left-0 z-10" style={{ color: 'var(--text-secondary)', background: 'var(--surface)', borderColor: 'var(--border)' }}>
                {memberId}
              </td>
              {dates.map((date) => {
                const hours = matrix[memberId][date] || 0;
                const colorStyle = getIntensityColor(hours);
                return (
                  <td
                    key={`${memberId}-${date}`}
                    className="p-2 text-center font-semibold border"
                    style={{ ...colorStyle, borderColor: 'var(--border)' }}
                  >
                    {hours > 0 ? hours.toFixed(1) : '—'}
                  </td>
                );
              })}
              <td className="p-2 text-center font-semibold border" style={{ color: '#cffafe', background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
                {averages[memberId].toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
