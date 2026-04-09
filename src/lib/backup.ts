import { TimeEntry } from '@/types';
import { getEffectiveDurationMs } from './utils';

interface BackupData {
  version: string;
  timestamp: string;
  masterData: {
    stakeholders: string[];
    projects: string[];
    activities: string[];
    formats?: string[]; // NEW: format dimension
  };
  entries: TimeEntry[];
}

export function exportBackup(
  masterData: {
    stakeholders: string[];
    projects: string[];
    activities: string[];
    formats?: string[];
  },
  entries: TimeEntry[]
): BackupData {
  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    masterData: {
      stakeholders: masterData.stakeholders,
      projects: masterData.projects,
      activities: masterData.activities,
      formats: masterData.formats || [],
    },
    entries,
  };
}

/**
 * Import a backup file. Returns parsed BackupData or null if invalid.
 * Confirmation is handled by the caller (ManageView uses ConfirmDialog).
 */
export async function importBackup(file: File): Promise<BackupData | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const backup = JSON.parse(content) as BackupData;

        // Validate structure
        if (
          !backup.version ||
          !backup.timestamp ||
          !backup.masterData ||
          !Array.isArray(backup.entries)
        ) {
          throw new Error('Invalid backup file format');
        }

        resolve(backup);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsText(file);
  });
}

/**
 * Export entries to CSV. Headers are passed from the caller for i18n support.
 */
export function exportCSV(
  entries: TimeEntry[],
  headers?: string[],
  weekdayNames?: string[]
): string {
  const csvHeaders = headers || ['Datum', 'Stakeholder', 'Projekt', 'Format', 'Tätigkeit', 'Von', 'Bis', 'Dauer', 'Notiz', 'Wochentag'];
  const defaultWeekdays = weekdayNames || ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  const rows = entries.map((entry) => {
    // Use effective duration with plausibility check (duration_ms ≤ Von-Bis span)
    const effectiveMs = getEffectiveDurationMs(entry);
    const durationHours = (effectiveMs / 3600000).toFixed(2);

    const dateObj = new Date(entry.date + 'T00:00:00');
    const weekday = defaultWeekdays[dateObj.getDay()];

    // Handle stakeholder as array: join with ", "
    const stakeholderStr = Array.isArray(entry.stakeholder)
      ? entry.stakeholder.join(', ')
      : entry.stakeholder;

    return [
      entry.date,
      stakeholderStr,
      entry.projekt,
      entry.format || 'Einzelarbeit',
      entry.taetigkeit,
      entry.start_time,
      entry.end_time,
      durationHours,
      entry.notiz || '',
      weekday,
    ]
      .map((cell) => {
        // Escape quotes and wrap in quotes if contains semicolon or special chars
        const str = String(cell);
        if (str.includes(';') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(';');
  });

  return [csvHeaders.join(';'), ...rows].join('\n');
}

// Normalize date: DD.MM.YYYY → YYYY-MM-DD, already ISO → pass through
function normalizeDate(raw: string): string {
  // DD.MM.YYYY format (European)
  const euMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (euMatch) {
    const [, d, m, y] = euMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw;
}

// Check if a string looks like a time value (HH:MM or HH:MM:SS)
function isTimeValue(s: string): boolean {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(s);
}

// Parse time string "HH:MM" or "HH:MM:SS" to minutes from midnight
function parseTimeToMinutes(s: string): number {
  const parts = s.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

// Compute end time from start time (minutes) + duration (hours as float)
function computeEndTime(startMinutes: number, durationHours: number): string {
  const endMinutes = startMinutes + Math.round(durationHours * 60);
  const h = Math.floor(endMinutes / 60) % 24;
  const m = endMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export async function importCSV(file: File): Promise<Omit<TimeEntry, 'id' | 'user_id' | 'created_at' | 'updated_at'>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const lines = content.split('\n').filter((line) => line.trim());

        if (lines.length < 2) {
          throw new Error('CSV file is empty');
        }

        // Skip header row
        const rows = lines.slice(1);
        const entries: Omit<TimeEntry, 'id' | 'user_id' | 'created_at' | 'updated_at'>[] = [];

        for (const row of rows) {
          // Simple CSV parsing (semicolon-delimited)
          const cells = row.split(';').map((cell) => cell.replace(/^"(.*)"$/, '$1').trim());

          if (cells.length < 7) continue;

          // ── Detect column layout by checking if cells[5] looks like a time ──
          // New V6 format: Datum(0), Stakeholder(1), Projekt(2), Format(3), Tätigkeit(4), Von(5), Bis(6), Dauer(7), Notiz(8), Wochentag(9)
          // Old V5 format: Datum(0), Stakeholder(1), Projekt(2), Tätigkeit(3), Von(4), Bis(5), Dauer(6), Notiz(7), Wochentag(8)
          // Broken V6 export: Datum(0), Stakeholder(1), Projekt(2), Format(3), Format_dup(4), Tätigkeit(5), Von(6), Bis(7), Dauer(8), Notiz(9)

          let date = '';
          let stakeholderStr = cells[1] || '';
          let projekt = cells[2] || '';
          let format = 'Einzelarbeit';
          let taetigkeit = '';
          let startTime = '';
          let endTime = '';
          let durationHours = NaN;
          let notiz = '';

          if (cells.length >= 10 && isTimeValue(cells[5])) {
            // ── Standard V6 format (10+ cols, col 5 is a time) ──
            format = cells[3] || 'Einzelarbeit';
            taetigkeit = cells[4] || '';
            startTime = cells[5];
            endTime = cells[6];
            durationHours = parseFloat(cells[7]);
            notiz = cells[8] || '';
          } else if (cells.length >= 10 && isTimeValue(cells[6])) {
            // ── Broken V6 export (cols shifted: format duplicated, Tätigkeit in col 5, Von in col 6) ──
            format = cells[3] || 'Einzelarbeit';
            taetigkeit = cells[5] || '';
            startTime = cells[6];
            endTime = isTimeValue(cells[7]) ? cells[7] : '';
            durationHours = parseFloat(cells[8]);
            notiz = cells[9] || '';
          } else if (cells.length >= 8 && isTimeValue(cells[4])) {
            // ── Old V5 format (8-9 cols, col 4 is Von) ──
            taetigkeit = cells[3] || '';
            startTime = cells[4];
            endTime = cells[5];
            durationHours = parseFloat(cells[6]);
            notiz = cells[7] || '';
          } else {
            // ── Unknown format, try best guess ──
            // Find the first cell that looks like a time
            let timeIdx = -1;
            for (let i = 3; i < Math.min(cells.length, 8); i++) {
              if (isTimeValue(cells[i])) { timeIdx = i; break; }
            }
            if (timeIdx === -1) continue; // Skip row if no time found

            // Everything between col 2 and timeIdx is dimension data
            if (timeIdx === 5) {
              format = cells[3] || 'Einzelarbeit';
              taetigkeit = cells[4] || '';
            } else if (timeIdx === 4) {
              taetigkeit = cells[3] || '';
            } else if (timeIdx === 6) {
              format = cells[3] || 'Einzelarbeit';
              taetigkeit = cells[5] || '';
            }
            startTime = cells[timeIdx];
            endTime = isTimeValue(cells[timeIdx + 1]) ? cells[timeIdx + 1] : '';
            const durIdx = endTime ? timeIdx + 2 : timeIdx + 1;
            durationHours = parseFloat(cells[durIdx]);
            notiz = cells[durIdx + 1] || '';
          }

          // Normalize date
          date = normalizeDate(cells[0]);

          // Clean up "undefined" and "NaN" strings
          if (notiz === 'undefined' || notiz === 'NaN') notiz = '';
          if (taetigkeit === 'undefined') taetigkeit = '';

          // Normalize time format: remove seconds if present (HH:MM:SS → HH:MM)
          if (startTime && startTime.length > 5) startTime = startTime.substring(0, 5);
          if (endTime && endTime.length > 5) endTime = endTime.substring(0, 5);

          // If endTime is missing/invalid, compute from startTime + duration
          if (!endTime || endTime === 'NaN' || !isTimeValue(endTime)) {
            if (startTime && !isNaN(durationHours) && durationHours > 0) {
              const startMin = parseTimeToMinutes(startTime);
              endTime = computeEndTime(startMin, durationHours);
            } else {
              endTime = startTime; // Fallback: 0 duration
            }
          }

          // Calculate duration_ms — prefer the Dauer column (effective duration)
          // over Von-Bis (time window) because stack timers can run in parallel
          // within the same Von-Bis window, making Von-Bis wildly inflated.
          let duration_ms = 0;
          if (!isNaN(durationHours) && durationHours > 0) {
            // Dauer column has the actual effective duration — always prefer this
            duration_ms = Math.round(durationHours * 3600000);
          } else {
            // Fallback: compute from Von-Bis only when Dauer is missing
            const startMin = parseTimeToMinutes(startTime);
            let endMin = parseTimeToMinutes(endTime);
            if (endMin < startMin) endMin += 24 * 60;
            duration_ms = (endMin - startMin) * 60000;
          }

          // Handle stakeholder as comma-separated string -> split into array
          const stakeholder = stakeholderStr
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s);

          const entry: Omit<TimeEntry, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
            date,
            stakeholder: stakeholder.length > 0 ? stakeholder : [''],
            projekt,
            taetigkeit,
            format,
            start_time: startTime,
            end_time: endTime,
            duration_ms,
            notiz,
          };

          entries.push(entry);
        }

        resolve(entries);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsText(file);
  });
}
