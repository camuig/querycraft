import type { DbKind } from "../../api/types";
import { dialectFor } from "../../lib/dialect";

interface BadgeSpec {
  color: string;
  monogram: string;
}

const BADGE: Partial<Record<DbKind, BadgeSpec>> = {
  mysql: { color: "#00758F", monogram: "My" },
  mariadb: { color: "#C0765A", monogram: "Ma" },
  postgres: { color: "#336791", monogram: "Pg" },
  sqlite: { color: "#0F80CC", monogram: "SL" },
  redis: { color: "#DC382D", monogram: "Rd" },
  valkey: { color: "#6B4FBB", monogram: "Vk" },
};

interface DbIconProps {
  kind: DbKind;
  size?: number;
  title?: string;
}

/** Small per-engine icon used in the explorer tree and the connection dialog. */
export function DbIcon({ kind, size = 14, title }: DbIconProps) {
  const label = title ?? dialectFor(kind).label;

  if (kind === "clickhouse") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
        <title>{label}</title>
        <rect x="1" y="1" width="2" height="14" fill="#FFCC00" />
        <rect x="4.5" y="1" width="2" height="14" fill="#FFCC00" />
        <rect x="8" y="1" width="2" height="14" fill="#FFCC00" />
        <rect x="11.5" y="1" width="2" height="14" fill="#FF3333" />
      </svg>
    );
  }

  const spec = BADGE[kind] ?? { color: "#666666", monogram: "?" };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
      <rect x="0" y="0" width="16" height="16" rx="3" fill={spec.color} />
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="#ffffff"
      >
        {spec.monogram}
      </text>
    </svg>
  );
}
