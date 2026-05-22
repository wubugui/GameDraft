import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PanelLayout } from '../utils/layoutStorage';
import { savePanelLayout } from '../utils/layoutStorage';

type UsePanelResizeArgs = {
  setLayout: Dispatch<SetStateAction<PanelLayout>>;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function usePanelResize({ setLayout, leftCollapsed, rightCollapsed }: UsePanelResizeArgs) {
  const dragRef = useRef<null | { side: 'left' | 'right' | 'validation'; startX: number; startY: number; startSize: number }>(null);
  const moveRafRef = useRef<number | null>(null);

  const onMove = useCallback((event: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const clientX = event.clientX;
    const clientY = event.clientY;
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
    }
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const active = dragRef.current;
      if (!active) return;
      setLayout((prev) => {
        let updated = prev;
        if (active.side === 'left') {
          const delta = clientX - active.startX;
          updated = { ...prev, leftWidth: clamp(active.startSize + delta, 188, 360) };
        } else if (active.side === 'right') {
          const delta = clientX - active.startX;
          updated = { ...prev, rightWidth: clamp(active.startSize - delta, 280, 560) };
        } else {
          const delta = active.startY - clientY;
          updated = { ...prev, validationHeight: clamp(active.startSize + delta, 96, 360) };
        }
        savePanelLayout(updated);
        return updated;
      });
    });
  }, [setLayout]);

  const onUp = useCallback(() => {
    dragRef.current = null;
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }, [onMove]);

  const startLeft = useCallback((event: React.MouseEvent) => {
    if (leftCollapsed) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const width = target.parentElement?.getBoundingClientRect().width ?? 260;
    dragRef.current = { side: 'left', startX: event.clientX, startY: event.clientY, startSize: width };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftCollapsed, onMove, onUp]);

  const startRight = useCallback((event: React.MouseEvent) => {
    if (rightCollapsed) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const width = target.parentElement?.getBoundingClientRect().width ?? 380;
    dragRef.current = { side: 'right', startX: event.clientX, startY: event.clientY, startSize: width };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [rightCollapsed, onMove, onUp]);

  const startValidation = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const height = target.parentElement?.getBoundingClientRect().height ?? 148;
    dragRef.current = { side: 'validation', startX: event.clientX, startY: event.clientY, startSize: height };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onMove, onUp]);

  return { startLeft, startRight, startValidation };
}
