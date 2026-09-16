import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { memo, useEffect, useRef } from "react";
import type { CellValue, ColumnMeta } from "../../api/types";
import { formatCell, isNumericType } from "../../lib/format";
import { NO_AUTOCORRECT } from "../../lib/inputProps";

export interface GridCellProps {
  value: CellValue;
  meta: ColumnMeta;
  editable: boolean;
  editing: boolean;
  editingInitialValue: string;
  focused: boolean;
  inRange: boolean;
  extraClassName?: string;
  style: CSSProperties;
  onMouseDown: (e: MouseEvent) => void;
  onMouseEnter: () => void;
  onDoubleClick: () => void;
  onCommit: (value: CellValue, advance: "down" | "right" | "left" | "none") => void;
  onCancel: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

function isNumeric(meta: ColumnMeta): boolean {
  return isNumericType(meta.typeName);
}

function GridCellImpl(props: GridCellProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (props.editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [props.editing]);

  if (props.editing) {
    return (
      <div className="grid-cell grid-cell-editing" style={props.style}>
        <input
          ref={inputRef}
          className="grid-cell-input"
          {...NO_AUTOCORRECT}
          defaultValue={props.editingInitialValue}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              props.onCommit(inputRef.current?.value ?? "", "down");
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onCancel();
            } else if (e.key === "Tab") {
              e.preventDefault();
              props.onCommit(inputRef.current?.value ?? "", e.shiftKey ? "left" : "right");
            }
          }}
          onBlur={() => props.onCommit(inputRef.current?.value ?? "", "none")}
        />
      </div>
    );
  }

  const isNull = props.value === null;
  const className = [
    "grid-cell",
    isNumeric(props.meta) ? "cell-number" : "",
    isNull ? "cell-null" : "",
    props.focused ? "cell-focused" : "",
    !props.focused && props.inRange ? "cell-range" : "",
    props.extraClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      style={props.style}
      onMouseDown={props.onMouseDown}
      onMouseEnter={props.onMouseEnter}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      title={isNull ? undefined : formatCell(props.value, props.meta)}
    >
      {isNull ? "<null>" : formatCell(props.value, props.meta)}
    </div>
  );
}

export const GridCell = memo(GridCellImpl);
