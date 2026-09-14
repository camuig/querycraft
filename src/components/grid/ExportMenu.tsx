import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { CellValue, ColumnMeta } from "../../api/types";
import { toCsv, toJson, toSqlInserts, toTsv } from "../../lib/format";
import { toast } from "../../store/toastStore";
import { PopupMenu } from "../common/PopupMenu";

export interface ExportMenuProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** Имя файла без расширения. */
  fileBaseName?: string;
  database?: string | null;
  /** Имя таблицы для SQL INSERT (если результат — не единая таблица, подойдёт условное имя). */
  table?: string;
}

async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}

/** Кнопка "Экспорт ▾" с меню: CSV/JSON в файл, копирование как TSV/SQL INSERT. */
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
      toast.success(`Экспортировано в ${path}`);
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
      toast.success(`Экспортировано в ${path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  async function handleCopyTsv() {
    setPos(null);
    await copyText(toTsv(props.columns, props.rows));
    toast.success("Скопировано как TSV");
  }

  async function handleCopySqlInsert() {
    setPos(null);
    await copyText(toSqlInserts(props.database ?? null, tableName, props.columns, props.rows));
    toast.success("Скопировано как SQL INSERT");
  }

  return (
    <div className="export-menu">
      <button
        ref={buttonRef}
        className="outline"
        disabled={props.rows.length === 0}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          setPos(rect ? { x: rect.left, y: rect.bottom + 4, anchorHeight: rect.height + 8 } : { x: 0, y: 0, anchorHeight: 0 });
        }}
      >
        Экспорт ▾
      </button>
      {open && pos && (
        <PopupMenu x={pos.x} y={pos.y} anchorHeight={pos.anchorHeight}>
          <div className="item" onClick={handleCsv}>
            CSV в файл
          </div>
          <div className="item" onClick={handleJson}>
            JSON в файл
          </div>
          <div className="divider" />
          <div className="item" onClick={handleCopyTsv}>
            Копировать как TSV
          </div>
          <div className="item" onClick={handleCopySqlInsert}>
            Копировать как SQL INSERT
          </div>
        </PopupMenu>
      )}
    </div>
  );
}
