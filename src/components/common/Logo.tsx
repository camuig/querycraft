import type { CSSProperties } from "react";

/** Марка QueryCraft (точки по контуру "Q"); цвет берётся из currentColor, акцентные точки — из --logo-accent. */
export function Logo({ size = 24, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={style} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="34" cy="18" r="6.5" />
        <circle cx="50" cy="18" r="6.5" />
        <circle cx="66" cy="18" r="6.5" />
        <circle cx="18" cy="34" r="6.5" />
        <circle cx="82" cy="34" r="6.5" />
        <circle cx="18" cy="50" r="6.5" />
        <circle cx="82" cy="50" r="6.5" />
        <circle cx="18" cy="66" r="6.5" />
        <circle cx="82" cy="66" r="6.5" />
        <circle cx="34" cy="82" r="6.5" />
        <circle cx="50" cy="82" r="6.5" />
        <circle cx="66" cy="82" r="6.5" />
      </g>
      <g fill="var(--logo-accent, #C8721F)">
        <circle cx="64" cy="64" r="6.5" />
        <circle cx="82" cy="82" r="8" />
      </g>
    </svg>
  );
}
