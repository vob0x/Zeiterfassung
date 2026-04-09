import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useUiStore } from '../../stores/uiStore';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import ConfirmDialog from '../UI/ConfirmDialog';
import { ClipboardCopy, Sun, Moon } from 'lucide-react';

export function SettingsView() {
  const { t, language, setLanguage } = useI18n();
  const { theme, toggleTheme, showToast } = useUiStore();
  const { team, members } = useTeamStore();
  const { signOut, profile } = useAuthStore();
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    window.location.reload();
  };

  return (
    <div className="w-full max-w-2xl mx-auto p-4 space-y-6">
      {/* Theme Section */}
      <div className="rounded-lg p-4 backdrop-blur-sm space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('settings.design')}</h3>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label style={{ color: 'var(--text-secondary)' }}>{t('settings.design')}</label>
            <button
              onClick={toggleTheme}
              className="px-4 py-2 rounded-lg font-medium transition-all flex items-center gap-2"
              style={{ background: 'var(--surface-solid)', color: 'var(--text)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface-solid)')}
              aria-label={t('title.themeToggle')}
            >
              {theme === 'cyber' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              {theme === 'cyber' ? 'Light' : 'Dark'}
            </button>
          </div>

          {/* Theme Preview */}
          <div className="mt-4 p-4 rounded-lg border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--border)' }}>
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>{t('settings.preview')}</div>
            <div className="grid grid-cols-3 gap-2 p-3 rounded" style={{ background: 'var(--surface-hover)' }}>
              <div className="w-8 h-8 rounded" style={{ background: 'var(--neon-cyan)' }} />
              <div className="w-8 h-8 rounded" style={{ background: 'var(--neon-violet)' }} />
              <div className="w-8 h-8 rounded" style={{ background: 'var(--neon-magenta)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Language Section */}
      <div className="rounded-lg p-4 backdrop-blur-sm space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('settings.language')}</h3>

        <div className="flex gap-2">
          {['de', 'fr'].map((lang) => (
            <button
              key={lang}
              onClick={() => setLanguage(lang as 'de' | 'fr')}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${language === lang ? 'shadow-lg' : ''}`}
              style={language === lang
                ? { background: 'var(--neon-cyan)', color: 'var(--surface)' }
                : { background: 'var(--surface-solid)', color: 'var(--text-secondary)' }
              }
              onMouseEnter={(e) => language !== lang && (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(e) => language !== lang && (e.currentTarget.style.background = 'var(--surface-solid)')}
            >
              {lang.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* User Profile Section */}
      <div className="rounded-lg p-4 backdrop-blur-sm space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('settings.profile')}</h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('auth.codename')}</label>
            <div className="mt-1 px-3 py-2 rounded border" style={{ background: 'var(--surface-solid)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>
              {profile?.codename || t('settings.notSet')}
            </div>
          </div>

          <button
            onClick={() => setShowSignOutConfirm(true)}
            className="w-full px-4 py-2 rounded-lg font-medium transition-colors"
            style={{ background: 'var(--danger)', color: '#fff' }}
          >
            {t('auth.signOut')}
          </button>
        </div>
      </div>

      {/* Team Section */}
      {team && (
        <div className="rounded-lg p-4 backdrop-blur-sm space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('nav.team')}</h3>

          <div className="space-y-3">
            <div>
              <label className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.teamName')}</label>
              <div className="mt-1 px-3 py-2 rounded border" style={{ background: 'var(--surface-solid)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>
                {team.name}
              </div>
            </div>

            <div>
              <label className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.members')}</label>
              <div className="mt-1 px-3 py-2 rounded border" style={{ background: 'var(--surface-solid)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>
                {members.length}
              </div>
            </div>

            {team.creator_id === profile?.id && (
              <div>
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.inviteCode')}</label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    value={team.invite_code}
                    readOnly
                    className="flex-1 px-3 py-2 rounded border font-mono"
                    style={{ background: 'var(--surface-solid)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }}
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(team.invite_code);
                      showToast(t('settings.copied'), 'success');
                    }}
                    className="px-3 py-2 rounded"
                    style={{ background: 'var(--surface-solid)', color: 'var(--text)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface-solid)')}
                    aria-label={t('settings.copied')}
                  >
                    <ClipboardCopy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* About Section */}
      <div className="rounded-lg p-4 backdrop-blur-sm space-y-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('settings.info')}</h3>

        <div className="space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          <p>
            <strong>{t('app.title')}</strong> V1.0
          </p>
          <p>{t('settings.appDesc')}</p>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>© 2024. {t('settings.copyright')}</p>
        </div>
      </div>

      {/* Data Sync Status */}
      <div className="rounded-lg p-4 backdrop-blur-sm space-y-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('settings.dataSync')}</h3>

        <div className="flex items-center gap-2 px-3 py-2 rounded border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--success)' }}>
          <div className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
          <span className="text-sm" style={{ color: 'var(--success)' }}>{t('settings.synced')}</span>
        </div>
      </div>

      {/* Sign Out Confirmation */}
      <ConfirmDialog
        isOpen={showSignOutConfirm}
        onClose={() => setShowSignOutConfirm(false)}
        title={t('auth.signOut')}
        message={t('settings.confirmSignOut')}
        confirmText={t('auth.signOut')}
        cancelText={t('btn.cancel')}
        onConfirm={handleSignOut}
        isDanger
      />
    </div>
  );
}
