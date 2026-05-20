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
  const dragRef = useRef<null | { side: 'left' | 'right'; startX: number; startWidth: number }>(null);
  const moveRafRef = useRef<number | null>(null);

  const onMove = useCallback((event: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const clientX = event.clientX;
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
    }
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const active = dragRef.current;
      if (!active) return;
      const delta = clientX - active.startX;
      setLayout((prev) => {
        const updated = active.side === 'left'
          ? { ...prev, leftWidth: clamp(active.startWidth + delta, 200, 420) }
          : { ...prev, rightWidth: clamp(active.startWidth - delta, 280, 560) };
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
    dragRef.current = { side: 'left', startX: event.clientX, startWidth: width };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftCollapsed, onMove, onUp]);

  const startRight = useCallback((event: React.MouseEvent) => {
    if (rightCollapsed) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const width = target.parentElement?.getBoundingClientRect().width ?? 380;
    dragRef.current = { side: 'right', startX: event.clientX, startWidth: width };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [rightCollapsed, onMove, onUp]);

  return { startLeft, startRight };
}
