import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useEntriesStore } from '../../stores/entriesStore';
import { getUserData, setUserData } from '../../lib/userStorage';

const NOTES_HISTORY_KEY = 'note_history';
const MAX_HISTORY = 200;

/**
 * Collects unique notes from entries + localStorage history.
 * Returns sorted by frequency (most used first).
 */
function useNoteHistory(): string[] {
  const entries = useEntriesStore((s) => s.entries);

  return useMemo(() => {
    // Merge: entry notes + saved history
    const saved: string[] = getUserData(NOTES_HISTORY_KEY, []);
    const countMap = new Map<string, number>();

    // Count from saved history (already deduplicated)
    for (const note of saved) {
      if (note && note.trim()) {
        const key = note.trim();
        countMap.set(key, (countMap.get(key) || 0) + 2); // Boost saved
      }
    }

    // Count from actual entries
    for (const entry of entries) {
      if (entry.notiz && entry.notiz.trim()) {
        const key = entry.notiz.trim();
        countMap.set(key, (countMap.get(key) || 0) + 1);
      }
    }

    // Sort by frequency descending
    return Array.from(countMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([note]) => note);
  }, [entries]);
}

/** Save a new note to localStorage history */
export function saveNoteToHistory(note: string): void {
  if (!note || !note.trim()) return;
  const trimmed = note.trim();
  const history: string[] = getUserData(NOTES_HISTORY_KEY, []);
  // Remove duplicates, prepend new
  const updated = [trimmed, ...history.filter((n) => n !== trimmed)].slice(0, MAX_HISTORY);
  setUserData(NOTES_HISTORY_KEY, updated);
}

interface NoteInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  className?: string;
  /** Compact mode for timer lanes (smaller font) */
  compact?: boolean;
}

export default function NoteInput({ value, onChange, placeholder, style, className, compact }: NoteInputProps) {
  const allNotes = useNoteHistory();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Portal-rendered dropdown position — recomputed each time the dropdown
  // opens so it tracks the input even when the parent (e.g. TimerLane)
  // clips with overflow:hidden, which previously hid the suggestions.
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  // Filter suggestions based on current input
  const suggestions = useMemo(() => {
    if (!value || !value.trim()) {
      // Show recent notes when input is empty but focused
      return allNotes.slice(0, 8);
    }
    const search = value.toLowerCase().trim();
    return allNotes
      .filter((note) => note.toLowerCase().includes(search) && note !== value.trim())
      .slice(0, 8);
  }, [value, allNotes]);

  // Close on outside click — must consider both the wrapper AND the
  // portal-rendered dropdown (which lives outside wrapperRef in the DOM).
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrapper = wrapperRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inWrapper && !inDropdown) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Recompute the dropdown position whenever it opens or the input layout
  // changes underneath us (window resize / scroll while open).
  useEffect(() => {
    if (!showSuggestions) return;
    function reposition() {
      if (!inputRef.current) return;
      const rect = inputRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 2,
        left: rect.left,
        width: rect.width,
      });
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [showSuggestions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      onChange(suggestions[selectedIdx]);
      setShowSuggestions(false);
      setSelectedIdx(-1);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIdx(-1);
    }
  };

  const selectSuggestion = (note: string) => {
    onChange(note);
    setShowSuggestions(false);
    setSelectedIdx(-1);
    inputRef.current?.focus();
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setShowSuggestions(true);
          setSelectedIdx(-1);
        }}
        onFocus={() => setShowSuggestions(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={style}
        className={className}
      />

      {/* Suggestions rendered via portal so overflow:hidden ancestors
          (e.g. the TimerLane container) cannot clip the dropdown. */}
      {showSuggestions && suggestions.length > 0 && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            zIndex: 9999,
            background: 'var(--surface-solid, var(--surface))',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            maxHeight: compact ? '150px' : '200px',
            overflowY: 'auto',
          }}
        >
          {suggestions.map((note, idx) => (
            <div
              key={note}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(note);
              }}
              onMouseEnter={() => setSelectedIdx(idx)}
              style={{
                padding: compact ? '5px 10px' : '8px 12px',
                cursor: 'pointer',
                fontSize: compact ? '11px' : '13px',
                color: 'var(--text)',
                background: idx === selectedIdx ? 'var(--surface-hover)' : 'transparent',
                borderBottom: idx < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {note}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
