import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { CellValue, ColumnMeta } from "../../api/types";
import { formatCell } from "../../lib/format";
import { GridCell } from "./GridCell";
import { useGridSelection, type GridCellPos, type GridRange } from "./useGridSelection";
import "../../styles/grid.css";

export type { GridCellPos, GridRange } from "./useGridSelection";

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 36;
const MEASURE_FONT = '12.5px "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface DataGridProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  getCellValue?: (row: number, col: number) => CellValue;
  cellClass?: (row: number, col: number) => string | undefined;
  sort?: { column: number; dir: "asc" | "desc" } | null;
  onSort?: (column: number) => void;
  selectedCell?: GridCellPos | null;
  onSelectCell?: (cell: GridCellPos | null) => void;
  editable?: boolean;
  onEditCell?: (row: number, col: number, value: CellValue) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

let measureCanvasCtx: CanvasRenderingContext2D | null | undefined;
function measureTextWidth(text: string): number {
  if (measureCanvasCtx === undefined) {
    const canvas = document.createElement("canvas");
    measureCanvasCtx = canvas.getContext("2d");
  }
  if (!measureCanvasCtx) return text.length * 7;
  measureCanvasCtx.font = MEASURE_FONT;
  return measureCanvasCtx.measureText(text).width;
}

function computeColumnWidths(columns: ColumnMeta[], rows: CellValue[][]): number[] {
  const sampleCount = Math.min(rows.length, 50);
  return columns.map((col, c) => {
    let max = measureTextWidth(col.name);
    for (let r = 0; r < sampleCount; r++) {
      const raw = formatCell(rows[r]?.[c] ?? null, col);
      const text = raw.length > 60 ? raw.slice(0, 60) : raw;
      const w = measureTextWidth(text);
      if (w > max) max = w;
    }
    return clamp(Math.ceil(max) + 26, 60, 400);
  });
}

/** Виртуализированный грид (строки и колонки) с выделением, редактированием и копированием. */
export function DataGrid(props: DataGridProps) {
  const { columns, rows, getCellValue, cellClass, sort, onSort, selectedCell, onSelectCell, editable, onEditCell } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerInnerRef = useRef<HTMLDivElement | null>(null);
  const gutterInnerRef = useRef<HTMLDivElement | null>(null);

  const [widths, setWidths] = useState<number[] | null>(null);
  useEffect(() => {
    setWidths(computeColumnWidths(columns, rows));
    // ширины пересчитываются только когда меняется набор колонок (новый запрос/таблица)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  const colWidths = widths && widths.length === columns.length ? widths : columns.map(() => 120);
  const gutterWidth = Math.max(44, String(rows.length).length * 9 + 20);

  const getValue = useCallback(
    (r: number, c: number): CellValue => (getCellValue ? getCellValue(r, c) : (rows[r]?.[c] ?? null)),
    [getCellValue, rows],
  );

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [contextMenu]);

  const handleCopyRange = useCallback(
    (range: GridRange) => {
      const lines: string[] = [];
      for (let r = range.minRow; r <= range.maxRow; r++) {
        const cells: string[] = [];
        for (let c = range.minCol; c <= range.maxCol; c++) {
          cells.push(formatCell(getValue(r, c), columns[c]));
        }
        lines.push(cells.join("\t"));
      }
      const text = lines.join("\n");
      writeText(text).catch(() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
      });
    },
    [getValue, columns],
  );

  const handleSetNullRange = useCallback(
    (range: GridRange) => {
      if (!editable) return;
      for (let r = range.minRow; r <= range.maxRow; r++) {
        for (let c = range.minCol; c <= range.maxCol; c++) {
          if (!columns[c]?.binary) onEditCell?.(r, c, null);
        }
      }
    },
    [editable, columns, onEditCell],
  );

  const sel = useGridSelection({
    rowCount: rows.length,
    colCount: columns.length,
    editable: !!editable,
    selectedCell,
    onSelectCell,
    onEditCell,
    getCellValue: getValue,
    isCellEditable: (_r, c) => !columns[c]?.binary,
    onCopy: handleCopyRange,
    onSetNull: handleSetNullRange,
  });

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const colVirtualizer = useVirtualizer({
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i] ?? 120,
    overscan: 3,
    horizontal: true,
  });

  useEffect(() => {
    if (!sel.selection) return;
    rowVirtualizer.scrollToIndex(sel.selection.focus.row, { align: "auto" });
    colVirtualizer.scrollToIndex(sel.selection.focus.col, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.selection?.focus.row, sel.selection?.focus.col]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (headerInnerRef.current) headerInnerRef.current.style.transform = `translateX(-${el.scrollLeft}px)`;
    if (gutterInnerRef.current) gutterInnerRef.current.style.transform = `translateY(-${el.scrollTop}px)`;
  }, []);

  const resizeStateRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null);
  const handleResizeMouseDown = useCallback(
    (e: ReactMouseEvent, colIndex: number) => {
      e.preventDefault();
      e.stopPropagation();
      resizeStateRef.current = { col: colIndex, startX: e.clientX, startWidth: colWidths[colIndex] ?? 120 };
      const onMove = (ev: MouseEvent) => {
        const st = resizeStateRef.current;
        if (!st) return;
        const nextWidth = clamp(st.startWidth + (ev.clientX - st.startX), 60, 400);
        setWidths((w) => {
          const base = w && w.length === columns.length ? w.slice() : columns.map(() => 120);
          base[st.col] = nextWidth;
          return base;
        });
      };
      const onUp = () => {
        resizeStateRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [colWidths, columns],
  );

  const totalWidth = colVirtualizer.getTotalSize();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div
      className="data-grid"
      tabIndex={0}
      onKeyDown={(e) => {
        sel.handleGridKeyDown(e);
        props.onKeyDown?.(e);
      }}
    >
      <div className="grid-header-row">
        <div className="grid-corner" style={{ width: gutterWidth }} />
        <div className="grid-header-viewport">
          <div ref={headerInnerRef} className="grid-header-inner" style={{ width: totalWidth, height: HEADER_HEIGHT }}>
            {colVirtualizer.getVirtualItems().map((vc) => {
              const col = columns[vc.index];
              const sorted = sort?.column === vc.index;
              const style: CSSProperties = { position: "absolute", left: vc.start, top: 0, width: vc.size, height: HEADER_HEIGHT };
              return (
                <div
                  key={vc.key}
                  className={`grid-header-cell ${onSort ? "sortable" : ""}`}
                  style={style}
                  onClick={() => onSort?.(vc.index)}
                >
                  <div className="grid-header-name">
                    <span>{col.name}</span>
                    {sorted && <span className="sort-indicator">{sort!.dir === "asc" ? "▲" : "▼"}</span>}
                  </div>
                  <div className="grid-header-type muted">{col.typeName.toLowerCase()}</div>
                  <div className="grid-col-resize" onMouseDown={(e) => handleResizeMouseDown(e, vc.index)} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid-body-row">
        <div className="grid-gutter-viewport" style={{ width: gutterWidth }}>
          <div ref={gutterInnerRef} className="grid-gutter-inner" style={{ height: totalHeight }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const rowExtra = cellClass?.(vr.index, 0) ?? "";
              const alt = vr.index % 2 === 1 ? "row-alt" : "";
              return (
                <div
                  key={vr.key}
                  className={`grid-row-number ${alt} ${rowExtra.includes("cell-deleted") ? "cell-deleted" : ""}`}
                  style={{ position: "absolute", top: vr.start, left: 0, width: gutterWidth, height: vr.size }}
                >
                  {vr.index + 1}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid-scroll" ref={scrollRef} onScroll={handleScroll}>
          {rows.length === 0 ? (
            <div className="grid-empty muted">Нет строк</div>
          ) : (
            <div className="grid-scroll-inner" style={{ width: totalWidth, height: totalHeight }}>
              {rowVirtualizer.getVirtualItems().flatMap((vr) =>
                colVirtualizer.getVirtualItems().map((vc) => {
                  const r = vr.index;
                  const c = vc.index;
                  const alt = r % 2 === 1 ? "row-alt" : "";
                  const extra = [alt, cellClass?.(r, c) ?? ""].filter(Boolean).join(" ");
                  const editingHere = sel.editingCell?.row === r && sel.editingCell?.col === c;
                  const style: CSSProperties = { position: "absolute", top: vr.start, left: vc.start, width: vc.size, height: vr.size };
                  return (
                    <GridCell
                      key={`${vr.key}:${vc.key}`}
                      value={getValue(r, c)}
                      meta={columns[c]}
                      editable={!!editable}
                      editing={editingHere}
                      editingInitialValue={sel.editingInitialValue}
                      focused={sel.isFocused(r, c)}
                      inRange={sel.isInRange(r, c)}
                      extraClassName={extra}
                      style={style}
                      onMouseDown={(e) => sel.handleCellMouseDown(r, c, e)}
                      onMouseEnter={() => sel.handleCellMouseEnter(r, c)}
                      onDoubleClick={() => sel.handleCellDoubleClick(r, c)}
                      onCommit={(v, advance) => sel.commitEdit(v, advance)}
                      onCancel={sel.cancelEdit}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, row: r, col: c });
                      }}
                    />
                  );
                }),
              )}
            </div>
          )}
        </div>
      </div>

      {contextMenu && editable && !columns[contextMenu.col]?.binary && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div
            className="item"
            onClick={() => {
              onEditCell?.(contextMenu.row, contextMenu.col, null);
              setContextMenu(null);
            }}
          >
            Установить NULL
          </div>
        </div>
      )}
    </div>
  );
}
