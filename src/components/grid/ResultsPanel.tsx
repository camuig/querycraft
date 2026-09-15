import { useMemo, useState } from "react";
import type { CellValue, StatementResult } from "../../api/types";
import { DataGrid } from "./DataGrid";
import { ExportMenu } from "./ExportMenu";

interface SortState {
  column: number;
  dir: "asc" | "desc";
}

export interface ResultsPanelProps {
  results: StatementResult[];
  /** Called when clicking "More" on a truncated result — the caller re-runs with a higher limit. */
  onLoadMore?: (index: number) => void;
}

/** null always first, numbers compared numerically, everything else via localeCompare. */
function compareCell(a: CellValue, b: CellValue, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  let cmp: number;
  if (typeof a === "number" && typeof b === "number") cmp = a - b;
  else if (typeof a === "boolean" && typeof b === "boolean") cmp = Number(a) - Number(b);
  else cmp = String(a).localeCompare(String(b));
  return cmp * dir;
}

function titleFor(r: StatementResult, i: number): string {
  if (r.kind === "error") return "Error";
  if (r.kind === "affected") return `Changed: ${r.affectedRows} rows`;
  return `Result ${i + 1}`;
}

/** List of execution results (tabs, if there are several) with a grid, sorting, and export. */
export function ResultsPanel(props: ResultsPanelProps) {
  const { results, onLoadMore } = props;
  const [activeIndex, setActiveIndex] = useState(0);
  const [sortByResult, setSortByResult] = useState<Record<number, SortState | null>>({});

  const safeIndex = activeIndex < results.length ? activeIndex : 0;
  const active = results[safeIndex] as StatementResult | undefined;
  const sortState = sortByResult[safeIndex] ?? null;

  const order = useMemo(() => {
    if (active?.kind !== "rows" || !sortState) return null;
    const dir = sortState.dir === "asc" ? 1 : -1;
    const idx = active.rows.map((_, i) => i);
    idx.sort((a, b) => compareCell(active.rows[a][sortState.column], active.rows[b][sortState.column], dir));
    return idx;
  }, [active, sortState]);

  if (!active) {
    return (
      <div className="results-panel">
        <div className="results-affected muted">No results</div>
      </div>
    );
  }

  function handleSort(col: number) {
    setSortByResult((prev) => {
      const cur = prev[safeIndex];
      let next: SortState | null;
      if (!cur || cur.column !== col) next = { column: col, dir: "asc" };
      else if (cur.dir === "asc") next = { column: col, dir: "desc" };
      else next = null;
      return { ...prev, [safeIndex]: next };
    });
  }

  const sortedRows = active.kind === "rows" ? (order ? order.map((i) => active.rows[i]) : active.rows) : [];

  return (
    <div className="results-panel">
      {results.length > 1 && (
        <div className="results-tabs">
          {results.map((r, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: result tabs are positional
              key={i}
              className={`results-tab ${i === safeIndex ? "active" : ""} ${r.kind === "error" ? "error" : ""}`}
              onClick={() => setActiveIndex(i)}
            >
              {titleFor(r, i)}
            </div>
          ))}
        </div>
      )}

      {active.kind === "error" && <div className="results-error text-select">{active.error ?? "Unknown error"}</div>}

      {active.kind === "affected" && (
        <div className="results-affected">
          <span>Affected rows: {active.affectedRows}</span>
          {active.lastInsertId !== null && <span className="muted">last insert id: {active.lastInsertId}</span>}
          <span className="muted">{active.durationMs} ms</span>
        </div>
      )}

      {active.kind === "rows" && (
        <>
          <div className="results-body">
            <DataGrid columns={active.columns} rows={sortedRows} sort={sortState} onSort={handleSort} />
          </div>
          <div className="results-footer">
            <span>
              {active.rows.length} rows{active.truncated ? " (truncated by limit)" : ""}
            </span>
            <span className="muted">{active.durationMs} ms</span>
            <div className="spacer" />
            {active.truncated && onLoadMore && (
              <button type="button" className="outline" onClick={() => onLoadMore(safeIndex)}>
                More
              </button>
            )}
            <ExportMenu columns={active.columns} rows={sortedRows} fileBaseName={`result_${safeIndex + 1}`} />
          </div>
        </>
      )}
    </div>
  );
}
