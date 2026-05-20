import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type AddMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

export function AddMenuDropdown(props: { label?: string; items: AddMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
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
      const popover = document.getElementById('narrative-add-menu-popover');
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
  }, [close, open]);

  const selectItem = useCallback((item: AddMenuItem) => {
    if (item.disabled) return;
    item.onSelect();
    close();
  }, [close]);

  const popover = open && anchorRect
    ? createPortal(
      <div
        id="narrative-add-menu-popover"
        className="add-menu-popover"
        role="menu"
        style={{
          position: 'fixed',
          top: anchorRect.bottom + 4,
          left: anchorRect.left,
          zIndex: 10000,
        }}
      >
        {props.items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="add-menu-popover-item"
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

  return (
    <div className="add-menu-dropdown" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`toolbar-btn ${open ? 'active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggleMenu}
      >
        {props.label ?? '添加'}
        <span className="add-menu-caret" aria-hidden>▾</span>
      </button>
      {popover}
    </div>
  );
}
