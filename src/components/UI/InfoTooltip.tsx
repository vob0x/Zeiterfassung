/**
 * InfoTooltip — kleiner „i"-Icon-Trigger der eine Erklärung einblendet.
 *
 * Verhalten:
 *   - Desktop: Hover öffnet, Mausweg schließt.
 *   - Mobile / Touch: Klick toggelt (kein hover-Konzept auf Touch).
 *   - Klick außerhalb (auch auf Desktop) schließt.
 *
 * Positionierung: Tooltip erscheint unterhalb des Icons, nach links
 * ausgerichtet, mit max-width damit lange Texte umbrechen statt aus
 * dem Layout auszubrechen.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  /** Erklärungstext, der im Tooltip erscheint. */
  text: string;
  /** Optional: Größe des Icons (default 12). */
  size?: number;
  /** Optional: zusätzlicher Inline-Style fürs Wrapper-Span. */
  style?: React.CSSProperties;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({ text, size = 12, style }) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  // Outside-click closes the tooltip — important on touch where there's
  // no hover-leave to fall back on.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
    };
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: 4,
        ...style,
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Info"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size + 4,
          height: size + 4,
          padding: 0,
          margin: 0,
          background: 'transparent',
          border: 'none',
          borderRadius: '50%',
          cursor: 'help',
          color: 'var(--text-muted)',
          opacity: open ? 1 : 0.6,
          transition: 'opacity 0.15s',
        }}
      >
        <Info size={size} />
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 1000,
            minWidth: 220,
            maxWidth: 320,
            padding: '8px 10px',
            background: 'var(--surface-solid, #1f1d1a)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            fontSize: 11,
            lineHeight: 1.4,
            fontWeight: 400,
            letterSpacing: 0,
            textTransform: 'none',
            whiteSpace: 'normal',
            pointerEvents: 'none',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
};

export default InfoTooltip;
