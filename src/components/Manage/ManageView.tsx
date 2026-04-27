import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useMasterStore, syncAllMasterData, cleanupOwnNamespaceDuplicates } from '../../stores/masterStore';
import { useEntriesStore } from '../../stores/entriesStore';
import { useUiStore } from '../../stores/uiStore';
import { exportBackup, importBackup, exportCSV, importCSV } from '../../lib/backup';
import { clearAllUserData } from '../../lib/userStorage';
import { useIsAdmin, useIsMitarbeiter } from '../../hooks/useRole';
import ConfirmDialog from '../UI/ConfirmDialog';
import DuplicateReview from './DuplicateReview';
import BatchEditPanel from './BatchEditPanel';
import { Pencil, Trash2, Search, Lock, Database } from 'lucide-react';

export default function ManageView() {
  const { t, tArray } = useI18n();
  const { stakeholders, projects, activities, formats, removeStakeholder, removeProject, removeActivity, removeFormat } = useMasterStore();
  const entries = useEntriesStore((state) => state.entries);
  const showToast = useUiStore((state) => state.showToast);
  // Role-based permissions:
  // - Admin / solo: full access (edit any category, backup, restore, delete-all).
  // - Mitarbeiter: may only add Stakeholder + Projekt; Format & Tätigkeit are read-only.
  const isAdmin = useIsAdmin();
  const isMitarbeiter = useIsMitarbeiter();
  const isReadOnlyType = (type: 'stakeholder' | 'project' | 'activity' | 'format') =>
    isMitarbeiter && (type === 'activity' || type === 'format');

  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [editingType, setEditingType] = useState<'stakeholder' | 'project' | 'activity' | 'format' | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState('');
  const [editingName, setEditingName] = useState('');
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deleteItemPending, setDeleteItemPending] = useState<{ type: 'stakeholder' | 'project' | 'activity' | 'format'; name: string } | null>(null);
  const [pendingBackup, setPendingBackup] = useState<any>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [dupGroups, setDupGroups] = useState<{ fingerprint: string; entries: any[] }[] | null>(null);

  const handleAddItem = async (type: 'stakeholder' | 'project' | 'activity' | 'format', name: string) => {
    if (!name.trim()) return;

    try {
      if (type === 'stakeholder') {
        await useMasterStore.getState().addStakeholder(name);
      } else if (type === 'project') {
        await useMasterStore.getState().addProject(name);
      } else if (type === 'activity') {
        await useMasterStore.getState().addActivity(name);
      } else if (type === 'format') {
        await useMasterStore.getState().addFormat(name);
      }
      showToast(`${name} ${t('toast.added')}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleRenameItem = async (type: 'stakeholder' | 'project' | 'activity' | 'format', oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) return;

    try {
      if (type === 'stakeholder') {
        await useMasterStore.getState().renameStakeholder(oldName, newName);
      } else if (type === 'project') {
        await useMasterStore.getState().renameProject(oldName, newName);
      } else if (type === 'activity') {
        await useMasterStore.getState().renameActivity(oldName, newName);
      } else if (type === 'format') {
        await useMasterStore.getState().renameFormat(oldName, newName);
      }
      showToast(`${t('toast.renamed')} ${newName}`, 'success');
      setEditingType(null);
      setEditingOriginalName('');
      setEditingName('');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleDeleteItem = async (type: 'stakeholder' | 'project' | 'activity' | 'format', name: string) => {
    try {
      if (type === 'stakeholder') {
        await removeStakeholder(name);
      } else if (type === 'project') {
        await removeProject(name);
      } else if (type === 'activity') {
        await removeActivity(name);
      } else if (type === 'format') {
        await removeFormat(name);
      }
      showToast(`${name} ${t('toast.deleted')}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleDeleteAllData = async () => {
    const state = useMasterStore.getState();
    const entriesState = useEntriesStore.getState();

    try {
      // Delete all master data from Supabase
      for (const sh of state.stakeholders) {
        await removeStakeholder(sh);
      }
      for (const pr of state.projects) {
        await removeProject(pr);
      }
      for (const act of state.activities) {
        await removeActivity(act);
      }
      for (const fm of state.formats) {
        await removeFormat(fm);
      }

      // Delete all entries from Supabase
      for (const entry of entries) {
        await entriesState.delete(entry.id);
      }

      // Clear localStorage for this user (the important part!)
      clearAllUserData();

      showToast(t('toast.allDeleted'), 'success');
      setShowDeleteAll(false);

      // Reload to get a clean state
      window.location.reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleBackupExport = async () => {
    try {
      const backup = exportBackup(
        {
          stakeholders,
          projects,
          activities,
          formats,
        },
        entries
      );
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zeiterfassung-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('toast.backupOk'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleBackupImport = async (file: File) => {
    try {
      const backup = await importBackup(file);
      if (backup) {
        setPendingBackup(backup);
        setShowRestoreConfirm(true);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleRestoreConfirm = async () => {
    if (!pendingBackup) return;
    try {
      const backup = pendingBackup;
      // Clear existing data
      const masterState = useMasterStore.getState();
      const entriesState = useEntriesStore.getState();

      for (const sh of masterState.stakeholders) {
        await removeStakeholder(sh);
      }
      for (const pr of masterState.projects) {
        await removeProject(pr);
      }
      for (const act of masterState.activities) {
        await removeActivity(act);
      }
      for (const fmt of masterState.formats) {
        await removeFormat(fmt);
      }
      for (const entry of entries) {
        await entriesState.delete(entry.id);
      }

      // Import new data
      for (const sh of backup.masterData.stakeholders) {
        await useMasterStore.getState().addStakeholder(sh);
      }
      for (const pr of backup.masterData.projects) {
        await useMasterStore.getState().addProject(pr);
      }
      for (const act of backup.masterData.activities) {
        await useMasterStore.getState().addActivity(act);
      }
      for (const fmt of (backup.masterData.formats || [])) {
        await useMasterStore.getState().addFormat(fmt);
      }
      for (const entry of backup.entries) {
        await entriesState.add(entry);
      }

      // Final sync: write complete master data with current encryption key
      syncAllMasterData().catch(() => { /* silent */ });

      showToast(t('toast.restoreOk'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    } finally {
      setPendingBackup(null);
    }
  };

  const handleCSVExport = async () => {
    try {
      const csvHeaders = [
        t('csv.datum'), t('csv.stakeholder'), t('csv.projekt'), t('csv.format'), t('csv.taetigkeit'),
        t('csv.von'), t('csv.bis'), t('csv.dauer'), t('csv.notiz'), t('csv.wochentag'),
      ];
      const weekdayNames = tArray('wd.long');
      const csv = exportCSV(entries, csvHeaders, weekdayNames);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zeiterfassung-export-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('toast.csvExported'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const handleCSVImport = async (file: File) => {
    try {
      const newEntries = await importCSV(file);
      if (newEntries.length === 0) {
        showToast(t('toast.error'), 'error');
        return;
      }
      await useEntriesStore.getState().bulkAdd(newEntries);

      // Extract unique dimension values from imported entries
      const importedStakeholders = new Set<string>();
      const importedProjects = new Set(newEntries.map((e) => e.projekt).filter(Boolean));
      const importedActivities = new Set(newEntries.map((e) => e.taetigkeit).filter(Boolean));
      const importedFormats = new Set(newEntries.map((e) => e.format).filter((f): f is string => !!f));

      // Handle stakeholder as string or array
      newEntries.forEach((e) => {
        const shArray = Array.isArray(e.stakeholder) ? e.stakeholder : [e.stakeholder];
        shArray.forEach((sh) => {
          if (sh) importedStakeholders.add(sh);
        });
      });

      // Add all missing dimension values to masterStore.
      // Each addXxx() silently skips duplicates and uses get() for fresh state,
      // so no stale-reference issues. Individual failures don't abort the loop.
      for (const sh of importedStakeholders) {
        try { await useMasterStore.getState().addStakeholder(sh); } catch { /* skip */ }
      }
      for (const pr of importedProjects) {
        try { await useMasterStore.getState().addProject(pr); } catch { /* skip */ }
      }
      for (const act of importedActivities) {
        try { await useMasterStore.getState().addActivity(act); } catch { /* skip */ }
      }
      for (const fmt of importedFormats) {
        try { await useMasterStore.getState().addFormat(fmt); } catch { /* skip */ }
      }

      // Final sync: write the complete master data state to Supabase
      // with the current encryption key (replaces any stale/partial data)
      syncAllMasterData().catch(() => { /* silent — will retry on next sync cycle */ });

      showToast(`${t('toast.importOk')} (${newEntries.length})`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
    }
  };

  const MasterDataColumn = ({
    title,
    items,
    type,
    onAdd,
  }: {
    title: string;
    items: string[];
    type: 'stakeholder' | 'project' | 'activity' | 'format';
    onAdd: (name: string) => void;
  }) => {
    const [newValue, setNewValue] = useState('');
    const readOnly = isReadOnlyType(type);

    return (
      <div className="flex-1 card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">{title}</h3>
          {readOnly && (
            <span
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded"
              style={{ background: 'rgba(155,142,196,0.1)', color: 'var(--neon-violet, #9B8EC4)' }}
              title={t('manage.readonlyHint')}
            >
              <Lock className="w-3 h-3" />
              {t('team.roleEmployee')}
            </span>
          )}
        </div>

        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item}
              style={{ background: 'rgba(201, 169, 98, 0.03)', borderColor: 'var(--border)' }}
              className="flex items-center justify-between p-2 rounded border transition-colors hover:opacity-80"
            >
              {!readOnly && editingType === type && editingOriginalName === item ? (
                <input
                  id="manage-edit-name"
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  className="input flex-1 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleRenameItem(type, editingOriginalName, editingName);
                    } else if (e.key === 'Escape') {
                      setEditingType(null);
                      setEditingOriginalName('');
                      setEditingName('');
                    }
                  }}
                  autoFocus
                  aria-label="Edit name"
                />
              ) : (
                <span style={{ color: 'var(--text-secondary)' }} className="flex-1">{item}</span>
              )}
              {!readOnly && (
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      setEditingType(type);
                      setEditingOriginalName(item);
                      setEditingName(item);
                    }}
                    style={{ color: 'var(--text-secondary)' }}
                    className="px-2 py-1 hover:opacity-60 transition-colors text-sm"
                    title={t('title.rename')}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeleteItemPending({ type, name: item })}
                    style={{ color: 'var(--text-secondary)' }}
                    className="px-2 py-1 hover:opacity-60 transition-colors text-sm"
                    title={t('title.delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {!readOnly ? (
          <div className="flex gap-2">
            <input
              id="manage-add-new"
              type="text"
              placeholder={t('manage.addNew')}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onAdd(newValue);
                  setNewValue('');
                }
              }}
              className="input flex-1 text-sm"
              aria-label={t('manage.addNew')}
            />
            <button
              onClick={() => {
                onAdd(newValue);
                setNewValue('');
              }}
              style={{ background: 'var(--primary)', color: 'var(--bg)' }}
              className="px-3 py-2 rounded font-medium transition-opacity hover:opacity-90 text-sm"
            >
              +
            </button>
          </div>
        ) : (
          <p style={{ color: 'var(--text-muted)' }} className="text-xs italic">
            {t('manage.readonlyHint')}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="w-full max-w-7xl mx-auto p-4 space-y-6">
      {/* Master Data Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MasterDataColumn
          title={t('manage.stakeholder')}
          items={stakeholders}
          type="stakeholder"
          onAdd={(name) => handleAddItem('stakeholder', name)}
        />
        <MasterDataColumn
          title={t('manage.projekte')}
          items={projects}
          type="project"
          onAdd={(name) => handleAddItem('project', name)}
        />
        <MasterDataColumn
          title={t('manage.formate')}
          items={formats}
          type="format"
          onAdd={(name) => handleAddItem('format', name)}
        />
        <MasterDataColumn
          title={t('manage.taetigkeiten')}
          items={activities}
          type="activity"
          onAdd={(name) => handleAddItem('activity', name)}
        />
      </div>

      {/* Batch-Edit Panel — admin only */}
      {isAdmin && <BatchEditPanel />}

      {/* Backup & Restore Section */}
      <div className="card p-4 space-y-3">
        <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">{t('manage.backup')}</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            onClick={handleBackupExport}
            className="btn btn-primary"
          >
            {t('btn.backup')}
          </button>
          {/* Restore & Import would let a Mitarbeiter overwrite Format/Tätigkeit master data,
              which would defeat the read-only restriction → admin only. */}
          {isAdmin && (
            <label className="btn btn-primary cursor-pointer text-center">
              {t('btn.restore')}
              <input
                id="manage-restore-file"
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleBackupImport(file);
                }}
                className="hidden"
                aria-label={t('btn.restore')}
              />
            </label>
          )}
          <button
            onClick={handleCSVExport}
            className="btn btn-success"
            disabled={entries.length === 0}
          >
            {t('btn.csvExport')}
          </button>
          {isAdmin && (
            <label className="btn btn-success cursor-pointer text-center disabled:opacity-50">
              {t('btn.csvImport')}
              <input
                id="manage-csv-import"
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCSVImport(file);
                }}
                className="hidden"
                aria-label={t('btn.csvImport')}
              />
            </label>
          )}
        </div>

        <p style={{ color: 'var(--text-muted)' }} className="text-xs italic">{t('manage.backupHint')}</p>

        {/* Deduplicate */}
        <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => {
              const dupes = useEntriesStore.getState().findDuplicates();
              if (dupes.size === 0) {
                showToast(t('manage.noDuplicates'), 'success');
                return;
              }
              // Convert Map to array for the review component
              const groups = Array.from(dupes.entries()).map(([fp, entries]) => ({
                fingerprint: fp,
                entries,
              }));
              setDupGroups(groups);
            }}
            className="btn btn-secondary flex items-center gap-2"
            disabled={entries.length === 0}
          >
            <Search className="w-4 h-4" />
            {t('manage.removeDuplicates')}
          </button>
        </div>
      </div>

      {/* Datenbank bereinigen — admin only.
          Räumt historische Master-Data-Duplikate auf, die durch das alte
          DELETE+INSERT-merged-list Sync-Verhalten entstanden sind. Wirkt
          rein auf den eigenen Namespace (RLS gates teammate rows). */}
      {isAdmin && (
        <div
          className="card p-4 space-y-3"
          style={{ borderColor: 'rgba(155,142,196,0.3)' }}
        >
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4" style={{ color: 'var(--neon-violet, #9B8EC4)' }} />
            <h3 style={{ color: 'var(--text)' }} className="text-lg font-semibold">{t('manage.dbCleanup')}</h3>
          </div>
          <p style={{ color: 'var(--text-muted)' }} className="text-xs">
            {t('manage.dbCleanupHint')}
          </p>
          <button
            onClick={async () => {
              setCleanupRunning(true);
              try {
                const r = await cleanupOwnNamespaceDuplicates();
                const total = r.stakeholders.removed + r.projects.removed + r.activities.removed + r.formats.removed;
                if (total === 0) {
                  showToast(t('manage.dbCleanupNothing'), 'success');
                } else {
                  showToast(`${total} ${t('manage.dbCleanupRemoved')}`, 'success');
                  // Trigger a master-data refresh so the UI reflects the cleaned state
                  await useMasterStore.getState().fetch();
                }
              } catch (e) {
                showToast(e instanceof Error ? e.message : t('toast.error'), 'error');
              } finally {
                setCleanupRunning(false);
              }
            }}
            disabled={cleanupRunning}
            className="btn btn-secondary flex items-center gap-2"
            style={{ opacity: cleanupRunning ? 0.5 : 1 }}
          >
            <Database className="w-4 h-4" />
            {cleanupRunning ? t('ui.loading') : t('manage.dbCleanupBtn')}
          </button>
        </div>
      )}

      {/* Delete All Data — admin only (would wipe Format/Tätigkeit master data otherwise) */}
      {isAdmin && (
      <div className="card p-4 space-y-3" style={{ borderColor: 'rgba(212, 112, 110, 0.3)' }}>
        <h3 style={{ color: 'var(--danger)' }} className="text-lg font-semibold">{t('manage.warning')}</h3>

        {!showDeleteAll ? (
          <button
            onClick={() => setShowDeleteAll(true)}
            className="btn btn-danger"
          >
            {t('btn.deleteAll')}
          </button>
        ) : (
          <div className="space-y-3">
            <p style={{ color: 'var(--warning)' }}>{t('confirm.deleteAll')}</p>
            <div className="flex gap-2">
              <button
                onClick={handleDeleteAllData}
                className="btn btn-danger flex-1"
              >
                {t('manage.confirmDeleteAll')}
              </button>
              <button
                onClick={() => setShowDeleteAll(false)}
                className="btn btn-secondary"
              >
                {t('btn.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Delete Item Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteItemPending}
        onClose={() => setDeleteItemPending(null)}
        title={t('confirm.deleteItem')}
        message={deleteItemPending ? `${deleteItemPending.name} ${t('confirm.deleteItem')}` : ''}
        confirmText={t('title.delete')}
        cancelText={t('btn.cancel')}
        onConfirm={() => {
          if (deleteItemPending) {
            handleDeleteItem(deleteItemPending.type, deleteItemPending.name);
            setDeleteItemPending(null);
          }
        }}
        isDanger
      />

      {/* Backup Restore Confirmation */}
      <ConfirmDialog
        isOpen={showRestoreConfirm}
        onClose={() => {
          setShowRestoreConfirm(false);
          setPendingBackup(null);
        }}
        title={t('dsb.confirmRestore')}
        message={t('confirm.deleteAll')}
        confirmText={t('btn.restore')}
        cancelText={t('btn.cancel')}
        onConfirm={() => {
          setShowRestoreConfirm(false);
          handleRestoreConfirm();
        }}
        isDanger
      />

      {/* Duplicate Review Modal */}
      {dupGroups && (
        <DuplicateReview
          groups={dupGroups}
          onRemove={async (ids) => {
            try {
              const count = await useEntriesStore.getState().removeByIds(ids);
              showToast(`${count} ${t('manage.duplicatesRemoved')}`, 'success');
              setDupGroups(null);
            } catch (error) {
              showToast(error instanceof Error ? error.message : t('toast.error'), 'error');
            }
          }}
          onClose={() => setDupGroups(null)}
        />
      )}
    </div>
  );
}
