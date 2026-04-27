import { useEffect, useRef, useCallback } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { useEntriesStore, pullEntriesFromSupabase } from '@/stores/entriesStore'
import { useMasterStore, pullMasterDataFromSupabase } from '@/stores/masterStore'
import { useTeamStore } from '@/stores/teamStore'
import { useTimerStore, subscribeToTimerSync, unsubscribeFromTimerSync, pullTimersFromSupabase } from '@/stores/timerStore'
import { subscribeToMasterSync, unsubscribeFromMasterSync } from '@/stores/masterStore'
import { subscribeToEntriesSync, unsubscribeFromEntriesSync } from '@/stores/entriesStore'
import { subscribeToTeamSync, unsubscribeFromTeamSync } from '@/stores/teamStore'
import { I18nProvider, useI18n } from '@/i18n'
import Layout from '@/components/Layout'
import LoginScreen from '@/components/Auth/LoginScreen'
import UnlockScreen from '@/components/Auth/UnlockScreen'

function AppContent() {
  const { t } = useI18n()
  const { isAuthenticated, loading, needsPassword, initializeAuth } = useAuthStore()
  const { theme } = useUiStore()
  const fetchEntries = useEntriesStore((s) => s.fetch)
  const fetchMaster = useMasterStore((s) => s.fetch)
  const syncTeam = useTeamStore((s) => s.syncTeamData)
  const restoreTimers = useTimerStore((s) => s.restoreTimers)

  useEffect(() => {
    initializeAuth()
  }, [initializeAuth])

  // Load user-scoped data once authenticated AND encryption key is available.
  //
  // CRITICAL: syncTeam MUST complete first to restore the Team Key before
  // fetching entries/master data. Otherwise decryptFieldSmart fails because
  // the Team Key isn't in sessionStorage yet, causing all encrypted text
  // fields (stakeholder, projekt, etc.) to decrypt as empty strings.
  //
  // STAGED BOOT (added after the Disk-IO 85% incident):
  // The previous flow fired ~7 queries simultaneously on app boot. With a
  // resource-stressed Supabase instance, that boot burst was enough to
  // push PostgREST back into 'schema cache failed to load' (503 storm)
  // immediately after a restart — a self-DoS loop. We now SEQUENCE the
  // boot steps with small gaps so the DB has breathing room between
  // bursts. localStorage already serves the UI during this delay, so the
  // user-perceived load time is unchanged.
  const loadAllData = useCallback(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      // Step 1: Restore team key (fast — single row query). Always first.
      await syncTeam()
      subscribeToTeamSync()
    } catch {
      // Team sync failed (offline?) — continue with personal key
    }
    await sleep(800);

    // Step 2: Entries — most user-facing data, prioritised before master data.
    try { await fetchEntries() } catch {}
    subscribeToEntriesSync()
    await sleep(800);

    // Step 3: Master data — 4 queries internally; can wait a beat.
    try { await fetchMaster() } catch {}
    subscribeToMasterSync()
    await sleep(800);

    // Step 4: Running timers — non-encrypted, last in line.
    try { await restoreTimers() } catch {}
    subscribeToTimerSync()
  }, [syncTeam, fetchEntries, fetchMaster, restoreTimers])

  useEffect(() => {
    if (isAuthenticated && !needsPassword) {
      loadAllData()
    }

    return () => {
      unsubscribeFromTimerSync()
      unsubscribeFromMasterSync()
      unsubscribeFromEntriesSync()
      unsubscribeFromTeamSync()
    }
  }, [isAuthenticated, needsPassword, loadAllData])

  // Re-sync when app becomes visible (mobile background → foreground, tab switch)
  // Browsers pause WebSocket connections and throttle setInterval in background tabs.
  // Without this, the app shows stale data after returning from background.
  const lastVisibilitySync = useRef(0)
  useEffect(() => {
    if (!isAuthenticated || needsPassword) return

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      // Throttle: at most once per 5 seconds
      const now = Date.now()
      if (now - lastVisibilitySync.current < 5000) return
      lastVisibilitySync.current = now

      // Pull timers IMMEDIATELY without waiting for team sync. Timers do not
      // contain encrypted fields, so we don't need the Team Key. Waiting
      // behind syncTeam (which may take 1-2s on mobile) caused the timer to
      // appear to keep ticking after being stopped on another device.
      pullTimersFromSupabase()

      // Re-sync team key first, then pull fresh encrypted data
      syncTeam().then(() => {
        pullEntriesFromSupabase()
        pullMasterDataFromSupabase()
      }).catch(() => {
        // Team sync failed — still try to pull with existing keys
        pullEntriesFromSupabase()
        pullMasterDataFromSupabase()
      })
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [isAuthenticated, needsPassword, syncTeam])

  useEffect(() => {
    const html = document.documentElement
    html.setAttribute('data-theme', theme === 'light' ? 'light' : 'cyber')
  }, [theme])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="text-center">
          <div className="w-12 h-12 border-4 rounded-full animate-spin mx-auto mb-4"
            style={{ borderColor: 'var(--border)', borderTopColor: 'var(--neon-cyan)' }} />
          <p style={{ color: 'var(--text-secondary)' }}>{t('ui.loading')}</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginScreen />
  }

  // Session exists but encryption key is missing → prompt for password
  if (needsPassword) {
    return <UnlockScreen />
  }

  return <Layout />
}

export default function App() {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  )
}
