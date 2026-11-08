import type { CSSProperties, MouseEvent } from "react";
import { memo } from "react";
import type { CellValue, ColumnMeta } from "../../api/types";
import { formatCell, isNumericType } from "../../lib/format";
import { CellEditor, type EditAdvance } from "./CellEditor";

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
  onCommit: (value: CellValue, advance: EditAdvance) => void;
  onCancel: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

function isNumeric(meta: ColumnMeta): boolean {
  return isNumericType(meta.typeName);
}

function GridCellImpl(props: GridCellProps) {
  if (props.editing) {
    return (
      <CellEditor
        meta={props.meta}
        initialValue={props.editingInitialValue}
        style={props.style}
        onCommit={props.onCommit}
        onCancel={props.onCancel}
      />
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
