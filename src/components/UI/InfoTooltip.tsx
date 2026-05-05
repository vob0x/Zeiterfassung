/**
 * InfoTooltip — kleiner „i"-Icon-Trigger der eine Erklärung einblendet.
 *
 * Verhalten:
 *   - Desktop: Hover öffnet, Mausweg schließt.
 *   - Mobile / Touch: Klick toggelt (kein hover-Konzept auf Touch).
 *   - Klick außerhalb (auch auf Desktop) schließt.
 *
 * Positionierung — Portal zu document.body, weil viele Elternelemente
 * `overflow: hidden` haben (Dashboard-KPI-Cards, Tabellen-Zellen, …)
 * und ein absolut-positionierter Tooltip dort beschnitten würde. Per
 * getBoundingClientRect ermitteln wir die Trigger-Position, rendern
 * den Tooltip via Portal mit `position: fixed`, und korrigieren
 * automatisch wenn er rechts/unten aus dem Viewport rausläuft.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  text: string;
  size?: number;
  style?: React.CSSProperties;
}

const TOOLTIP_MAX_WIDTH = 320;
const TOOLTIP_MIN_WIDTH = 220;
const VIEWPORT_PADDING = 8; // Mindestabstand zum Bildschirmrand

const InfoTooltip: React.FC<InfoTooltipProps> = ({ text, size = 12, style }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Outside-click closes the tooltip — wichtig auf Touch wo es kein
  // hover-leave gibt. Tooltip selbst wird ausgeschlossen, damit ein
  // Klick auf den Tooltip-Text ihn nicht direkt wieder schließt.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (tooltipRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
    };
  }, [open]);

  // Position ermitteln, sobald der Tooltip öffnet. useLayoutEffect statt
  // useEffect, damit das Messen passiert bevor der Browser zeichnet —
  // verhindert Flackern an falscher Position für einen Frame.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const calcPos = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Default: unterhalb des Triggers, links-bündig
      let top = rect.bottom + 4;
      let left = rect.left;
      // Effective width: passt minWidth und maxWidth ans verfügbare an
      const availableRight = vw - left - VIEWPORT_PADDING;
      let width = Math.min(TOOLTIP_MAX_WIDTH, Math.max(TOOLTIP_MIN_WIDTH, availableRight));
      // Falls auch das zu schmal wäre: rechts-bündig statt links-bündig
      if (availableRight < TOOLTIP_MIN_WIDTH) {
        width = Math.min(TOOLTIP_MAX_WIDTH, vw - 2 * VIEWPORT_PADDING);
        left = Math.max(VIEWPORT_PADDING, vw - VIEWPORT_PADDING - width);
      }
      // Vertikales Clipping: falls unten zu wenig Platz, oberhalb plazieren
      // Wir kennen die echte Tooltip-Höhe noch nicht — schätzen großzügig
      // (Tooltip-Texte sind 1-3 Zeilen, ~80px Worst-Case). Falls zu eng,
      // oberhalb positionieren.
      const estimatedHeight = 120;
      if (top + estimatedHeight > vh - VIEWPORT_PADDING) {
        const above = rect.top - 4 - estimatedHeight;
        if (above >= VIEWPORT_PADDING) {
          top = rect.top - 4 - estimatedHeight;
        } else {
          // Weder unten noch oben Platz — clamp an Viewport-Top
          top = VIEWPORT_PADDING;
        }
      }
      setPos({ top, left, width });
    };
    calcPos();
    // Falls User scrollt oder Fenster resized während Tooltip offen:
    // Position neu berechnen (oder einfach schließen — wir gehen mit
    // recalc, ist freundlicher).
    window.addEventListener('scroll', calcPos, true);
    window.addEventListener('resize', calcPos);
    return () => {
      window.removeEventListener('scroll', calcPos, true);
      window.removeEventListener('resize', calcPos);
    };
  }, [open]);

  return (
    <span
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
        ref={triggerRef}
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
      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={tooltipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: pos.width,
              maxWidth: TOOLTIP_MAX_WIDTH,
              zIndex: 10000,
              padding: '10px 12px',
              background: 'var(--surface-solid, #1f1d1a)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
              fontSize: 12,
              lineHeight: 1.45,
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: 'none',
              whiteSpace: 'normal',
              // Tooltip soll selbst nicht klickbar sein, aber MouseEnter
              // soll ihn nicht schließen — wir lassen pointer-events an,
              // damit der Outside-Click-Handler das richtige Ziel sieht.
            }}
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
};

export default InfoTooltip;
