import { createClient, SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

let client: SupabaseClient | null = null

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'zeiterfassung_auth',
    },
  })
} else {
  console.warn('Supabase credentials missing – running in offline/local mode')
}

export const supabaseClient = client

/**
 * Check if Supabase is available and connected
 */
export function isSupabaseAvailable(): boolean {
  return client !== null
}

// ── Health-circuit-breaker ───────────────────────────────────────────
//
// When Supabase returns 503 (or repeated network errors), we enter a
// backoff window where non-essential calls become no-ops. This stops
// the app from DDoS'ing a struggling DB during the 5-min recovery
// after a restart, and gives PostgREST time to load its schema cache.
//
// The auth flow ignores the breaker (auth must always be tried), but
// every store fetch / poll / realtime-pulled refresh checks
// isSupabaseInBackoff() before issuing its query.

let _supabaseBackoffUntil = 0;
let _consecutive503s = 0;

const BASE_BACKOFF_MS = 30_000;       // 30s after first 503
const MAX_BACKOFF_MS = 5 * 60_000;    // cap at 5min

/**
 * Mark a 503/network-error from Supabase. Triggers an exponential backoff
 * window during which isSupabaseInBackoff() returns true.
 */
export function noteSupabaseUnavailable(reason?: string): void {
  _consecutive503s += 1;
  const ms = Math.min(BASE_BACKOFF_MS * Math.pow(2, _consecutive503s - 1), MAX_BACKOFF_MS);
  _supabaseBackoffUntil = Date.now() + ms;
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[Supabase] Backing off for ${Math.round(ms / 1000)}s due to: ${reason || '503'}`);
  }
}

/** Mark a successful Supabase response — resets the backoff counter. */
export function noteSupabaseHealthy(): void {
  if (_consecutive503s > 0) {
    _consecutive503s = 0;
    _supabaseBackoffUntil = 0;
  }
}

/** True when we should skip non-essential Supabase calls. */
export function isSupabaseInBackoff(): boolean {
  return Date.now() < _supabaseBackoffUntil;
}

/**
 * Ensure the Supabase session is valid (refresh if expired).
 * Returns true if authenticated, false if no valid session.
 */
export async function ensureValidSession(): Promise<boolean> {
  if (!client) return false
  try {
    const { data: { session } } = await client.auth.getSession()
    if (!session) return false
    // Check if token expires within 60 seconds — proactively refresh
    const expiresAt = session.expires_at || 0
    if (expiresAt * 1000 - Date.now() < 60000) {
      const { data, error } = await client.auth.refreshSession()
      if (error || !data.session) return false
    }
    return true
  } catch {
    return false
  }
}
