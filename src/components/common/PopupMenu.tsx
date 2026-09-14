import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface PopupMenuProps {
  /** Желаемая точка привязки (viewport). */
  x: number;
  y: number;
  /** Высота элемента-якоря: если меню не влезает снизу, оно откроется над якорем. */
  anchorHeight?: number;
  children: ReactNode;
}

const MARGIN = 8;

/** Всплывающее меню, которое после монтирования сдвигается так, чтобы не выходить за границы окна. */
export function PopupMenu({ x, y, anchorHeight = 0, children }: PopupMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y, visible: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (top + height > window.innerHeight - MARGIN) {
      const above = y - anchorHeight - height;
      top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - height - MARGIN);
    }
    if (left + width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    }
    setPos({ left, top, visible: true });
  }, [x, y, anchorHeight]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.visible ? "visible" : "hidden" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
