import React, { useState } from 'react';
import { useEntriesStore } from '../../stores/entriesStore';
import { useMasterStore } from '../../stores/masterStore';
import { useUiStore } from '../../stores/uiStore';
import { useI18n } from '../../i18n';
import { formatDateISO } from '../../lib/utils';
import { getTodayISO } from '../../lib/utils';
import NoteInput, { saveNoteToHistory } from '../UI/NoteInput';

interface ManualEntryProps {
  embedded?: boolean;
}

const ManualEntry: React.FC<ManualEntryProps> = ({ embedded = false }) => {
  const { t } = useI18n();
  const { add: addEntry } = useEntriesStore();
  const { showToast } = useUiStore();
  const {
    stakeholders,
    projects,
    activities,
    formats,
    addStakeholder: addStakeholderToStore,
    addProject: addProjectToStore,
    addActivity: addActivityToStore,
    addFormat: addFormatToStore,
  } = useMasterStore();

  const [formData, setFormData] = useState({
    date: getTodayISO(),
    stakeholders: [] as string[], // NEW: array for multi-select
    projekt: '',
    taetigkeit: '',
    format: 'Einzelarbeit', // NEW: default format
    startTime: '',
    endTime: '',
    notiz: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAddStakeholder, setShowAddStakeholder] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showAddActivity, setShowAddActivity] = useState(false);
  const [showAddFormat, setShowAddFormat] = useState(false);
  const [newStakeholder, setNewStakeholder] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newActivity, setNewActivity] = useState('');
  const [newFormat, setNewFormat] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (formData.stakeholders.length === 0) newErrors.stakeholders = t('toast.selectShPr'); // NEW: check array
    if (!formData.projekt) newErrors.projekt = t('toast.selectShPr');
    if (!formData.taetigkeit) newErrors.taetigkeit = t('validation.required');
    if (!formData.date) newErrors.date = t('toast.selectDate');
    if (!formData.startTime) newErrors.startTime = t('toast.selectTime');
    if (!formData.endTime) newErrors.endTime = t('toast.selectTime');
    // Allow overnight entries (e.g., 23:00 → 01:00) — only reject identical times
    if (formData.startTime && formData.endTime && formData.startTime === formData.endTime) {
      newErrors.endTime = t('toast.endAfterStart');
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setIsSaving(true);
    try {
      const entries = [];
      const [startH, startM] = formData.startTime.split(':').map(Number);
      const [endH, endM] = formData.endTime.split(':').map(Number);
      const startMins = startH * 60 + startM;
      const endMins = endH * 60 + endM;

      if (endMins < startMins) {
        const nextDate = new Date(formData.date);
        nextDate.setDate(nextDate.getDate() + 1);
        const nextDateISO = formatDateISO(nextDate);
        entries.push({
          date: formData.date,
          stakeholder: formData.stakeholders, // NEW: array
          projekt: formData.projekt,
          taetigkeit: formData.taetigkeit,
          format: formData.format, // NEW: include format
          start_time: formData.startTime,
          end_time: '23:59',
          notiz: formData.notiz,
        });
        entries.push({
          date: nextDateISO,
          stakeholder: formData.stakeholders, // NEW: array
          projekt: formData.projekt,
          taetigkeit: formData.taetigkeit,
          format: formData.format, // NEW: include format
          start_time: '00:00',
          end_time: formData.endTime,
          notiz: formData.notiz,
        });
      } else {
        entries.push({
          date: formData.date,
          stakeholder: formData.stakeholders, // NEW: array
          projekt: formData.projekt,
          taetigkeit: formData.taetigkeit,
          format: formData.format, // NEW: include format
          start_time: formData.startTime,
          end_time: formData.endTime,
          notiz: formData.notiz,
        });
      }

      for (const entry of entries) {
        await addEntry(entry);
      }

      // Save note to suggestion history
      if (formData.notiz) saveNoteToHistory(formData.notiz);

      setFormData({
        date: getTodayISO(),
        stakeholders: [], // NEW: reset to empty array
        projekt: '',
        taetigkeit: '',
        format: 'Einzelarbeit', // NEW: reset to default
        startTime: '',
        endTime: '',
        notiz: '',
      });
      setErrors({});
      showToast(entries.length === 2 ? t('toast.midnight') : t('toast.manualOk'), 'success');
    } catch (error) {
      console.error('Failed to save entry:', error);
      showToast(t('toast.error'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddStakeholder = async () => {
    if (newStakeholder.trim()) {
      try {
        await addStakeholderToStore(newStakeholder.trim());
        setFormData({ ...formData, stakeholders: [...formData.stakeholders, newStakeholder.trim()] }); // NEW: add to array
        setNewStakeholder('');
        setShowAddStakeholder(false);
      } catch (error) { console.error('Failed to add stakeholder:', error); }
    }
  };

  const handleAddFormat = async () => {
    if (newFormat.trim()) {
      try {
        await addFormatToStore(newFormat.trim());
        setFormData({ ...formData, format: newFormat.trim() });
        setNewFormat('');
        setShowAddFormat(false);
      } catch (error) { console.error('Failed to add format:', error); }
    }
  };

  const handleAddProject = async () => {
    if (newProject.trim()) {
      try {
        await addProjectToStore(newProject.trim());
        setFormData({ ...formData, projekt: newProject.trim() });
        setNewProject('');
        setShowAddProject(false);
      } catch (error) { console.error('Failed to add project:', error); }
    }
  };

  const handleAddActivity = async () => {
    if (newActivity.trim()) {
      try {
        await addActivityToStore(newActivity.trim());
        setFormData({ ...formData, taetigkeit: newActivity.trim() });
        setNewActivity('');
        setShowAddActivity(false);
      } catch (error) { console.error('Failed to add activity:', error); }
    }
  };

  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '5px 8px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--surface-solid)',
    color: 'var(--text)',
    fontFamily: 'var(--font)',
    fontSize: '12px',
    outline: 'none',
  };

  const inlineBtnStyle: React.CSSProperties = {
    width: '28px',
    minWidth: '28px',
    padding: 0,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    flexShrink: 0,
  };

  const Wrapper = embedded ? 'div' : ({ children, ...props }: any) => <div className="card p-6" {...props}>{children}</div>;

  return (
    <Wrapper>
      <div
        className="font-display text-xs font-semibold tracking-wide uppercase"
        style={{ color: 'var(--text-muted)', letterSpacing: '0.02em', marginBottom: '10px' }}
      >
        {t('manual.title')}
      </div>

      <form onSubmit={handleSubmit}>
        {/* V6.0: 4-column grid for dropdowns (Stakeholder multi-select, Project, Format, Activity) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          {/* Stakeholder multi-select with chips */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch', flexWrap: 'wrap' }}>
              {formData.stakeholders.map((sh) => (
                <div key={sh} style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(0,200,200,0.15)', fontSize: '10px', color: 'var(--neon-cyan)', whiteSpace: 'nowrap' }}>
                  {sh}
                  <button type="button" onClick={() => setFormData({ ...formData, stakeholders: formData.stakeholders.filter((s) => s !== sh) })} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0', fontSize: '12px', lineHeight: '1' }}>×</button>
                </div>
              ))}
              <select
                onChange={(e) => {
                  if (e.target.value && !formData.stakeholders.includes(e.target.value)) {
                    setFormData({ ...formData, stakeholders: [...formData.stakeholders, e.target.value] });
                  }
                  e.target.value = '';
                }}
                style={{ ...selectStyle, flex: formData.stakeholders.length === 0 ? 1 : 'initial', minWidth: '80px' }}
              >
                <option value="">{t('ph.stakeholder')}</option>
                {stakeholders.filter((s) => !formData.stakeholders.includes(s)).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button type="button" onClick={() => setShowAddStakeholder(!showAddStakeholder)} style={inlineBtnStyle}>+</button>
            </div>
          </div>

          {/* Project */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch' }}>
            <select
              value={formData.projekt}
              onChange={(e) => setFormData({ ...formData, projekt: e.target.value })}
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              <option value="">{t('ph.projekt')}</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <button type="button" onClick={() => setShowAddProject(!showAddProject)} style={inlineBtnStyle}>+</button>
          </div>

          {/* Format */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch' }}>
            <select
              value={formData.format}
              onChange={(e) => setFormData({ ...formData, format: e.target.value })}
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              {formats.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button type="button" onClick={() => setShowAddFormat(!showAddFormat)} style={inlineBtnStyle}>+</button>
          </div>

          {/* Activity */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch' }}>
            <select
              value={formData.taetigkeit}
              onChange={(e) => setFormData({ ...formData, taetigkeit: e.target.value })}
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              <option value="">{t('ph.taetigkeit')}</option>
              {activities.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <button type="button" onClick={() => setShowAddActivity(!showAddActivity)} style={inlineBtnStyle}>+</button>
          </div>
        </div>

        {/* Inline add rows */}
        {showAddStakeholder && (
          <div className="flex gap-1 mb-2">
            <input id="me-new-stakeholder" type="text" aria-label={t('ph.newStakeholder')} placeholder={t('ph.newStakeholder')} value={newStakeholder} onChange={(e) => setNewStakeholder(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddStakeholder())} style={{ ...selectStyle, flex: 1 }} />
            <button type="button" onClick={handleAddStakeholder} style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t('btn.save')}</button>
          </div>
        )}
        {showAddProject && (
          <div className="flex gap-1 mb-2">
            <input id="me-new-project" type="text" aria-label={t('ph.newProjekt')} placeholder={t('ph.newProjekt')} value={newProject} onChange={(e) => setNewProject(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddProject())} style={{ ...selectStyle, flex: 1 }} />
            <button type="button" onClick={handleAddProject} style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t('btn.save')}</button>
          </div>
        )}
        {showAddActivity && (
          <div className="flex gap-1 mb-2">
            <input id="me-new-activity" type="text" aria-label={t('ph.newTaetigkeit')} placeholder={t('ph.newTaetigkeit')} value={newActivity} onChange={(e) => setNewActivity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddActivity())} style={{ ...selectStyle, flex: 1 }} />
            <button type="button" onClick={handleAddActivity} style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t('btn.save')}</button>
          </div>
        )}
        {showAddFormat && (
          <div className="flex gap-1 mb-2">
            <input id="me-new-format" type="text" aria-label={t('ph.newFormat')} placeholder={t('ph.newFormat')} value={newFormat} onChange={(e) => setNewFormat(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddFormat())} style={{ ...selectStyle, flex: 1 }} />
            <button type="button" onClick={handleAddFormat} style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t('btn.save')}</button>
          </div>
        )}

        {/* Note input with suggestions */}
        <div style={{ marginBottom: '8px' }}>
          <NoteInput
            value={formData.notiz}
            onChange={(v) => setFormData({ ...formData, notiz: v })}
            placeholder={t('ph.notiz')}
            style={selectStyle}
          />
        </div>

        {/* Date, Time From, Time To, Save - V5.15 inline row */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'end', flexWrap: 'wrap' }}>
          <div>
            <label htmlFor="me-date" style={{ display: 'block', marginBottom: '4px', fontFamily: 'var(--font-display)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.02em', color: 'var(--text-muted)' }}>
              {t('label.datum')}
            </label>
            <input
              id="me-date"
              type="date"
              value={formData.date}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
              style={{ ...selectStyle, width: '130px' }}
            />
          </div>
          <div>
            <label htmlFor="me-start" style={{ display: 'block', marginBottom: '4px', fontFamily: 'var(--font-display)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.02em', color: 'var(--text-muted)' }}>
              {t('label.von')}
            </label>
            <input
              id="me-start"
              type="time"
              value={formData.startTime}
              onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
              style={{ ...selectStyle, width: '100px' }}
            />
          </div>
          <div>
            <label htmlFor="me-end" style={{ display: 'block', marginBottom: '4px', fontFamily: 'var(--font-display)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.02em', color: 'var(--text-muted)' }}>
              {t('label.bis')}
            </label>
            <input
              id="me-end"
              type="time"
              value={formData.endTime}
              onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
              style={{ ...selectStyle, width: '100px' }}
            />
          </div>
          <button
            type="submit"
            style={{
              padding: '6px 14px',
              background: 'rgba(201,169,98,0.07)',
              border: '1px solid rgba(201,169,98,0.18)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--neon-cyan)',
              fontFamily: 'var(--font-display)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.15s',
              marginBottom: 0,
            }}
            disabled={isSaving}
          >
            {isSaving ? t('ui.loading') : t('btn.save')}
          </button>
        </div>

        {/* Errors */}
        {Object.keys(errors).length > 0 && (
          <div style={{ marginTop: '8px', color: 'var(--danger)', fontSize: '11px' }}>
            {Object.values(errors)[0]}
          </div>
        )}
      </form>
    </Wrapper>
  );
};

export default ManualEntry;
