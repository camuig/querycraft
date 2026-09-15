import { useVirtualizer } from "@tanstack/react-virtual";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CellValue, ColumnMeta } from "../../api/types";
import { type CopyFormat, formatCell, rowsToClipboardText } from "../../lib/format";
import { expandToRange, parseClipboardTable } from "../../lib/pasteParser";
import { toast } from "../../store/toastStore";
import { PopupMenu } from "../common/PopupMenu";
import { GridCell } from "./GridCell";
import { type GridCellPos, type GridRange, useGridSelection } from "./useGridSelection";
import "../../styles/grid.css";

export type { GridCellPos, GridRange } from "./useGridSelection";

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 36;
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 2000;
/** Upper bound for the automatically measured width; wider columns can still be resized by hand. */
const MAX_AUTO_COLUMN_WIDTH = 400;
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
  /**
   * Paste from clipboard (⌘/Ctrl+V) starting at cell (row, col): values is a matrix of rows × columns.
   * If not provided, paste is unavailable.
   */
  onPaste?: (row: number, col: number, values: CellValue[][]) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

async function readClipboardText(): Promise<string> {
  try {
    return await readText();
  } catch {
    return (await navigator.clipboard?.readText()) ?? "";
  }
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
    return clamp(Math.ceil(max) + 26, 60, MAX_AUTO_COLUMN_WIDTH);
  });
}

/** Virtualized grid (rows and columns) with selection, editing, and copying. */
export function DataGrid(props: DataGridProps) {
  const {
    columns,
    rows,
    getCellValue,
    cellClass,
    sort,
    onSort,
    selectedCell,
    onSelectCell,
    editable,
    onEditCell,
    onPaste,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerInnerRef = useRef<HTMLDivElement | null>(null);
  const gutterInnerRef = useRef<HTMLDivElement | null>(null);

  const [widths, setWidths] = useState<number[] | null>(null);
  const hasRows = rows.length > 0;
  useEffect(() => {
    setWidths(computeColumnWidths(columns, rows));
    // Widths are measured when the column set changes (new query / table) and once more when the
    // first rows arrive, since the data tab may render the new columns before its rows are ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, hasRows]);

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

  const copyRange = useCallback(
    (range: GridRange, format: CopyFormat, withHeaders: boolean) => {
      const cols = columns.slice(range.minCol, range.maxCol + 1);
      const data: CellValue[][] = [];
      for (let r = range.minRow; r <= range.maxRow; r++) {
        const line: CellValue[] = [];
        for (let c = range.minCol; c <= range.maxCol; c++) line.push(getValue(r, c));
        data.push(line);
      }
      const text = rowsToClipboardText(cols, data, format, withHeaders);
      writeText(text).catch(() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
      });
      const n = data.length * cols.length;
      toast.info(n === 1 ? "Copied" : `Copied cells: ${n}`);
    },
    [getValue, columns],
  );

  const handleCopyRange = useCallback((range: GridRange) => copyRange(range, "tsv", false), [copyRange]);

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

  // The virtualizer caches item sizes and does not re-read `estimateSize` on its own,
  // so after a manual resize (or a fresh auto-measure) the cache must be dropped explicitly.
  useEffect(() => {
    colVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widths]);

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
        const nextWidth = clamp(st.startWidth + (ev.clientX - st.startX), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
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

  const pasteInFlight = useRef(false);
  const handlePasteText = useCallback(
    (text: string) => {
      if (!onPaste || !editable) return;
      const parsed = parseClipboardTable(text);
      if (parsed.length === 0) return;
      const range = sel.range;
      const start = range ? { row: range.minRow, col: range.minCol } : { row: rows.length, col: 0 };
      // Multiple cells selected — the value at (row, col) is replicated across the whole range, like in DataGrip.
      const values = range
        ? expandToRange(parsed, range.maxRow - range.minRow + 1, range.maxCol - range.minCol + 1)
        : parsed;
      onPaste(start.row, start.col, values);
    },
    [onPaste, editable, sel.range, rows.length],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "v" || e.key === "V") && editable && onPaste && !sel.editingCell) {
      e.preventDefault();
      if (pasteInFlight.current) return;
      pasteInFlight.current = true;
      readClipboardText()
        .then(handlePasteText)
        .catch((err) => toast.error(err))
        .finally(() => {
          pasteInFlight.current = false;
        });
      return;
    }
    sel.handleGridKeyDown(e);
    props.onKeyDown?.(e);
  };

  return (
    <div
      className="data-grid"
      tabIndex={0}
      onMouseDown={(e) => {
        // Prevent the browser from starting native text selection while dragging across cells;
        // we move focus to the grid manually (preventDefault also cancels that).
        if (e.target instanceof HTMLInputElement || e.target === scrollRef.current) return;
        e.preventDefault();
        if (document.activeElement !== e.currentTarget) e.currentTarget.focus();
      }}
      onKeyDown={handleKeyDown}
      onPaste={(e) => {
        // Fallback path: the system's paste event (when reading the clipboard via the API is unavailable).
        if (pasteInFlight.current || sel.editingCell || !editable || !onPaste) return;
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        handlePasteText(text);
      }}
    >
      <div className="grid-header-row">
        <div className="grid-corner" style={{ width: gutterWidth }} />
        <div className="grid-header-viewport">
          <div ref={headerInnerRef} className="grid-header-inner" style={{ width: totalWidth, height: HEADER_HEIGHT }}>
            {colVirtualizer.getVirtualItems().map((vc) => {
              const col = columns[vc.index];
              const sorted = sort?.column === vc.index;
              const colSelected = !!sel.range && vc.index >= sel.range.minCol && vc.index <= sel.range.maxCol;
              const style: CSSProperties = {
                position: "absolute",
                left: vc.start,
                top: 0,
                width: vc.size,
                height: HEADER_HEIGHT,
              };
              return (
                <div
                  key={vc.key}
                  className={`grid-header-cell ${onSort ? "sortable" : ""} ${colSelected ? "col-selected" : ""}`}
                  style={style}
                  title="Click to select column, Shift+click for column range"
                  onMouseDown={(e) => sel.handleHeaderMouseDown(vc.index, e)}
                >
                  <div className="grid-header-name">
                    <span>{col.name}</span>
                    {onSort && (
                      <span
                        className={`sort-indicator ${sorted ? "active" : ""}`}
                        title="Sort"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSort(vc.index);
                        }}
                      >
                        {sorted ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    )}
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
              const rowSelected = !!sel.range && vr.index >= sel.range.minRow && vr.index <= sel.range.maxRow;
              return (
                <div
                  key={vr.key}
                  className={`grid-row-number ${alt} ${rowExtra.includes("cell-deleted") ? "cell-deleted" : ""} ${rowSelected ? "row-selected" : ""}`}
                  style={{ position: "absolute", top: vr.start, left: 0, width: gutterWidth, height: vr.size }}
                  onMouseDown={(e) => sel.handleRowNumberMouseDown(vr.index, e)}
                  onMouseEnter={() => sel.handleRowNumberMouseEnter(vr.index)}
                >
                  {vr.index + 1}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid-scroll" ref={scrollRef} onScroll={handleScroll}>
          {rows.length === 0 ? (
            <div className="grid-empty muted">No rows</div>
          ) : (
            <div className="grid-scroll-inner" style={{ width: totalWidth, height: totalHeight }}>
              {rowVirtualizer.getVirtualItems().flatMap((vr) =>
                colVirtualizer.getVirtualItems().map((vc) => {
                  const r = vr.index;
                  const c = vc.index;
                  const alt = r % 2 === 1 ? "row-alt" : "";
                  const extra = [alt, cellClass?.(r, c) ?? ""].filter(Boolean).join(" ");
                  const editingHere = sel.editingCell?.row === r && sel.editingCell?.col === c;
                  const style: CSSProperties = {
                    position: "absolute",
                    top: vr.start,
                    left: vc.start,
                    width: vc.size,
                    height: vr.size,
                  };
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
                        if (!sel.isInRange(r, c))
                          sel.setSelection({ anchor: { row: r, col: c }, focus: { row: r, col: c } });
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

      {contextMenu && (
        <PopupMenu x={contextMenu.x} y={contextMenu.y}>
          {(() => {
            const range = sel.range ?? {
              minRow: contextMenu.row,
              maxRow: contextMenu.row,
              minCol: contextMenu.col,
              maxCol: contextMenu.col,
            };
            const item = (label: string, action: () => void, disabled = false) => (
              <div
                className={`item ${disabled ? "disabled" : ""}`}
                onClick={() => {
                  setContextMenu(null);
                  action();
                }}
              >
                {label}
              </div>
            );
            return (
              <>
                {item("Copy", () => copyRange(range, "tsv", false))}
                {item("Copy as CSV", () => copyRange(range, "csv", false))}
                {item("Copy with headers (TSV)", () => copyRange(range, "tsv", true))}
                {item("Copy with headers (CSV)", () => copyRange(range, "csv", true))}
                {editable && (
                  <>
                    <div className="divider" />
                    {onPaste &&
                      item("Paste", () =>
                        readClipboardText()
                          .then(handlePasteText)
                          .catch((err) => toast.error(err)),
                      )}
                    {item("Set NULL", () => handleSetNullRange(range))}
                  </>
                )}
                <div className="divider" />
                {item("Select all", () => sel.selectAll())}
              </>
            );
          })()}
        </PopupMenu>
      )}
    </div>
  );
}
