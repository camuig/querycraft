import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";
import type { CellValue, ColumnMeta, DbKind } from "../../api/types";
import { toCsv, toJson, toSqlInserts, toTsv } from "../../lib/format";
import { toast } from "../../store/toastStore";
import { PopupMenu } from "../common/PopupMenu";

export interface ExportMenuProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  kind: DbKind;
  /** File name without extension. */
  fileBaseName?: string;
  database?: string | null;
  /** Table name for SQL INSERT (if the result isn't a single table, an arbitrary name works). */
  table?: string;
}

async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}

/** "Export ▾" button with a menu: CSV/JSON to file, copy as TSV/SQL INSERT. */
export function ExportMenu(props: ExportMenuProps) {
  const [pos, setPos] = useState<{ x: number; y: number; anchorHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const baseName = props.fileBaseName ?? "result";
  const tableName = props.table ?? "result";

  async function handleCsv() {
    setPos(null);
    const path = await save({ defaultPath: `${baseName}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, toCsv(props.columns, props.rows));
      toast.success(`Exported to ${path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  async function handleJson() {
    setPos(null);
    const path = await save({ defaultPath: `${baseName}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, toJson(props.columns, props.rows));
      toast.success(`Exported to ${path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  async function handleCopyTsv() {
    setPos(null);
    await copyText(toTsv(props.columns, props.rows));
    toast.success("Copied as TSV");
  }

  async function handleCopySqlInsert() {
    setPos(null);
    await copyText(toSqlInserts(props.database ?? null, tableName, props.columns, props.rows, props.kind));
    toast.success("Copied as SQL INSERT");
  }

  return (
    <div className="export-menu">
      <button
        type="button"
        ref={buttonRef}
        className="outline"
        disabled={props.rows.length === 0}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          setPos(
            rect
              ? { x: rect.left, y: rect.bottom + 4, anchorHeight: rect.height + 8 }
              : { x: 0, y: 0, anchorHeight: 0 },
          );
        }}
      >
        Export ▾
      </button>
      {open && pos && (
        <PopupMenu x={pos.x} y={pos.y} anchorHeight={pos.anchorHeight}>
          <div className="item" onClick={handleCsv}>
            CSV to file
          </div>
          <div className="item" onClick={handleJson}>
            JSON to file
          </div>
          <div className="divider" />
          <div className="item" onClick={handleCopyTsv}>
            Copy as TSV
          </div>
          <div className="item" onClick={handleCopySqlInsert}>
            Copy as SQL INSERT
          </div>
        </PopupMenu>
      )}
    </div>
  );
}
