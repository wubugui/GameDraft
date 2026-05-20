import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ToolbarPopover(props: {
  label: string;
  active?: boolean;
  panelClassName?: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setAnchorRect(null);
  }, []);

  const openPanel = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchorRect(rect);
    setOpen(true);
  }, []);

  const togglePanel = useCallback(() => {
    if (open) close();
    else openPanel();
  }, [close, open, openPanel]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      const popover = document.getElementById(popoverId);
      if (popover?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onLayout = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setAnchorRect(rect);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
    };
  }, [close, open, popoverId]);

  const panel = open && anchorRect
    ? createPortal(
      <div
        id={popoverId}
        className={`toolbar-popover-panel ${props.panelClassName ?? ''}`.trim()}
        style={(() => {
          const style: CSSProperties = {
            position: 'fixed',
            top: anchorRect.bottom + 4,
            zIndex: 10000,
          };
          if (props.align === 'end') {
            style.right = Math.max(8, window.innerWidth - anchorRect.right);
          } else {
            style.left = anchorRect.left;
          }
          return style;
        })()}
        onClick={(event) => event.stopPropagation()}
      >
        {props.children}
      </div>,
      document.body,
    )
    : null;

  return (
    <div className="toolbar-popover" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`toolbar-btn ${open || props.active ? 'active' : ''}`.trim()}
        aria-expanded={open}
        onClick={togglePanel}
      >
        {props.label}
        <span className="toolbar-popover-caret" aria-hidden>▾</span>
      </button>
      {panel}
    </div>
  );
}
