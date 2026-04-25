import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus } from 'lucide-react';
import { useI18n } from '../../i18n';

interface InlinePickerProps {
  value: string;
  options: string[];
  placeholder: string;
  onSelect: (value: string) => void;
  onAdd?: (value: string) => Promise<void>;
  addPlaceholder?: string;
  color?: string;
  /**
   * When true, the "Add new" affordance is hidden even if onAdd is provided.
   * Used to gate adding values for restricted roles (e.g., Mitarbeiter cannot
   * add new Format / Tätigkeit values).
   */
  canAdd?: boolean;
}

const InlinePicker: React.FC<InlinePickerProps> = ({
  value,
  options,
  placeholder,
  onSelect,
  onAdd,
  addPlaceholder,
  color,
  canAdd = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState('');
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Calculate dropdown position when opening
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 4,
      left: rect.left,
    });
  }, [isOpen]);

  // Close on outside click (check both trigger and portal dropdown)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = containerRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inTrigger && !inDropdown) {
        setIsOpen(false);
        setFilter('');
        setIsAdding(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Auto-focus filter input when opening
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Auto-focus new input when switching to add mode
  useEffect(() => {
    if (isAdding && newInputRef.current) {
      newInputRef.current.focus();
    }
  }, [isAdding]);

  // Filter options
  const filtered = options.filter((opt) =>
    opt.toLowerCase().includes(filter.toLowerCase())
  );

  const handleSelect = (opt: string) => {
    onSelect(opt);
    setIsOpen(false);
    setFilter('');
  };

  const handleAdd = async () => {
    if (!newValue.trim() || !onAdd) return;
    await onAdd(newValue.trim());
    onSelect(newValue.trim());
    setNewValue('');
    setIsAdding(false);
    setIsOpen(false);
  };

  const displayColor = color || 'var(--text-secondary)';

  return (
    <div ref={containerRef} style={{ position: 'relative', minWidth: 0 }}>
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 6px',
          borderRadius: '6px',
          border: 'none',
          background: isOpen ? 'rgba(201,169,98,0.08)' : 'transparent',
          color: value ? 'var(--text)' : 'var(--text-muted)',
          fontSize: '12px',
          fontWeight: value ? 600 : 400,
          cursor: 'pointer',
          transition: 'all 0.15s',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e) => {
          if (!isOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        }}
        onMouseLeave={(e) => {
          if (!isOpen) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: value ? displayColor : undefined,
        }}>
          {value || placeholder}
        </span>
        <ChevronDown
          className="w-3 h-3 flex-shrink-0"
          style={{
            color: 'var(--text-muted)',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {/* Dropdown (rendered via portal to escape overflow:hidden parents) */}
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            minWidth: '180px',
            maxWidth: '260px',
            maxHeight: '240px',
            background: 'var(--surface-solid, #1a1a2e)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            zIndex: 9999,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search input */}
          <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
            <input
              id="picker-filter"
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('stack.search')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length === 1) {
                  handleSelect(filtered[0]);
                } else if (e.key === 'Escape') {
                  setIsOpen(false);
                  setFilter('');
                }
              }}
              style={{
                width: '100%',
                padding: '5px 8px',
                border: '1px solid var(--border)',
                borderRadius: '5px',
                background: 'transparent',
                color: 'var(--text)',
                fontSize: '12px',
                outline: 'none',
                fontFamily: 'var(--font)',
              }}
              aria-label={t('stack.search')}
            />
          </div>

          {/* Options list */}
          <div style={{ overflow: 'auto', flex: 1, maxHeight: '160px' }}>
            {filtered.length === 0 && !isAdding && (
              <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: '11px', textAlign: 'center' }}>
                {t('stack.noMatch')}
              </div>
            )}
            {filtered.map((opt) => (
              <button
                key={opt}
                onClick={() => handleSelect(opt)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 12px',
                  border: 'none',
                  background: opt === value ? 'rgba(201,169,98,0.08)' : 'transparent',
                  color: opt === value ? 'var(--neon-cyan)' : 'var(--text)',
                  fontSize: '12px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                  fontWeight: opt === value ? 600 : 400,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = opt === value ? 'rgba(201,169,98,0.08)' : 'transparent';
                }}
              >
                {opt}
              </button>
            ))}
          </div>

          {/* Add new */}
          {onAdd && canAdd && (
            <div style={{ borderTop: '1px solid var(--border)', padding: '6px 8px' }}>
              {isAdding ? (
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input
                    id="picker-new-value"
                    ref={newInputRef}
                    type="text"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder={addPlaceholder || 'Neu...'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAdd();
                      if (e.key === 'Escape') setIsAdding(false);
                    }}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      background: 'transparent',
                      color: 'var(--text)',
                      fontSize: '11px',
                      outline: 'none',
                      fontFamily: 'var(--font)',
                    }}
                    aria-label={addPlaceholder || 'Add new value'}
                  />
                  <button
                    onClick={handleAdd}
                    style={{
                      padding: '4px 8px',
                      background: 'var(--success)',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setIsAdding(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    width: '100%',
                    padding: '4px 4px',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--neon-cyan)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                >
                  <Plus className="w-3 h-3" /> {t('stack.addNew')}
                </button>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

export default InlinePicker;
