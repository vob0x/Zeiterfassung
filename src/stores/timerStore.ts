import { create } from 'zustand';
import { TimerSlot } from '@/types';
import { useEntriesStore } from './entriesStore';
import { useAuthStore } from './authStore';
import { getUserData, setUserData, removeUserData } from '@/lib/userStorage';
import { formatDateISO } from '@/lib/utils';
import { saveNoteToHistory } from '@/components/UI/NoteInput';
import { supabaseClient, isSupabaseAvailable, ensureValidSession } from '@/lib/supabase';

// Serializable version for localStorage (Date → ISO string)
interface SerializedSlot {
  id: string;
  date: string;
  stakeholder: string[];
  projekt: string;
  taetigkeit: string;
  format: string;
  start_time: string;
  elapsed_ms: number;
  notiz?: string;
  is_running: boolean;
  color: string;
  pausedMs: number;
  isPaused: boolean;
  wasRunning: boolean;
}

interface SavedTimerState {
  slots: SerializedSlot[];
  savedAt: number; // Date.now() at save time
}

interface TimerState {
  taskSlots: TimerSlot[];
  activeSlotId: string | null;
  tickInterval: ReturnType<typeof setInterval> | null;
  error: string | null;
  addSlot: (slot: { stakeholder: string[]; projekt: string; taetigkeit: string; format: string; notiz?: string }) => void;
  removeSlot: (id: string) => void;
  resetSlot: (id: string) => void;
  updateSlotField: (
    id: string,
    field: 'stakeholder' | 'projekt' | 'taetigkeit' | 'format' | 'notiz',
    value: string | string[]
  ) => void;
  addSlotStakeholder: (id: string, stakeholder: string) => void;
  removeSlotStakeholder: (id: string, stakeholder: string) => void;
  startTimer: (id: string) => void;
  pauseTimer: (id: string) => void;
  resumeTimer: (id: string) => void;
  stopTimer: (id: string) => void;
  stopAllTimers: () => void;
  getSlotElapsed: (id: string) => number;
  tick: () => void;
  saveTimers: () => void;
  restoreTimers: () => Promise<void>;
  setError: (error: string | null) => void;
  clearError: () => void;
}

// Color palette for timer lanes — each new slot gets the next color
const TIMER_PALETTE = ['#C9A962', '#6EC49E', '#9B8EC4', '#D4706E', '#5BA4D9', '#E5A84B', '#7ECFCF', '#C97B9B'];
let colorCounter = 0;

function assignColor(existingColors: string[]): string {
  for (const c of TIMER_PALETTE) {
    if (!existingColors.includes(c)) return c;
  }
  return TIMER_PALETTE[colorCounter++ % TIMER_PALETTE.length];
}

function generateId(): string {
  return `slot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function ensureTickInterval(get: () => TimerState, set: (partial: Partial<TimerState>) => void) {
  const state = get();
  if (!state.tickInterval) {
    const interval = setInterval(() => {
      get().tick();
    }, 500);
    set({ tickInterval: interval });
  }
}

// ── Cross-device sync state (module-level) ─────────────────────────────

// After a local push, suppress polling for N seconds so stale reads can't
// undo the change before the DB write settles.
let _suppressUntil: number = 0;

// ── Helper: serialize current slots ────────────────────────────────────

function serializeSlots(slots: TimerSlot[]): SerializedSlot[] {
  const now = Date.now();
  return slots.map((slot) => {
    const wasRunning = !slot.isPaused;
    const totalPaused = wasRunning
      ? slot.pausedMs + (now - slot.startTime.getTime())
      : slot.pausedMs;
    return {
      id: slot.id,
      date: slot.date,
      stakeholder: slot.stakeholder,
      projekt: slot.projekt,
      taetigkeit: slot.taetigkeit,
      format: slot.format,
      start_time: slot.start_time,
      elapsed_ms: slot.elapsed_ms,
      notiz: slot.notiz,
      is_running: slot.is_running,
      color: slot.color,
      pausedMs: totalPaused,
      isPaused: true,
      wasRunning,
    };
  });
}

// ── syncStateToSupabase: the ONE path for pushing timer state ──────────
// Called directly by each user action. saveTimers() does NOT call this.
// Debounced: coalesces rapid-fire calls into a single push.

let _syncDebounce: ReturnType<typeof setTimeout> | null = null;

function syncStateToSupabase(): void {
  if (_syncDebounce) clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(() => {
    _syncDebounce = null;
    const state = useTimerStore.getState();
    const serialized = serializeSlots(state.taskSlots);
    _suppressUntil = Date.now() + 5000;
    pushTimersToSupabase(serialized);
  }, 300);
}

export const useTimerStore = create<TimerState>((set, get) => ({
  taskSlots: [],
  activeSlotId: null,
  tickInterval: null,
  error: null,

  addSlot: (slotData) => {
    const state = get();
    if (state.taskSlots.length >= 8) {
      set({ error: 'Maximum 8 concurrent tasks allowed' });
      return;
    }

    const now = new Date();
    const existingColors = state.taskSlots.map((s) => s.color);
    const newSlot: TimerSlot = {
      stakeholder: slotData.stakeholder || [],
      projekt: slotData.projekt,
      taetigkeit: slotData.taetigkeit,
      format: slotData.format || 'Einzelarbeit',
      notiz: slotData.notiz,
      id: generateId(),
      date: formatDateISO(now),
      start_time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      elapsed_ms: 0,
      is_running: false,
      color: assignColor(existingColors),
      startTime: now,
      pausedMs: 0,
      isPaused: true,
    };

    set((state) => ({
      taskSlots: [...state.taskSlots, newSlot],
    }));
  },

  removeSlot: (id: string) => {
    set((state) => ({
      taskSlots: state.taskSlots.filter((slot) => slot.id !== id),
      activeSlotId: state.activeSlotId === id ? null : state.activeSlotId,
    }));
    // localStorage + Supabase
    get().saveTimers();
    syncStateToSupabase();
  },

  resetSlot: (id: string) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) =>
        slot.id === id
          ? {
              ...slot,
              startTime: new Date(),
              pausedMs: 0,
              isPaused: true,
              is_running: false,
              elapsed_ms: 0,
            }
          : slot
      ),
      activeSlotId: state.activeSlotId === id ? null : state.activeSlotId,
    }));
    // Sync reset state to other devices
    get().saveTimers();
    syncStateToSupabase();
  },

  updateSlotField: (id, field, value) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) =>
        slot.id === id ? { ...slot, [field]: value } : slot
      ),
    }));
  },

  addSlotStakeholder: (id, stakeholder) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) =>
        slot.id === id && !slot.stakeholder.includes(stakeholder)
          ? { ...slot, stakeholder: [...slot.stakeholder, stakeholder] }
          : slot
      ),
    }));
  },

  removeSlotStakeholder: (id, stakeholder) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) =>
        slot.id === id
          ? { ...slot, stakeholder: slot.stakeholder.filter((s) => s !== stakeholder) }
          : slot
      ),
    }));
  },

  startTimer: (id: string) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) =>
        slot.id === id
          ? {
              ...slot,
              startTime: new Date(),
              pausedMs: 0,
              isPaused: false,
              is_running: true,
            }
          : slot
      ),
      activeSlotId: id,
    }));

    ensureTickInterval(get, set);
    get().saveTimers();
    syncStateToSupabase();
  },

  pauseTimer: (id: string) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) => {
        if (slot.id === id && !slot.isPaused) {
          const elapsed =
            Date.now() - slot.startTime.getTime() + slot.pausedMs;
          return {
            ...slot,
            pausedMs: elapsed,
            isPaused: true,
            is_running: false,
          };
        }
        return slot;
      }),
      activeSlotId: null,
    }));

    get().saveTimers();
    syncStateToSupabase();
  },

  resumeTimer: (id: string) => {
    set((state) => ({
      taskSlots: state.taskSlots.map((slot) =>
        slot.id === id && slot.isPaused
          ? {
              ...slot,
              startTime: new Date(),
              isPaused: false,
              is_running: true,
            }
          : slot
      ),
      activeSlotId: id,
    }));

    ensureTickInterval(get, set);
    get().saveTimers();
    syncStateToSupabase();
  },

  stopTimer: (id: string) => {
    const state = get();
    const slot = state.taskSlots.find((s) => s.id === id);
    if (!slot) return;

    // Calculate final duration
    const totalMs =
      slot.pausedMs +
      (slot.isPaused ? 0 : Date.now() - slot.startTime.getTime());
    // Minimum 1 second to save
    if (totalMs < 1000) {
      set({ error: 'Timer too short' });
      return;
    }

    // Calculate start and end times
    const now = new Date();
    const endTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const startDate = new Date(now.getTime() - totalMs);
    const startTime = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;

    // Save entry to entries store
    try {
      const entriesStore = useEntriesStore.getState();
      const authStore = useAuthStore.getState();

      entriesStore.add({
        date: slot.date || now.toISOString().split('T')[0],
        stakeholder: slot.stakeholder || [],
        projekt: slot.projekt || '',
        taetigkeit: slot.taetigkeit || '',
        format: slot.format || 'Einzelarbeit',
        start_time: startTime,
        end_time: endTime,
        duration_ms: totalMs,
        notiz: slot.notiz || '',
        user_id: authStore.profile?.id || 'local',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Save note to suggestion history
      if (slot.notiz) saveNoteToHistory(slot.notiz);
    } catch (e) {
      console.error('[TimerSync] entriesStore.add failed:', e);
    }

    // Remove the stopped slot entirely
    set((st) => ({
      taskSlots: st.taskSlots.filter((s) => s.id !== id),
      activeSlotId: st.activeSlotId === id ? null : st.activeSlotId,
    }));
    // Check if any active timers remain
    const remaining = get().taskSlots;
    const hasActive = remaining.some((s) => !s.isPaused);
    if (!hasActive && state.tickInterval) {
      clearInterval(state.tickInterval);
      set({ tickInterval: null });
    }

    // Save to localStorage + push to Supabase
    get().saveTimers();
    syncStateToSupabase();
  },

  stopAllTimers: () => {
    const state = get();
    const runningSlots = state.taskSlots.filter((s) => !s.isPaused || s.pausedMs > 0);
    runningSlots.forEach((slot) => {
      const totalMs = slot.pausedMs + (slot.isPaused ? 0 : Date.now() - slot.startTime.getTime());
      if (totalMs >= 1000) {
        get().stopTimer(slot.id);
      }
    });

    if (state.tickInterval) {
      clearInterval(state.tickInterval);
      set({ tickInterval: null });
    }
  },

  getSlotElapsed: (id: string) => {
    const state = get();
    const slot = state.taskSlots.find((s) => s.id === id);
    if (!slot) return 0;

    if (slot.isPaused) {
      return slot.pausedMs;
    }

    return slot.pausedMs + (Date.now() - slot.startTime.getTime());
  },

  tick: () => {
    set((state) => ({
      taskSlots: state.taskSlots.length > 0 ? [...state.taskSlots] : [],
    }));

    const state = get();
    const hasActive = state.taskSlots.some((s) => !s.isPaused);

    if (!hasActive && state.tickInterval) {
      clearInterval(state.tickInterval);
      set({ tickInterval: null });
    }
  },

  // ── Persistence (localStorage ONLY — never touches Supabase) ────────

  saveTimers: () => {
    const state = get();
    if (state.taskSlots.length === 0) {
      removeUserData('timerSlots');
      return;
    }

    const serialized = serializeSlots(state.taskSlots);
    const saved: SavedTimerState = { slots: serialized, savedAt: Date.now() };
    setUserData('timerSlots', saved);
  },

  restoreTimers: async () => {
    const profile = useAuthStore.getState().profile;
    let saved: SavedTimerState | null = null;

    if (isSupabaseAvailable() && supabaseClient && profile?.id && !profile.id.startsWith('local_')) {
      try {
        const { data, error } = await supabaseClient
          .from('running_timers')
          .select('*')
          .eq('user_id', profile.id);

        if (!error && data && data.length > 0) {
          const sbSlots: SerializedSlot[] = data.map((row: any) => ({
            id: row.id,
            date: row.date || '',
            stakeholder: JSON.parse(row.stakeholder || '[]'),
            projekt: row.projekt || '',
            taetigkeit: row.taetigkeit || '',
            format: row.format || 'Einzelarbeit',
            start_time: row.start_time || '',
            notiz: row.notiz || '',
            is_running: row.was_running,
            color: row.color || '',
            pausedMs: Number(row.paused_ms) || 0,
            isPaused: row.is_paused,
            wasRunning: row.was_running,
            elapsed_ms: 0,
          }));
          const savedAt = Math.max(...data.map((r: any) => Number(r.saved_at) || 0));
          saved = { slots: sbSlots, savedAt };
        }
      } catch (e) {
        // Supabase restore failed, fall back to localStorage
      }
    }

    if (!saved) {
      saved = getUserData<SavedTimerState | null>('timerSlots', null);
    }

    if (!saved || !saved.slots || saved.slots.length === 0) return;

    const now = Date.now();
    const elapsed = now - saved.savedAt;
    let hasRunning = false;

    const restored: TimerSlot[] = saved.slots.map((s, idx) => {
      const wasRunning = s.wasRunning;

      if (wasRunning) {
        hasRunning = true;
        return {
          id: s.id,
          date: s.date,
          stakeholder: s.stakeholder,
          projekt: s.projekt,
          taetigkeit: s.taetigkeit,
          format: s.format || 'Einzelarbeit',
          start_time: s.start_time,
          elapsed_ms: s.elapsed_ms,
          notiz: s.notiz,
          is_running: true,
          color: s.color || TIMER_PALETTE[idx % TIMER_PALETTE.length],
          startTime: new Date(),
          pausedMs: s.pausedMs + elapsed,
          isPaused: false,
        };
      }

      return {
        id: s.id,
        date: s.date,
        stakeholder: s.stakeholder,
        projekt: s.projekt,
        taetigkeit: s.taetigkeit,
        format: s.format || 'Einzelarbeit',
        start_time: s.start_time,
        elapsed_ms: s.elapsed_ms,
        notiz: s.notiz,
        is_running: false,
        color: s.color || TIMER_PALETTE[idx % TIMER_PALETTE.length],
        startTime: new Date(),
        pausedMs: s.pausedMs,
        isPaused: true,
      };
    });

    set({ taskSlots: restored });

    if (hasRunning) {
      ensureTickInterval(get, set);
    }

    removeUserData('timerSlots');
  },

  setError: (error: string | null) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },
}));

// Save timers to localStorage before unload (+ push to Supabase)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    useTimerStore.getState().saveTimers();
    syncStateToSupabase();
  });
}

// ── Supabase Push (fire-and-forget) ─────────────────────────────────────
// Includes session check and exponential backoff on auth/RLS errors
// to prevent console spam when the JWT has expired.

let _pushBackoffUntil = 0;
let _pushBackoffMs = 2000; // starts at 2s, doubles on each failure, max 60s

async function pushTimersToSupabase(slots: SerializedSlot[]): Promise<void> {
  // Backoff: skip if we recently failed
  if (Date.now() < _pushBackoffUntil) return;

  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !profile?.id || profile.id.startsWith('local_')) return;

  try {
    // Verify we have a valid session before attempting any DB operation
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) {
      // No valid session — back off to avoid spamming
      _pushBackoffUntil = Date.now() + _pushBackoffMs;
      _pushBackoffMs = Math.min(_pushBackoffMs * 2, 60000);
      return;
    }

    // Delete all existing timers for this user
    const { error: delError } = await supabaseClient
      .from('running_timers')
      .delete()
      .eq('user_id', profile.id);

    if (delError) {
      // Auth or RLS error on delete — back off
      _pushBackoffUntil = Date.now() + _pushBackoffMs;
      _pushBackoffMs = Math.min(_pushBackoffMs * 2, 60000);
      return;
    }

    if (slots.length === 0) {
      _pushBackoffMs = 2000; // reset on success
      return;
    }

    // Insert current timer state
    const rows = slots.map((s) => ({
      id: s.id,
      user_id: profile.id,
      date: s.date,
      stakeholder: JSON.stringify(s.stakeholder),
      projekt: s.projekt,
      taetigkeit: s.taetigkeit,
      format: s.format,
      start_time: s.start_time,
      notiz: s.notiz || '',
      color: s.color,
      paused_ms: s.pausedMs,
      is_paused: s.isPaused,
      was_running: s.wasRunning,
      saved_at: Date.now(),
    }));

    const { error: insError } = await supabaseClient
      .from('running_timers')
      .insert(rows);

    if (insError) {
      console.warn('[TimerSync] push skipped — session may have expired');
      _pushBackoffUntil = Date.now() + _pushBackoffMs;
      _pushBackoffMs = Math.min(_pushBackoffMs * 2, 60000);
    } else {
      _pushBackoffMs = 2000; // reset on success
    }
  } catch (e) {
    // silent — network error
    _pushBackoffUntil = Date.now() + _pushBackoffMs;
    _pushBackoffMs = Math.min(_pushBackoffMs * 2, 60000);
  }
}

// ── Cross-Device Polling ────────────────────────────────────────────────

let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _realtimeChannel: any = null;

export async function pullTimersFromSupabase(): Promise<void> {
  // Skip if we recently pushed (prevents reading stale data during async DELETE+INSERT)
  if (Date.now() < _suppressUntil) return;

  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !profile?.id) return;

  // Ensure auth session is valid before querying (avoids 401 spam)
  const sessionOk = await ensureValidSession();
  if (!sessionOk) return;

  try {
    const { data, error } = await supabaseClient
      .from('running_timers')
      .select('*')
      .eq('user_id', profile.id);

    if (error) return;

    // Re-check suppress AFTER the async query. A local push may have started
    // while this query was in flight, meaning we're reading stale data.
    if (Date.now() < _suppressUntil) return;

    const localSlots = useTimerStore.getState().taskSlots;

    // ── Remote is empty → clear local timers ──
    // Trust the remote state: if timers were stopped on another device,
    // that device deleted them from Supabase. The suppress window on the
    // pushing device already prevents reading stale data during DELETE+INSERT.
    if (!data || data.length === 0) {
      if (localSlots.length > 0) {
        // Safety: if a sync push is currently pending (debounced), don't
        // clear — our local state hasn't been pushed yet and the remote
        // is still stale. This prevents the 300ms debounce window from
        // causing a race where a just-started timer gets cleared.
        if (_syncDebounce) return;

        const s = useTimerStore.getState();
        if (s.tickInterval) clearInterval(s.tickInterval);
        useTimerStore.setState({ taskSlots: [], tickInterval: null, activeSlotId: null });
        // Also clear localStorage so a page refresh doesn't restore ghost timers
        removeUserData('timerSlots');
      }
      return;
    }

    // ── Quick check: has anything changed? ────────────────────────
    const remoteKey = data
      .map((r: any) => `${r.id}:${r.was_running}`)
      .sort()
      .join(',');
    const localKey = localSlots
      .map((s) => `${s.id}:${!s.isPaused}`)
      .sort()
      .join(',');

    if (remoteKey === localKey) return;

    // ── Rebuild local state from remote ───────────────────────────
    const now = Date.now();
    const remoteSavedAt = Math.max(...data.map((r: any) => Number(r.saved_at) || 0));
    const elapsed = remoteSavedAt > 0 ? now - remoteSavedAt : 0;
    let hasRunning = false;

    const restored: TimerSlot[] = data.map((row: any, idx: number) => {
      const wasRunning = row.was_running;
      const pausedMs = Number(row.paused_ms) || 0;

      if (wasRunning) {
        hasRunning = true;
        return {
          id: row.id,
          date: row.date || '',
          stakeholder: JSON.parse(row.stakeholder || '[]'),
          projekt: row.projekt || '',
          taetigkeit: row.taetigkeit || '',
          format: row.format || 'Einzelarbeit',
          start_time: row.start_time || '',
          elapsed_ms: 0,
          notiz: row.notiz || '',
          is_running: true,
          color: row.color || TIMER_PALETTE[idx % TIMER_PALETTE.length],
          startTime: new Date(),
          pausedMs: pausedMs + elapsed,
          isPaused: false,
        };
      }

      return {
        id: row.id,
        date: row.date || '',
        stakeholder: JSON.parse(row.stakeholder || '[]'),
        projekt: row.projekt || '',
        taetigkeit: row.taetigkeit || '',
        format: row.format || 'Einzelarbeit',
        start_time: row.start_time || '',
        elapsed_ms: 0,
        notiz: row.notiz || '',
        is_running: false,
        color: row.color || TIMER_PALETTE[idx % TIMER_PALETTE.length],
        startTime: new Date(),
        pausedMs,
        isPaused: true,
      };
    });

    // Clear old tick interval
    const oldState = useTimerStore.getState();
    if (oldState.tickInterval) clearInterval(oldState.tickInterval);

    useTimerStore.setState({ taskSlots: restored, tickInterval: null, activeSlotId: null });

    // Restart tick if needed
    if (hasRunning) {
      const interval = setInterval(() => {
        useTimerStore.getState().tick();
      }, 500);
      useTimerStore.setState({ tickInterval: interval });
    }
  } catch (e) {
    // silent
  }
}

export function subscribeToTimerSync(): void {
  const profile = useAuthStore.getState().profile;
  if (!isSupabaseAvailable() || !supabaseClient || !profile?.id || profile.id.startsWith('local_')) return;

  unsubscribeFromTimerSync();

  // Realtime is primary for instant updates; polling is safety net only

  // Safety-net polling every 30s (Realtime handles real-time sync)
  _pollInterval = setInterval(() => {
    pullTimersFromSupabase();
  }, 30_000);

  // Primary: Realtime for instant cross-device updates
  try {
    _realtimeChannel = supabaseClient
      .channel(`timers-${profile.id}`)
      .on(
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'running_timers',
          filter: `user_id=eq.${profile.id}`,
        },
        () => {
          // On any remote change, pull immediately (if not suppressed)
          setTimeout(() => pullTimersFromSupabase(), 500);
        }
      )
      .subscribe();
  } catch (e) {
    // Realtime failed, polling is the fallback
  }
}

export function unsubscribeFromTimerSync(): void {
  if (_realtimeChannel && supabaseClient) {
    try { supabaseClient.removeChannel(_realtimeChannel); } catch (_) {}
    _realtimeChannel = null;
  }
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}
