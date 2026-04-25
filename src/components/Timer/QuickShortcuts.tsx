import { useState, useMemo, useEffect, useRef } from 'react';
import { useTimerStore } from '../../stores/timerStore';
import { useEntriesStore } from '../../stores/entriesStore';
import { useAuthStore } from '../../stores/authStore';
import { useI18n } from '../../i18n';
import { Pin, X } from 'lucide-react';
import { getUserData, setUserData } from '@/lib/userStorage';
import { supabaseClient, isSupabaseAvailable } from '@/lib/supabase';
import { encryptField, decryptField } from '@/lib/crypto';

interface ShortcutItem {
  stakeholder: string;
  projekt: string;
  taetigkeit?: string;
  frequency?: number;
  isPinned?: boolean;
}

// ── Supabase sync helpers ──────────────────────────────────────────────

async function pushPrefsToSupabase(pinned: ShortcutItem[], hidden: string[]) {
  if (!isSupabaseAvailable() || !supabaseClient) return;
  const userId = useAuthStore.getState().profile?.id;
  if (!userId) return;

  const encPinned = await encryptField(JSON.stringify(pinned));
  const encHidden = await encryptField(JSON.stringify(hidden));

  supabaseClient
    .from('user_preferences')
    .upsert(
      {
        user_id: userId,
        pinned_shortcuts: encPinned,
        hidden_shortcuts: encHidden,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .then(({ error }) => {
      if (error) console.warn('Prefs sync failed:', error.message);
    });
}

async function pullPrefsFromSupabase(): Promise<{
  pinned: ShortcutItem[] | null;
  hidden: string[] | null;
}> {
  if (!isSupabaseAvailable() || !supabaseClient) return { pinned: null, hidden: null };
  const userId = useAuthStore.getState().profile?.id;
  if (!userId) return { pinned: null, hidden: null };

  const { data } = await supabaseClient
    .from('user_preferences')
    .select('pinned_shortcuts, hidden_shortcuts')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return { pinned: null, hidden: null };

  let pinned: ShortcutItem[] | null = null;
  let hidden: string[] | null = null;

  if (data.pinned_shortcuts) {
    try {
      const dec = await decryptField(data.pinned_shortcuts);
      pinned = JSON.parse(dec);
    } catch { /* ignore */ }
  }

  if (data.hidden_shortcuts) {
    try {
      const dec = await decryptField(data.hidden_shortcuts);
      hidden = JSON.parse(dec);
    } catch { /* ignore */ }
  }

  return { pinned, hidden };
}

// ── Component ──────────────────────────────────────────────────────────

const QuickShortcuts: React.FC = () => {
  const { t } = useI18n();
  const { addSlot } = useTimerStore();
  const { entries } = useEntriesStore();
  const [pinnedShortcuts, setPinnedShortcuts] = useState<ShortcutItem[]>(() => {
    return getUserData<ShortcutItem[]>('pinnedShortcuts', []);
  });
  const [hiddenShortcuts, setHiddenShortcuts] = useState<string[]>(() => {
    return getUserData<string[]>('hiddenShortcuts', []);
  });
  const hasFetchedRef = useRef(false);

  // On mount: pull from Supabase and merge
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    pullPrefsFromSupabase().then(({ pinned, hidden }) => {
      if (pinned && pinned.length > 0) {
        // Merge: Supabase is source of truth, but keep any local-only items
        const merged = [...pinned];
        const localOnly = getUserData<ShortcutItem[]>('pinnedShortcuts', []).filter(
          (local) => !pinned.some((p) => p.stakeholder === local.stakeholder && p.projekt === local.projekt)
        );
        merged.push(...localOnly);
        setPinnedShortcuts(merged);
        setUserData('pinnedShortcuts', merged);
      }

      if (hidden && hidden.length > 0) {
        const localHidden = getUserData<string[]>('hiddenShortcuts', []);
        const mergedHidden = [...new Set([...hidden, ...localHidden])];
        setHiddenShortcuts(mergedHidden);
        setUserData('hiddenShortcuts', mergedHidden);
      }
    });
  }, []);

  // Calculate frequency of stakeholder+project combinations from actual entries
  const autoShortcuts = useMemo(() => {
    const freq: Record<string, number> = {};

    entries.forEach((entry) => {
      if (entry.stakeholder && entry.projekt) {
        const key = `${entry.stakeholder}|${entry.projekt}`;
        freq[key] = (freq[key] || 0) + 1;
      }
    });

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, frequency]) => {
        const [stakeholder, projekt] = key.split('|');
        return { stakeholder, projekt, frequency };
      });
  }, [entries]);

  // Deduplicate: filter out auto shortcuts that are already pinned or hidden
  const dedupedAutoShortcuts = autoShortcuts.filter(
    (auto) =>
      !pinnedShortcuts.some((p) => p.stakeholder === auto.stakeholder && p.projekt === auto.projekt) &&
      !hiddenShortcuts.includes(`${auto.stakeholder}|${auto.projekt}`)
  );

  // Handle shortcut click — defaults Tätigkeit to Produktiv when the
  // shortcut doesn't pin a specific activity.
  const handleShortcutClick = (shortcut: ShortcutItem) => {
    addSlot({
      stakeholder: [shortcut.stakeholder],
      projekt: shortcut.projekt,
      taetigkeit: shortcut.taetigkeit || 'Produktiv',
      format: 'Einzelarbeit',
      notiz: '',
    });
  };

  // Delete a shortcut (remove from pinned, hide auto-generated ones)
  const handleDelete = (shortcut: ShortcutItem) => {
    let updatedPinned = pinnedShortcuts;
    const wasPinned = pinnedShortcuts.some(
      (p) => p.stakeholder === shortcut.stakeholder && p.projekt === shortcut.projekt
    );
    if (wasPinned) {
      updatedPinned = pinnedShortcuts.filter(
        (p) => !(p.stakeholder === shortcut.stakeholder && p.projekt === shortcut.projekt)
      );
      setPinnedShortcuts(updatedPinned);
      setUserData('pinnedShortcuts', updatedPinned);
    }

    // Always add to hidden list so auto-generated shortcuts stay hidden
    const key = `${shortcut.stakeholder}|${shortcut.projekt}`;
    let updatedHidden = hiddenShortcuts;
    if (!hiddenShortcuts.includes(key)) {
      updatedHidden = [...hiddenShortcuts, key];
      setHiddenShortcuts(updatedHidden);
      setUserData('hiddenShortcuts', updatedHidden);
    }

    // Push to Supabase
    pushPrefsToSupabase(wasPinned ? updatedPinned : pinnedShortcuts, updatedHidden);
  };

  const allShortcuts = [...pinnedShortcuts, ...dedupedAutoShortcuts];

  if (allShortcuts.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: '11px', textAlign: 'center', padding: '4px 0' }}>
        {t('sc.needData')}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {allShortcuts.map((shortcut, idx) => {
        const isPinned = pinnedShortcuts.some(
          (p) => p.stakeholder === shortcut.stakeholder && p.projekt === shortcut.projekt
        );

        return (
          <div
            key={`${shortcut.stakeholder}-${shortcut.projekt}-${idx}`}
            className="group"
            style={{ position: 'relative', display: 'inline-flex' }}
          >
            {/* V5.15 quick-chip style */}
            <button
              onClick={() => handleShortcutClick(shortcut)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                paddingRight: '28px',
                borderRadius: '16px',
                fontSize: '11px',
                fontWeight: 600,
                border: `1px solid ${isPinned ? 'rgba(229,168,75,0.25)' : 'var(--border)'}`,
                background: isPinned ? 'rgba(229,168,75,0.06)' : 'var(--surface)',
                color: isPinned ? 'var(--warning)' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-hover)';
                e.currentTarget.style.color = 'var(--text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = isPinned ? 'rgba(229,168,75,0.25)' : 'var(--border)';
                e.currentTarget.style.color = isPinned ? 'var(--warning)' : 'var(--text-secondary)';
              }}
            >
              {isPinned && <Pin className="w-3 h-3" />}
              {shortcut.stakeholder}/{shortcut.projekt}
            </button>

            {/* Delete button (always visible on hover) */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(shortcut);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                position: 'absolute',
                right: '2px',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                border: 'none',
                background: 'rgba(212, 112, 110, 0.15)',
                color: 'var(--danger)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
              title={t('timer.removeTask')}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default QuickShortcuts;
