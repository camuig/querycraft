import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";
import { exportQuery } from "../../api/commands";
import type { CellValue, ColumnMeta, DbKind, ExportFormat } from "../../api/types";
import { toCsv, toJson, toSqlInserts, toTsv } from "../../lib/format";
import { newId } from "../../lib/ids";
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
  /**
   * Set when `rows` are only the first rows of the result (truncated by the row limit): file
   * exports then re-run the statement on the backend without the limit and write every row.
   */
  fullResult?: FullResultSource;
}

export interface FullResultSource {
  connectionId: string;
  sessionId: string;
  sql: string;
  database: string | null;
}

const FILE_FORMATS: Record<ExportFormat, { name: string; extension: string }> = {
  csv: { name: "CSV", extension: "csv" },
  json: { name: "JSON", extension: "json" },
};

async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}

/**
 * "Export ▾" button with a menu: CSV/JSON to file, copy as TSV/SQL INSERT. Clipboard copies
 * take the rows as shown (sorted, limited); file exports contain the whole result.
 */
export function ExportMenu(props: ExportMenuProps) {
  const [pos, setPos] = useState<{ x: number; y: number; anchorHeight: number } | null>(null);
  const [exporting, setExporting] = useState(false);
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

  async function handleFile(format: ExportFormat) {
    setPos(null);
    const { name, extension } = FILE_FORMATS[format];
    const path = await save({ defaultPath: `${baseName}.${extension}`, filters: [{ name, extensions: [extension] }] });
    if (!path) return;
    setExporting(true);
    try {
      if (props.fullResult) {
        const { rows } = await exportQuery({ ...props.fullResult, queryId: newId(), format, path });
        toast.success(`Exported ${rows} rows to ${path}`);
      } else {
        const text = format === "csv" ? toCsv(props.columns, props.rows) : toJson(props.columns, props.rows);
        await writeTextFile(path, text);
        toast.success(`Exported to ${path}`);
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
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
        disabled={props.rows.length === 0 || exporting}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          setPos(
            rect
              ? { x: rect.left, y: rect.bottom + 4, anchorHeight: rect.height + 8 }
              : { x: 0, y: 0, anchorHeight: 0 },
          );
        }}
      >
        {exporting ? "Exporting…" : "Export ▾"}
      </button>
      {open && pos && (
        <PopupMenu x={pos.x} y={pos.y} anchorHeight={pos.anchorHeight}>
          <div className="item" onClick={() => handleFile("csv")}>
            CSV to file
          </div>
          <div className="item" onClick={() => handleFile("json")}>
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
