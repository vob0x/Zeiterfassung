import React, { useState } from 'react';
import { TimerSlot } from '@/types';
import { useTimerStore } from '../../stores/timerStore';
import { useEntriesStore } from '../../stores/entriesStore';
import { useMasterStore } from '../../stores/masterStore';
import { useI18n } from '../../i18n';
import { useUiStore } from '../../stores/uiStore';
import { Play, Pause, Square, X } from 'lucide-react';
import { formatDateISO } from '../../lib/utils';
import { formatDuration } from '../../lib/utils';

interface TaskSlotProps {
  slot: TimerSlot;
  index: number;
}

const TaskSlot: React.FC<TaskSlotProps> = ({ slot }) => {
  const { t } = useI18n();
  const { showToast } = useUiStore();
  const {
    pauseTimer,
    resumeTimer,
    resetSlot,
    removeSlot,
    updateSlotField,
    getSlotElapsed,
  } = useTimerStore();
  const { add: addEntry } = useEntriesStore();
  const {
    stakeholders,
    projects,
    activities,
    addStakeholder: addStakeholderToStore,
    addProject: addProjectToStore,
    addActivity: addActivityToStore,
  } = useMasterStore();

  const [showAddStakeholder, setShowAddStakeholder] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showAddActivity, setShowAddActivity] = useState(false);
  const [newStakeholder, setNewStakeholder] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newActivity, setNewActivity] = useState('');

  // Live elapsed - recalculates every render (tick triggers re-render)
  const elapsedMs = getSlotElapsed(slot.id);

  // Slot state
  const isRunning = !slot.isPaused && elapsedMs > 0;
  const isPaused = slot.isPaused && elapsedMs > 0;

  // Handle play/pause toggle
  const handlePlayPause = () => {
    if (slot.isPaused) {
      resumeTimer(slot.id);
    } else {
      pauseTimer(slot.id);
    }
  };

  // Handle stop and save - keeps slot visible, resets timer
  const handleStopAndSave = async () => {
    const currentElapsed = getSlotElapsed(slot.id);

    if (currentElapsed < 1000) {
      showToast(t('toast.tooShort'), 'warning');
      return;
    }

    const now = new Date();
    const endTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const startDate = new Date(now.getTime() - currentElapsed);
    const startTimeStr = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;

    try {
      await addEntry({
        date: slot.date || formatDateISO(now),
        stakeholder: slot.stakeholder,
        projekt: slot.projekt,
        taetigkeit: slot.taetigkeit,
        start_time: startTimeStr,
        end_time: endTime,
        duration_ms: currentElapsed,
        notiz: slot.notiz || '',
      });
      resetSlot(slot.id);
    } catch (error) {
      console.error('Failed to save entry:', error);
    }
  };

  // Handle add new dimension
  const handleAddStakeholder = async () => {
    if (newStakeholder.trim()) {
      try {
        await addStakeholderToStore(newStakeholder.trim());
        updateSlotField(slot.id, 'stakeholder', newStakeholder.trim());
        setNewStakeholder('');
        setShowAddStakeholder(false);
      } catch (error) {
        console.error('Failed to add stakeholder:', error);
      }
    }
  };

  const handleAddProject = async () => {
    if (newProject.trim()) {
      try {
        await addProjectToStore(newProject.trim());
        updateSlotField(slot.id, 'projekt', newProject.trim());
        setNewProject('');
        setShowAddProject(false);
      } catch (error) {
        console.error('Failed to add project:', error);
      }
    }
  };

  const handleAddActivity = async () => {
    if (newActivity.trim()) {
      try {
        await addActivityToStore(newActivity.trim());
        updateSlotField(slot.id, 'taetigkeit', newActivity.trim());
        setNewActivity('');
        setShowAddActivity(false);
      } catch (error) {
        console.error('Failed to add activity:', error);
      }
    }
  };

  // V5.15 left-border color based on state
  const leftBorderColor = isRunning
    ? 'var(--neon-cyan)'
    : isPaused
      ? 'var(--warning)'
      : 'var(--border)';

  // V5.15 button styles (32px circles)
  const btnBase: React.CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1.5px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    transition: 'all 0.2s',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '5px 8px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: 'var(--text)',
    fontFamily: 'var(--font)',
    fontSize: '12px',
    outline: 'none',
  };

  const inlineInputStyle: React.CSSProperties = {
    ...selectStyle,
    flex: 1,
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '14px',
        paddingLeft: '18px',
        background: isRunning
          ? 'rgba(201,169,98,0.025)'
          : isPaused
            ? 'rgba(251,191,36,0.02)'
            : 'rgba(0,0,0,0.06)',
        transition: 'all 0.25s',
        position: 'relative',
        borderLeft: `3px solid ${leftBorderColor}`,
        borderColor: isRunning
          ? 'rgba(201,169,98,0.30)'
          : isPaused
            ? 'rgba(251,191,36,0.3)'
            : 'var(--border)',
        boxShadow: isRunning
          ? '0 0 25px rgba(201,169,98,0.05), inset 0 1px 0 rgba(201,169,98,0.07)'
          : 'none',
      }}
    >
      {/* Header: Status + Timer + Buttons */}
      <div className="flex items-center gap-2 mb-2" style={{ minHeight: '32px' }}>
        {/* Status badge */}
        {(isRunning || isPaused) && (
          <span
            className="text-[8px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full"
            style={{
              background: isRunning ? 'rgba(201, 169, 98, 0.08)' : 'rgba(251, 191, 36, 0.12)',
              color: isRunning ? 'var(--neon-cyan)' : 'var(--warning)',
            }}
          >
            {isRunning ? t('timer.running') : t('timer.paused')}
          </span>
        )}

        {/* Elapsed time */}
        <div
          className="font-mono font-bold flex-1 text-right"
          style={{
            fontSize: '18px',
            color: isRunning ? 'var(--neon-cyan)' : isPaused ? 'var(--warning)' : 'var(--text-muted)',
          }}
        >
          {formatDuration(elapsedMs)}
        </div>

        {/* Play/Pause */}
        <button
          onClick={handlePlayPause}
          style={{
            ...btnBase,
            borderColor: isRunning ? 'var(--neon-cyan)' : isPaused ? 'var(--warning)' : 'var(--border)',
            color: isRunning ? 'var(--neon-cyan)' : isPaused ? 'var(--warning)' : 'var(--text-muted)',
          }}
          title={slot.isPaused ? t('timer.start') : t('timer.pause')}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--neon-cyan)';
            e.currentTarget.style.color = 'var(--neon-cyan)';
            e.currentTarget.style.background = 'rgba(201, 169, 98, 0.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = isRunning ? 'var(--neon-cyan)' : isPaused ? 'var(--warning)' : 'var(--border)';
            e.currentTarget.style.color = isRunning ? 'var(--neon-cyan)' : isPaused ? 'var(--warning)' : 'var(--text-muted)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {slot.isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
        </button>

        {/* Stop & Save (visible when running or paused with elapsed) */}
        {(isRunning || isPaused) && (
          <button
            onClick={handleStopAndSave}
            style={btnBase}
            title={t('timer.stopSave')}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--danger)';
              e.currentTarget.style.color = 'var(--danger)';
              e.currentTarget.style.background = 'rgba(212, 112, 110, 0.06)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)';
              e.currentTarget.style.color = 'var(--text-muted)';
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Remove */}
        <button
          onClick={() => removeSlot(slot.id)}
          style={btnBase}
          title={t('timer.removeTask')}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--danger)';
            e.currentTarget.style.color = 'var(--danger)';
            e.currentTarget.style.background = 'rgba(212, 112, 110, 0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.color = 'var(--text-muted)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* V5.15: 3-column field grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
        {/* Stakeholder */}
        <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch' }}>
          <select
            value={slot.stakeholder}
            onChange={(e) => updateSlotField(slot.id, 'stakeholder', e.target.value)}
            style={{ ...selectStyle, flex: 1, minWidth: 0 }}
          >
            <option value="">{t('ph.stakeholder')}</option>
            {stakeholders.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            onClick={() => setShowAddStakeholder(!showAddStakeholder)}
            style={{
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
            }}
          >
            +
          </button>
        </div>

        {/* Project */}
        <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch' }}>
          <select
            value={slot.projekt}
            onChange={(e) => updateSlotField(slot.id, 'projekt', e.target.value)}
            style={{ ...selectStyle, flex: 1, minWidth: 0 }}
          >
            <option value="">{t('ph.projekt')}</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button
            onClick={() => setShowAddProject(!showAddProject)}
            style={{
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
            }}
          >
            +
          </button>
        </div>

        {/* Activity */}
        <div style={{ display: 'flex', gap: '4px', alignItems: 'stretch' }}>
          <select
            value={slot.taetigkeit}
            onChange={(e) => updateSlotField(slot.id, 'taetigkeit', e.target.value)}
            style={{ ...selectStyle, flex: 1, minWidth: 0 }}
          >
            <option value="">{t('ph.taetigkeit')}</option>
            {activities.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <button
            onClick={() => setShowAddActivity(!showAddActivity)}
            style={{
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
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Inline add rows */}
      {showAddStakeholder && (
        <div className="flex gap-1 mb-2">
          <input
            id="ts-new-stakeholder"
            type="text"
            placeholder={t('ph.newStakeholder')}
            value={newStakeholder}
            onChange={(e) => setNewStakeholder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddStakeholder();
              if (e.key === 'Escape') { setShowAddStakeholder(false); setNewStakeholder(''); }
            }}
            onBlur={() => { if (!newStakeholder.trim()) { setShowAddStakeholder(false); setNewStakeholder(''); } }}
            style={inlineInputStyle}
            autoFocus
            aria-label={t('ph.newStakeholder')}
          />
          <button
            onClick={handleAddStakeholder}
            style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
          >
            {t('btn.save')}
          </button>
          <button
            onClick={() => { setShowAddStakeholder(false); setNewStakeholder(''); }}
            style={{ padding: '4px 6px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '11px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}
      {showAddProject && (
        <div className="flex gap-1 mb-2">
          <input
            id="ts-new-project"
            type="text"
            placeholder={t('ph.newProjekt')}
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddProject();
              if (e.key === 'Escape') { setShowAddProject(false); setNewProject(''); }
            }}
            onBlur={() => { if (!newProject.trim()) { setShowAddProject(false); setNewProject(''); } }}
            style={inlineInputStyle}
            autoFocus
            aria-label={t('ph.newProjekt')}
          />
          <button
            onClick={handleAddProject}
            style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
          >
            {t('btn.save')}
          </button>
          <button
            onClick={() => { setShowAddProject(false); setNewProject(''); }}
            style={{ padding: '4px 6px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '11px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}
      {showAddActivity && (
        <div className="flex gap-1 mb-2">
          <input
            id="ts-new-activity"
            type="text"
            placeholder={t('ph.newTaetigkeit')}
            value={newActivity}
            onChange={(e) => setNewActivity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddActivity();
              if (e.key === 'Escape') { setShowAddActivity(false); setNewActivity(''); }
            }}
            onBlur={() => { if (!newActivity.trim()) { setShowAddActivity(false); setNewActivity(''); } }}
            style={inlineInputStyle}
            autoFocus
            aria-label={t('ph.newTaetigkeit')}
          />
          <button
            onClick={handleAddActivity}
            style={{ padding: '4px 8px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
          >
            {t('btn.save')}
          </button>
          <button
            onClick={() => { setShowAddActivity(false); setNewActivity(''); }}
            style={{ padding: '4px 6px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '11px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Note */}
      <input
        id="ts-notiz"
        type="text"
        placeholder={t('ph.notiz')}
        value={slot.notiz || ''}
        onChange={(e) => updateSlotField(slot.id, 'notiz', e.target.value)}
        style={{
          ...selectStyle,
          width: '100%',
        }}
        aria-label={t('ph.notiz')}
      />
    </div>
  );
};

export default TaskSlot;
