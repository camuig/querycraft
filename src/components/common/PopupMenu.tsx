import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface PopupMenuProps {
  /** Desired anchor point (viewport). */
  x: number;
  y: number;
  /** Height of the anchor element: if the menu doesn't fit below, it opens above the anchor. */
  anchorHeight?: number;
  children: ReactNode;
}

const MARGIN = 8;

/** Popup menu that repositions itself after mounting so it stays within the window bounds. */
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
