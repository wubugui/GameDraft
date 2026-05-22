import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export type ToolbarMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

export function ToolbarMenuDropdown(props: {
  label: string;
  items: ToolbarMenuItem[];
  activeItemId?: string;
  buttonClassName?: string;
  align?: 'start' | 'end';
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

  const openMenu = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchorRect(rect);
    setOpen(true);
  }, []);

  const toggleMenu = useCallback(() => {
    if (open) close();
    else openMenu();
  }, [close, open, openMenu]);

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

  const selectItem = useCallback((item: ToolbarMenuItem) => {
    if (item.disabled) return;
    item.onSelect();
    close();
  }, [close]);

  const popover = open && anchorRect
    ? createPortal(
      <div
        id={popoverId}
        className="toolbar-menu-popover add-menu-popover"
        role="menu"
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
      >
        {props.items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`toolbar-menu-popover-item add-menu-popover-item${props.activeItemId === item.id ? ' active' : ''}`}
            disabled={item.disabled}
            onClick={() => selectItem(item)}
          >
            {item.label}
          </button>
        ))}
      </div>,
      document.body,
    )
    : null;

  const btnClass = ['toolbar-btn', open ? 'active' : '', props.buttonClassName ?? ''].filter(Boolean).join(' ');

  return (
    <div className="toolbar-menu-dropdown add-menu-dropdown" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={btnClass}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggleMenu}
      >
        {props.label}
        <span className="toolbar-menu-caret add-menu-caret" aria-hidden>▾</span>
      </button>
      {popover}
    </div>
  );
}
