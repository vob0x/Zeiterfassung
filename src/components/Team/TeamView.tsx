import { useState, useEffect, useMemo } from 'react';
import { useI18n } from '../../i18n';
import { useTeamStore } from '../../stores/teamStore';
import { useEntriesStore, reEncryptEntriesForTeam } from '../../stores/entriesStore';
import { useMasterStore, syncAllMasterData } from '../../stores/masterStore';
import { useUiStore } from '../../stores/uiStore';
import { isSupabaseAvailable } from '../../lib/supabase';
import ConfirmDialog from '../UI/ConfirmDialog';
import { PeriodType, TimeEntry } from '@/types';
import { formatDateISO, formatDateDE } from '../../lib/utils';
import { TeamDaily } from './TeamDaily';
import { TeamMatrix } from './TeamMatrix';
import { TeamWorkload } from './TeamWorkload';
import { TeamTimeline } from './TeamTimeline';
import { useAuthStore } from '../../stores/authStore';
import { Copy, Users, UserPlus, UserMinus, Wifi, WifiOff, QrCode, Camera, RefreshCw, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';

// Helper: get ISO week number
function getISOWeek(date: Date): number {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

const MONTH_NAMES_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTH_NAMES_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const DAY_NAMES_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAY_NAMES_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
import QRScanner from './QRScanner';

export default function TeamView() {
  const { t, language } = useI18n();
  const { team, members, memberEntries, connected, syncTeamData, leaveTeam, removeMember, createTeam, joinTeam } = useTeamStore();
  const profile = useAuthStore((s) => s.profile);
  const isCreator = team?.creator_id === profile?.id;
  const entries = useEntriesStore((state) => state.entries);
  const showToast = useUiStore((state) => state.showToast);
  const { period, setTeamPeriod } = useTeamStore();

  const [teamName, setTeamName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [setupMode, setSetupMode] = useState<'create' | 'join' | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [teamOffset, setTeamOffset] = useState(0);

  const monthNames = language === 'fr' ? MONTH_NAMES_FR : MONTH_NAMES_DE;
  const dayNames = language === 'fr' ? DAY_NAMES_FR : DAY_NAMES_DE;

  const isOnline = isSupabaseAvailable();

  // Auto-detect ?join=CODE in URL (from QR scan)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode && !connected) {
      setInviteCode(joinCode.toUpperCase());
      setSetupMode('join');
      // Clean URL without reload
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [connected]);

  const handleCreateTeam = async (name: string) => {
    if (!name.trim()) {
      showToast(t('team.nameRequired'), 'error');
      return;
    }

    setIsCreating(true);
    try {
      await createTeam(name);
      showToast(`${t('toast.connected')} ${name}`, 'success');
      setTeamName('');
      setSetupMode(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinTeam = async (code: string) => {
    if (!code.trim()) {
      showToast(t('team.codeRequired'), 'error');
      return;
    }

    setIsJoining(true);
    try {
      await joinTeam(code);
      // CRITICAL: Re-encrypt the user's existing data with the Team Key so
      // teammates can read it, then re-fetch everything (master + entries)
      // so RLS-visible teammate rows are pulled with the new Team Key.
      // Without this, the user sees empty Stakeholder/Projekt/Tätigkeit lists
      // and teammates can't decrypt this user's entries.
      try {
        // 1. Re-encrypt own data: Personal Key → Team Key
        //    (runs in background, non-blocking for the toast)
        syncAllMasterData();           // master data (stakeholders, projects, …)
        reEncryptEntriesForTeam();     // time_entries
        // 2. Re-fetch to pull teammates' data
        await useMasterStore.getState().fetch();
        await useEntriesStore.getState().fetch();
      } catch (e) {
        console.warn('[Team Join] Post-join data refresh failed:', e);
      }
      showToast(t('toast.syncOk'), 'success');
      setInviteCode('');
      setTeamName('');
      setSetupMode(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg === 'INVALID_INVITE_CODE') {
        showToast(t('team.invalidCode'), 'error');
      } else {
        showToast(msg || t('toast.error'), 'error');
      }
    } finally {
      setIsJoining(false);
    }
  };

  const handleSync = async () => {
    try {
      await syncTeamData();
      showToast(t('toast.syncOk'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleLeaveTeam = async () => {
    try {
      await leaveTeam();
      showToast(t('toast.disconnected'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleCopyInviteCode = () => {
    if (team?.invite_code) {
      navigator.clipboard.writeText(team.invite_code);
      showToast(t('settings.copied'), 'success');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    try {
      await removeMember(userId);
      showToast(t('team.memberRemoved'), 'success');
      setRemovingMember(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
      setRemovingMember(null);
    }
  };

  // Compute date range from selected period + offset
  const { dateRange, teamPeriodLabel } = useMemo(() => {
    const today = new Date();
    const todayISO = formatDateISO(today);

    switch (period) {
      case 'day': {
        const d = new Date(today);
        d.setDate(d.getDate() + teamOffset);
        const iso = formatDateISO(d);
        const label = teamOffset === 0
          ? t('dash.today')
          : `${dayNames[d.getDay()]}, ${formatDateDE(iso)}`;
        return { dateRange: { start: iso, end: iso }, teamPeriodLabel: label };
      }
      case 'week': {
        const day = today.getDay();
        const diff = day === 0 ? 6 : day - 1;
        const monday = new Date(today);
        monday.setDate(today.getDate() - diff + teamOffset * 7);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const end = sunday > today && teamOffset === 0 ? todayISO : formatDateISO(sunday);
        const weekNum = getISOWeek(monday);
        const label = teamOffset === 0
          ? `KW ${weekNum} (${t('dash.thisWeek')})`
          : `KW ${weekNum} · ${formatDateDE(formatDateISO(monday))} – ${formatDateDE(end)}`;
        return { dateRange: { start: formatDateISO(monday), end }, teamPeriodLabel: label };
      }
      case 'month': {
        const m = new Date(today.getFullYear(), today.getMonth() + teamOffset, 1);
        const lastDay = new Date(m.getFullYear(), m.getMonth() + 1, 0);
        const end = lastDay > today && teamOffset === 0 ? todayISO : formatDateISO(lastDay);
        const label = teamOffset === 0
          ? `${monthNames[m.getMonth()]} ${m.getFullYear()} (${t('dash.thisMonth')})`
          : `${monthNames[m.getMonth()]} ${m.getFullYear()}`;
        return { dateRange: { start: formatDateISO(m), end }, teamPeriodLabel: label };
      }
      case 'year': {
        const y = today.getFullYear() + teamOffset;
        const jan1 = new Date(y, 0, 1);
        const dec31 = new Date(y, 11, 31);
        const end = dec31 > today && teamOffset === 0 ? todayISO : formatDateISO(dec31);
        const label = teamOffset === 0
          ? `${y} (${t('dash.thisYear')})`
          : `${y}`;
        return { dateRange: { start: formatDateISO(jan1), end }, teamPeriodLabel: label };
      }
      case 'all':
        return { dateRange: { start: null, end: null }, teamPeriodLabel: t('dash.all') };
      default:
        return { dateRange: { start: null, end: null }, teamPeriodLabel: '' };
    }
  }, [period, teamOffset, t, language, monthNames, dayNames]);

  // Filter entries by period
  const filterByPeriod = (entries: TimeEntry[]): TimeEntry[] => {
    if (!dateRange.start && !dateRange.end) return entries;
    return entries.filter((e) => {
      if (dateRange.start && e.date < dateRange.start) return false;
      if (dateRange.end && e.date > dateRange.end) return false;
      return true;
    });
  };

  // Period-filtered team entries and member entries
  const filteredMemberEntries = useMemo(() => {
    const filtered = new Map<string, TimeEntry[]>();
    memberEntries.forEach((entries, memberId) => {
      filtered.set(memberId, filterByPeriod(entries));
    });
    return filtered;
  }, [memberEntries, dateRange]);

  const allTeamEntries = useMemo(() =>
    Array.from(filteredMemberEntries.values()).flat(),
    [filteredMemberEntries]
  );

  // Compute KPIs from filtered data
  const totalHours = allTeamEntries.reduce((sum, entry) => sum + (entry.duration_ms || 0) / (1000 * 60 * 60), 0);
  const personCount = members.length;
  const entryCount = allTeamEntries.length;
  const avgPerPerson = personCount > 0 ? totalHours / personCount : 0;
  const workingDays = new Set(allTeamEntries.map((e) => e.date)).size || 1;
  const avgPerDay = workingDays > 0 ? totalHours / workingDays : 0;

  // ========================================================================
  // NOT CONNECTED — Setup Screen
  // ========================================================================
  if (!connected) {
    return (
      <div className="w-full max-w-2xl mx-auto p-4">
        <div className="rounded-lg p-6 backdrop-blur-sm space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-6 h-6" style={{ color: 'var(--neon-cyan)' }} />
            <h2 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>{t('team.setupText')}</h2>
          </div>

          {/* Connection status indicator */}
          <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-md"
            style={{
              background: isOnline ? 'rgba(110,196,158,0.08)' : 'rgba(229,168,75,0.08)',
              color: isOnline ? 'var(--success)' : 'var(--warning)',
            }}>
            {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {isOnline ? t('team.onlineMode') : t('team.offlineMode')}
          </div>

          {setupMode === null && (
            <div className="flex gap-3">
              <button
                onClick={() => setSetupMode('create')}
                className="flex-1 px-4 py-3 rounded font-medium transition-all flex items-center justify-center gap-2"
                style={{ background: 'rgba(201,169,98,0.07)', border: '1px solid rgba(201,169,98,0.18)', color: 'var(--neon-cyan)' }}
              >
                <Users className="w-4 h-4" />
                {t('team.create')}
              </button>
              <button
                onClick={() => setSetupMode('join')}
                className="flex-1 px-4 py-3 rounded font-medium transition-all flex items-center justify-center gap-2"
                style={{ background: 'rgba(110,196,158,0.08)', border: '1px solid rgba(110,196,158,0.18)', color: 'var(--success)' }}
              >
                <UserPlus className="w-4 h-4" />
                {t('team.join')}
              </button>
            </div>
          )}

          {/* CREATE TEAM */}
          {setupMode === 'create' && (
            <div className="space-y-3">
              <input
                type="text"
                placeholder={t('ph.teamNameInput')}
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                className="w-full px-4 py-2 rounded border focus:outline-none"
                style={{ background: 'var(--surface-solid)', color: 'var(--text)', borderColor: 'var(--border)' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateTeam(teamName);
                }}
                disabled={isCreating}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleCreateTeam(teamName)}
                  disabled={isCreating}
                  className="flex-1 px-4 py-2 rounded font-medium transition-all"
                  style={{ background: 'rgba(201,169,98,0.07)', border: '1px solid rgba(201,169,98,0.18)', color: 'var(--neon-cyan)', opacity: isCreating ? 0.6 : 1 }}
                >
                  {isCreating ? t('ui.loading') : t('team.create')}
                </button>
                <button
                  onClick={() => { setSetupMode(null); setTeamName(''); }}
                  className="px-4 py-2 rounded font-medium transition-colors"
                  style={{ background: 'var(--surface-solid)', color: 'var(--text)' }}
                >
                  {t('btn.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* JOIN TEAM */}
          {setupMode === 'join' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder={t('team.inviteCodePlaceholder')}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  className="flex-1 px-4 py-3 rounded border font-mono text-center text-lg tracking-widest focus:outline-none"
                  style={{ background: 'var(--surface-solid)', color: 'var(--text)', borderColor: 'var(--border)', letterSpacing: '0.3em' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && inviteCode.length === 6) handleJoinTeam(inviteCode);
                  }}
                  disabled={isJoining}
                />
                <button
                  onClick={() => setShowScanner(true)}
                  className="px-4 py-3 rounded border flex items-center gap-2 transition-all"
                  style={{ background: 'rgba(201,169,98,0.05)', borderColor: 'rgba(201,169,98,0.15)', color: 'var(--neon-cyan)' }}
                  title={t('team.scanQR') || 'QR scannen'}
                >
                  <Camera className="w-5 h-5" />
                </button>
              </div>
              {/* In offline mode, also ask for a team name since we can't look it up */}
              {!isOnline && (
                <input
                  type="text"
                  placeholder={t('team.yourName')}
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  className="w-full px-4 py-2 rounded border focus:outline-none"
                  style={{ background: 'var(--surface-solid)', color: 'var(--text)', borderColor: 'var(--border)' }}
                  disabled={isJoining}
                />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => handleJoinTeam(inviteCode)}
                  disabled={isJoining || inviteCode.length < 6}
                  className="flex-1 px-4 py-2 rounded font-medium transition-all"
                  style={{
                    background: 'rgba(110,196,158,0.08)',
                    border: '1px solid rgba(110,196,158,0.18)',
                    color: 'var(--success)',
                    opacity: isJoining || inviteCode.length < 6 ? 0.5 : 1,
                  }}
                >
                  {isJoining ? t('ui.loading') : t('team.join')}
                </button>
                <button
                  onClick={() => { setSetupMode(null); setTeamName(''); setInviteCode(''); }}
                  className="px-4 py-2 rounded font-medium transition-colors"
                  style={{ background: 'var(--surface-solid)', color: 'var(--text)' }}
                >
                  {t('btn.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* QR Scanner Modal */}
        {showScanner && (
          <QRScanner
            onScan={(code) => {
              setInviteCode(code);
              setShowScanner(false);
              // Auto-join if we got a valid 6-char code
              if (code.length === 6) {
                handleJoinTeam(code);
              }
            }}
            onClose={() => setShowScanner(false)}
          />
        )}
      </div>
    );
  }

  // ========================================================================
  // CONNECTED — Team Dashboard
  // ========================================================================
  return (
    <div className="w-full max-w-7xl mx-auto p-4 space-y-6">
      {/* Team Header */}
      <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>{team?.name}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {members.length} {t('team.persons')}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSync}
              className="px-4 py-2 rounded font-medium transition-all flex items-center gap-2"
              style={{ background: 'rgba(201,169,98,0.07)', border: '1px solid rgba(201,169,98,0.18)', color: 'var(--neon-cyan)' }}
            >
              <RefreshCw className="w-4 h-4" />
              {t('team.sync')}
            </button>
            <button
              onClick={() => setShowDisconnectConfirm(true)}
              className="px-4 py-2 rounded font-medium transition-all"
              style={{ background: 'rgba(212,112,110,0.08)', border: '1px solid rgba(212,112,110,0.18)', color: 'var(--danger)' }}
            >
              {t('team.disconnect')}
            </button>
          </div>
        </div>

        {/* Invite Code Section — always visible for team members */}
        {team?.invite_code && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.inviteCode')}:</span>
              <code className="font-mono text-sm font-bold px-3 py-1 rounded tracking-widest"
                style={{ background: 'rgba(201,169,98,0.08)', color: 'var(--neon-cyan)', letterSpacing: '0.15em' }}>
                {team.invite_code}
              </code>
              <button
                onClick={handleCopyInviteCode}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'var(--surface-solid)' }}
                title={t('settings.copied')}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setShowQR(!showQR)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
                style={{ color: showQR ? 'var(--neon-cyan)' : 'var(--text-secondary)', background: 'var(--surface-solid)' }}
                title="QR Code"
              >
                <QrCode className="w-3.5 h-3.5" />
              </button>
              {/* Member avatars */}
              <div className="flex items-center gap-1 ml-auto flex-wrap">
              {members.map((m) => {
                const isSelf = m.user_id === profile?.id;
                return (
                  <span key={m.id}
                    className="text-xs px-2 py-1 rounded-full font-medium inline-flex items-center gap-1"
                    style={{ background: 'rgba(155,142,196,0.1)', color: 'var(--neon-violet, #9B8EC4)' }}>
                    {m.display_name || m.user_id}
                    {isCreator && !isSelf && (
                      <button
                        onClick={() => setRemovingMember(m.user_id)}
                        className="ml-0.5 rounded-full hover:opacity-80 transition-opacity"
                        style={{ color: 'var(--danger)' }}
                        title={t('team.removeMember')}
                      >
                        <UserMinus className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>

            {/* QR Code */}
            {showQR && (
              <div className="mt-3 flex flex-col items-center gap-2">
                <div className="rounded-lg p-3" style={{ background: '#ffffff' }}>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(`${window.location.origin}${window.location.pathname}?join=${team.invite_code}`)}`}
                    alt="Team QR Code"
                    width={180}
                    height={180}
                    style={{ display: 'block' }}
                  />
                </div>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('team.scanToJoin')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Period Selector */}
      <div className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(['day', 'week', 'month', 'year', 'all'] as PeriodType[]).map((p) => (
            <button
              key={p}
              onClick={() => { setTeamPeriod(p); setTeamOffset(0); }}
              className="px-4 py-2 rounded-lg font-medium transition-all"
              style={period === p
                ? { background: 'rgba(201,169,98,0.12)', border: '1px solid rgba(201,169,98,0.25)', color: 'var(--neon-cyan)' }
                : { background: 'var(--surface-solid)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
              }
            >
              {t(`team.${p}`)}
            </button>
          ))}
        </div>

        {/* Date Navigation */}
        {period !== 'all' && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setTeamOffset(o => o - 1)}
              className="btn-icon"
              aria-label={t('dash.prev')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span
              className="text-sm font-medium min-w-[180px] text-center"
              style={{ color: 'var(--text-secondary)' }}
            >
              {teamPeriodLabel}
            </span>

            <button
              onClick={() => setTeamOffset(o => Math.min(o + 1, 0))}
              className="btn-icon"
              disabled={teamOffset >= 0}
              style={{ opacity: teamOffset >= 0 ? 0.3 : 1 }}
              aria-label={t('dash.next')}
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            {teamOffset !== 0 && (
              <button
                onClick={() => setTeamOffset(0)}
                className="btn btn-sm btn-secondary rounded-lg flex items-center gap-1"
                style={{ background: 'var(--surface-solid)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              >
                <RotateCcw className="w-3 h-3" />
                {t('dash.today')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('team.total')}</div>
          <div className="text-2xl font-bold" style={{ color: 'var(--neon-cyan)' }}>{totalHours.toFixed(1)}h</div>
        </div>
        <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('team.persons')}</div>
          <div className="text-2xl font-bold" style={{ color: 'var(--neon-cyan)' }}>{personCount}</div>
        </div>
        <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('kpi.entries')}</div>
          <div className="text-2xl font-bold" style={{ color: 'var(--neon-violet, #9B8EC4)' }}>{entryCount}</div>
        </div>
        <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('team.perPerson')}</div>
          <div className="text-2xl font-bold" style={{ color: 'var(--success)' }}>{avgPerPerson.toFixed(1)}h</div>
        </div>
        <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('team.perDay')}</div>
          <div className="text-2xl font-bold" style={{ color: 'var(--warning)' }}>{avgPerDay.toFixed(1)}h</div>
        </div>
      </div>

      {allTeamEntries.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>{t('team.nodata')}</div>
      ) : (
        <>
          <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text)' }}>{t('team.attendance')}</h3>
            <TeamDaily memberEntries={filteredMemberEntries} entries={filterByPeriod(entries)} />
          </div>

          <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text)' }}>{t('team.shxperson')}</h3>
            <TeamMatrix dimension="stakeholder" entries={allTeamEntries} members={members} />
          </div>

          <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text)' }}>{t('team.prxperson')}</h3>
            <TeamMatrix dimension="project" entries={allTeamEntries} members={members} />
          </div>

          <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text)' }}>{t('team.workload')}</h3>
            <TeamWorkload memberEntries={filteredMemberEntries} entries={allTeamEntries} />
          </div>

          <div className="rounded-lg p-4 backdrop-blur-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text)' }}>{t('team.timeline')}</h3>
            <TeamTimeline memberEntries={filteredMemberEntries} members={members} />
          </div>
        </>
      )}

      {/* Remove Member Confirmation */}
      <ConfirmDialog
        isOpen={!!removingMember}
        onClose={() => setRemovingMember(null)}
        title={`${members.find(m => m.user_id === removingMember)?.display_name || removingMember} ${t('team.removeMember').toLowerCase()}`}
        message={t('team.removeMemberConfirm')}
        confirmText={t('team.removeMember')}
        cancelText={t('btn.cancel')}
        onConfirm={() => removingMember && handleRemoveMember(removingMember)}
        isDanger
      />

      {/* Disconnect Confirmation */}
      <ConfirmDialog
        isOpen={showDisconnectConfirm}
        onClose={() => setShowDisconnectConfirm(false)}
        title={t('confirm.disconnect')}
        message={t('confirm.disconnect')}
        confirmText={t('team.disconnect')}
        cancelText={t('btn.cancel')}
        onConfirm={handleLeaveTeam}
        isDanger
      />
    </div>
  );
}
