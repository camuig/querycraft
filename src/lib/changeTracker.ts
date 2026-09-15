// Модель отложенных изменений грида таблицы (Submit/Revert, как в DataGrip).
// Иммутабельный класс: каждый мутирующий метод возвращает НОВЫЙ инстанс.

import type { CellValue, ColumnMeta, ParamStatement } from "../api/types";
import { quoteIdent, qualify } from "./sqlBuilder";

interface ClassifiedRows {
  deletes: number[];
  updates: number[];
  inserts: number[];
}

export class ChangeTracker {
  private readonly originalRows: CellValue[][];
  private readonly columns: ColumnMeta[];
  private readonly pkColumns: string[];
  private readonly edited: ReadonlyMap<number, ReadonlyMap<number, CellValue>>;
  private readonly deletedRowIndices: ReadonlySet<number>;
  private readonly insertedRowIndices: ReadonlySet<number>;

  constructor(
    originalRows: CellValue[][],
    columns: ColumnMeta[],
    pkColumns: string[],
    edited?: ReadonlyMap<number, ReadonlyMap<number, CellValue>>,
    deletedRowIndices?: ReadonlySet<number>,
    insertedRowIndices?: ReadonlySet<number>,
  ) {
    this.originalRows = originalRows;
    this.columns = columns;
    this.pkColumns = pkColumns;
    this.edited = edited ?? new Map();
    this.deletedRowIndices = deletedRowIndices ?? new Set();
    this.insertedRowIndices = insertedRowIndices ?? new Set();
  }

  private withChanges(overrides: {
    edited?: ReadonlyMap<number, ReadonlyMap<number, CellValue>>;
    deletedRowIndices?: ReadonlySet<number>;
    insertedRowIndices?: ReadonlySet<number>;
  }): ChangeTracker {
    return new ChangeTracker(
      this.originalRows,
      this.columns,
      this.pkColumns,
      overrides.edited ?? this.edited,
      overrides.deletedRowIndices ?? this.deletedRowIndices,
      overrides.insertedRowIndices ?? this.insertedRowIndices,
    );
  }

  private get totalRowCount(): number {
    return this.originalRows.length + this.insertedRowIndices.size;
  }

  /** Текущее количество строк (включая insert), для удобства рендера. */
  get rows(): CellValue[][] {
    const total = this.totalRowCount;
    const result: CellValue[][] = [];
    for (let r = 0; r < total; r++) {
      const row: CellValue[] = [];
      for (let c = 0; c < this.columns.length; c++) {
        row.push(this.getValue(r, c));
      }
      result.push(row);
    }
    return result;
  }

  /** Отредактированное значение ячейки или исходное (null для новых строк по умолчанию). */
  getValue(rowIndex: number, colIndex: number): CellValue {
    const rowEdits = this.edited.get(rowIndex);
    if (rowEdits && rowEdits.has(colIndex)) return rowEdits.get(colIndex) as CellValue;
    if (this.insertedRowIndices.has(rowIndex)) return null;
    const orig = this.originalRows[rowIndex];
    return orig ? orig[colIndex] : null;
  }

  setCell(rowIndex: number, colIndex: number, value: CellValue): ChangeTracker {
    const newEdited = new Map(this.edited);
    const rowMap = new Map(newEdited.get(rowIndex) ?? []);
    rowMap.set(colIndex, value);
    newEdited.set(rowIndex, rowMap);
    return this.withChanges({ edited: newEdited });
  }

  deleteRow(rowIndex: number): ChangeTracker {
    if (this.deletedRowIndices.has(rowIndex)) return this;
    const s = new Set(this.deletedRowIndices);
    s.add(rowIndex);
    return this.withChanges({ deletedRowIndices: s });
  }

  undeleteRow(rowIndex: number): ChangeTracker {
    if (!this.deletedRowIndices.has(rowIndex)) return this;
    const s = new Set(this.deletedRowIndices);
    s.delete(rowIndex);
    return this.withChanges({ deletedRowIndices: s });
  }

  /** Добавляет новую строку в конец (все ячейки null), помеченную как inserted. */
  insertRow(): { tracker: ChangeTracker; rowIndex: number } {
    const rowIndex = this.totalRowCount;
    const s = new Set(this.insertedRowIndices);
    s.add(rowIndex);
    const tracker = this.withChanges({ insertedRowIndices: s });
    return { tracker, rowIndex };
  }

  revertAll(): ChangeTracker {
    return new ChangeTracker(this.originalRows, this.columns, this.pkColumns);
  }

  revertCell(rowIndex: number, colIndex: number): ChangeTracker {
    const rowMap = this.edited.get(rowIndex);
    if (!rowMap || !rowMap.has(colIndex)) return this;
    const newRowMap = new Map(rowMap);
    newRowMap.delete(colIndex);
    const newEdited = new Map(this.edited);
    if (newRowMap.size === 0) newEdited.delete(rowIndex);
    else newEdited.set(rowIndex, newRowMap);
    return this.withChanges({ edited: newEdited });
  }

  isModified(rowIndex: number, colIndex: number): boolean {
    const rowMap = this.edited.get(rowIndex);
    if (!rowMap || !rowMap.has(colIndex)) return false;
    const base = this.insertedRowIndices.has(rowIndex)
      ? null
      : (this.originalRows[rowIndex]?.[colIndex] ?? null);
    return base !== (rowMap.get(colIndex) as CellValue);
  }

  isDeleted(rowIndex: number): boolean {
    return this.deletedRowIndices.has(rowIndex);
  }

  isInserted(rowIndex: number): boolean {
    return this.insertedRowIndices.has(rowIndex);
  }

  get hasChanges(): boolean {
    const { deletes, updates, inserts } = this.classifyRows();
    return deletes.length > 0 || updates.length > 0 || inserts.length > 0;
  }

  /** Раскладывает все строки по действиям: delete/update/insert. Insert+delete строки исключаются. */
  private classifyRows(): ClassifiedRows {
    const deletes: number[] = [];
    const updates: number[] = [];
    const inserts: number[] = [];
    const total = this.totalRowCount;

    for (let r = 0; r < total; r++) {
      const inserted = this.insertedRowIndices.has(r);
      const deleted = this.deletedRowIndices.has(r);

      if (inserted && deleted) continue; // отменяют друг друга — ни в один statement не попадает
      if (deleted) {
        deletes.push(r);
        continue;
      }
      if (inserted) {
        inserts.push(r);
        continue;
      }

      const rowMap = this.edited.get(r);
      if (rowMap) {
        let changed = false;
        for (let c = 0; c < this.columns.length; c++) {
          if (this.isModified(r, c)) {
            changed = true;
            break;
          }
        }
        if (changed) updates.push(r);
      }
    }

    return { deletes, updates, inserts };
  }

  /** Строит параметризованные SQL: DELETE -> UPDATE -> INSERT. */
  buildStatements(database: string | null, table: string): ParamStatement[] {
    const { deletes, updates, inserts } = this.classifyRows();
    const target = qualify(database, table);

    if ((deletes.length > 0 || updates.length > 0) && this.pkColumns.length === 0) {
      throw new Error(
        "Cannot build UPDATE/DELETE: primary key columns are not set (pkColumns)",
      );
    }

    const pkColIndices = this.pkColumns.map((pkName) => {
      const idx = this.columns.findIndex((c) => c.name === pkName);
      if (idx === -1) {
        throw new Error(`PK column "${pkName}" not found among columns`);
      }
      return idx;
    });

    const buildWhere = (rowIndex: number): { clause: string; params: CellValue[] } => {
      const parts: string[] = [];
      const params: CellValue[] = [];
      for (let i = 0; i < this.pkColumns.length; i++) {
        const colIdx = pkColIndices[i];
        const origVal = this.originalRows[rowIndex]?.[colIdx] ?? null;
        const ident = quoteIdent(this.pkColumns[i]);
        if (origVal === null) {
          parts.push(`${ident}IS NULL`);
        } else {
          parts.push(`${ident}=?`);
          params.push(origVal);
        }
      }
      return { clause: parts.join(" AND "), params };
    };

    const statements: ParamStatement[] = [];

    for (const rowIndex of deletes) {
      const { clause, params } = buildWhere(rowIndex);
      statements.push({ sql: `DELETE FROM ${target} WHERE ${clause}`, params });
    }

    for (const rowIndex of updates) {
      const setParts: string[] = [];
      const setParams: CellValue[] = [];
      for (let c = 0; c < this.columns.length; c++) {
        if (this.isModified(rowIndex, c)) {
          setParts.push(`${quoteIdent(this.columns[c].name)}=?`);
          setParams.push(this.getValue(rowIndex, c));
        }
      }
      const { clause, params: whereParams } = buildWhere(rowIndex);
      statements.push({
        sql: `UPDATE ${target} SET ${setParts.join(", ")} WHERE ${clause}`,
        params: [...setParams, ...whereParams],
      });
    }

    for (const rowIndex of inserts) {
      const colNames: string[] = [];
      const values: CellValue[] = [];
      for (let c = 0; c < this.columns.length; c++) {
        const v = this.getValue(rowIndex, c);
        if (v !== null) {
          colNames.push(quoteIdent(this.columns[c].name));
          values.push(v);
        }
      }
      const placeholders = values.map(() => "?").join(", ");
      statements.push({
        sql: `INSERT INTO ${target} (${colNames.join(", ")}) VALUES (${placeholders})`,
        params: values,
      });
    }

    return statements;
  }
}
