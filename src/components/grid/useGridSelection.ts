import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { CellValue } from "../../api/types";

export interface GridCellPos {
  row: number;
  col: number;
}

export interface GridRange {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

interface Selection {
  anchor: GridCellPos;
  focus: GridCellPos;
}

export interface UseGridSelectionOptions {
  rowCount: number;
  colCount: number;
  editable: boolean;
  selectedCell?: GridCellPos | null;
  onSelectCell?: (cell: GridCellPos | null) => void;
  onEditCell?: (row: number, col: number, value: CellValue) => void;
  getCellValue: (row: number, col: number) => CellValue;
  isCellEditable?: (row: number, col: number) => boolean;
  onCopy?: (range: GridRange) => void;
  onSetNull?: (range: GridRange) => void;
  pageSize?: number;
}

function rangeOf(sel: Selection): GridRange {
  return {
    minRow: Math.min(sel.anchor.row, sel.focus.row),
    maxRow: Math.max(sel.anchor.row, sel.focus.row),
    minCol: Math.min(sel.anchor.col, sel.focus.col),
    maxCol: Math.max(sel.anchor.col, sel.focus.col),
  };
}

/** Выделение ячеек грида (одна ячейка / прямоугольный диапазон), навигация с клавиатуры, редактирование. */
export function useGridSelection(opts: UseGridSelectionOptions) {
  const { rowCount, colCount, editable, onSelectCell, onEditCell, getCellValue, isCellEditable, onCopy, onSetNull } = opts;
  const pageSize = opts.pageSize ?? 20;

  const [selection, setSelectionState] = useState<Selection | null>(
    opts.selectedCell ? { anchor: opts.selectedCell, focus: opts.selectedCell } : null,
  );
  const [editingCell, setEditingCell] = useState<GridCellPos | null>(null);
  const [editingInitialValue, setEditingInitialValue] = useState("");
  const draggingRef = useRef(false);

  useEffect(() => {
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // Внешнее управление выбранной ячейкой (например, после вставки новой строки).
  useEffect(() => {
    const cell = opts.selectedCell;
    if (!cell) return;
    setSelectionState((sel) => {
      if (sel && sel.anchor.row === cell.row && sel.anchor.col === cell.col && sel.focus.row === cell.row && sel.focus.col === cell.col) {
        return sel;
      }
      return { anchor: cell, focus: cell };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.selectedCell?.row, opts.selectedCell?.col]);

  const setSelection = useCallback(
    (sel: Selection | null) => {
      setSelectionState(sel);
      onSelectCell?.(sel ? sel.focus : null);
    },
    [onSelectCell],
  );

  const canEdit = useCallback(
    (row: number, col: number) => editable && (!isCellEditable || isCellEditable(row, col)),
    [editable, isCellEditable],
  );

  const startEdit = useCallback(
    (row: number, col: number, initial?: string) => {
      if (!canEdit(row, col)) return;
      setEditingCell({ row, col });
      setEditingInitialValue(initial ?? formatForEdit(getCellValue(row, col)));
    },
    [canEdit, getCellValue],
  );

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  const commitEdit = useCallback(
    (value: CellValue, advance: "down" | "right" | "left" | "none" = "none") => {
      if (editingCell) {
        onEditCell?.(editingCell.row, editingCell.col, value);
      }
      const from = editingCell;
      setEditingCell(null);
      if (!from) return;
      if (advance === "down") {
        const row = Math.min(rowCount - 1, from.row + 1);
        setSelection({ anchor: { row, col: from.col }, focus: { row, col: from.col } });
      } else if (advance === "right" || advance === "left") {
        let { row, col } = from;
        if (advance === "right") {
          col += 1;
          if (col >= colCount) {
            col = 0;
            row = Math.min(rowCount - 1, row + 1);
          }
        } else {
          col -= 1;
          if (col < 0) {
            col = Math.max(0, colCount - 1);
            row = Math.max(0, row - 1);
          }
        }
        setSelection({ anchor: { row, col }, focus: { row, col } });
      }
    },
    [editingCell, onEditCell, rowCount, colCount, setSelection],
  );

  const handleCellMouseDown = useCallback(
    (row: number, col: number, e: MouseEvent) => {
      draggingRef.current = true;
      setSelectionState((sel) => {
        const next: Selection = e.shiftKey && sel ? { anchor: sel.anchor, focus: { row, col } } : { anchor: { row, col }, focus: { row, col } };
        onSelectCell?.(next.focus);
        return next;
      });
    },
    [onSelectCell],
  );

  const handleCellMouseEnter = useCallback(
    (row: number, col: number) => {
      if (!draggingRef.current) return;
      setSelectionState((sel) => {
        const next: Selection = sel ? { anchor: sel.anchor, focus: { row, col } } : { anchor: { row, col }, focus: { row, col } };
        onSelectCell?.(next.focus);
        return next;
      });
    },
    [onSelectCell],
  );

  const handleCellDoubleClick = useCallback(
    (row: number, col: number) => {
      startEdit(row, col);
    },
    [startEdit],
  );

  const handleGridKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (editingCell) return; // редактируемый input обрабатывает свои клавиши сам

      const mod = e.metaKey || e.ctrlKey;
      const sel = selection ?? { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
      let { row, col } = sel.focus;

      if (mod && !e.shiftKey && e.altKey && (e.key === "n" || e.key === "N")) {
        if (editable) onSetNull?.(rangeOf(sel));
        e.preventDefault();
        return;
      }
      if (mod && (e.key === "c" || e.key === "C")) {
        onCopy?.(rangeOf(sel));
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case "ArrowUp":
          row = Math.max(0, row - 1);
          break;
        case "ArrowDown":
          row = Math.min(rowCount - 1, row + 1);
          break;
        case "ArrowLeft":
          col = Math.max(0, col - 1);
          break;
        case "ArrowRight":
          col = Math.min(colCount - 1, col + 1);
          break;
        case "Home":
          col = 0;
          break;
        case "End":
          col = Math.max(0, colCount - 1);
          break;
        case "PageUp":
          row = Math.max(0, row - pageSize);
          break;
        case "PageDown":
          row = Math.min(rowCount - 1, row + pageSize);
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) {
            col -= 1;
            if (col < 0) {
              col = Math.max(0, colCount - 1);
              row = Math.max(0, row - 1);
            }
          } else {
            col += 1;
            if (col >= colCount) {
              col = 0;
              row = Math.min(rowCount - 1, row + 1);
            }
          }
          break;
        case "Enter":
          if (canEdit(row, col)) startEdit(row, col);
          return;
        default:
          if (editable && e.key.length === 1 && !mod && !e.altKey) {
            startEdit(row, col, e.key);
            return;
          }
          return;
      }
      e.preventDefault();
      const focus = { row, col };
      setSelection({ anchor: e.shiftKey ? sel.anchor : focus, focus });
    },
    [editingCell, selection, rowCount, colCount, pageSize, editable, canEdit, startEdit, onCopy, onSetNull, setSelection],
  );

  const range = selection ? rangeOf(selection) : null;

  const isFocused = useCallback((row: number, col: number) => !!selection && selection.focus.row === row && selection.focus.col === col, [selection]);
  const isInRange = useCallback(
    (row: number, col: number) => !!range && row >= range.minRow && row <= range.maxRow && col >= range.minCol && col <= range.maxCol,
    [range],
  );

  return {
    selection,
    range,
    editingCell,
    editingInitialValue,
    isFocused,
    isInRange,
    handleCellMouseDown,
    handleCellMouseEnter,
    handleCellDoubleClick,
    handleGridKeyDown,
    startEdit,
    commitEdit,
    cancelEdit,
  };
}

function formatForEdit(v: CellValue): string {
  if (v === null) return "";
  return String(v);
}
