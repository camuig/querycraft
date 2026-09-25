import { useMemo, useState } from "react";
import { countQuery } from "../../api/commands";
import type { CellValue, DbKind, StatementResult } from "../../api/types";
import { newId } from "../../lib/ids";
import { toast } from "../../store/toastStore";
import { DataGrid } from "./DataGrid";
import { ExportMenu, type FullResultSource } from "./ExportMenu";

interface SortState {
  column: number;
  dir: "asc" | "desc";
}

/** Outcome of the on-demand COUNT(*) behind a truncated result. */
type CountState = { kind: "counting" } | { kind: "done"; total: number };

/** Counts keyed by result index; they belong to one `results` array and are dropped with it. */
interface Counts {
  results: StatementResult[];
  byIndex: Record<number, CountState>;
}

export interface ResultsPanelProps {
  results: StatementResult[];
  kind: DbKind;
  /** Called when clicking "More" on a truncated result — the caller re-runs with a higher limit. */
  onLoadMore?: (index: number) => void;
  /** Shows a "Fix with AI" button above an error result; omitted when the AI assistant is unavailable. */
  onFixError?: (index: number) => void;
  /**
   * Session the results came from; lets file exports of truncated results fetch every row and
   * makes the "N+ rows" count clickable (runs SELECT COUNT(*) over the statement, like DataGrip).
   */
  session?: Omit<FullResultSource, "sql">;
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
  const { results, kind, onLoadMore, onFixError, session } = props;
  const [activeIndex, setActiveIndex] = useState(0);
  const [sortByResult, setSortByResult] = useState<Record<number, SortState | null>>({});
  const [counts, setCounts] = useState<Counts>({ results, byIndex: {} });

  const safeIndex = activeIndex < results.length ? activeIndex : 0;
  const active = results[safeIndex] as StatementResult | undefined;
  const sortState = sortByResult[safeIndex] ?? null;
  const count = counts.results === results ? counts.byIndex[safeIndex] : undefined;

  function setCount(index: number, state: CountState | undefined) {
    setCounts((prev) => {
      const byIndex = prev.results === results ? { ...prev.byIndex } : {};
      if (state) byIndex[index] = state;
      else delete byIndex[index];
      return { results, byIndex };
    });
  }

  async function handleCount(index: number) {
    const result = results[index];
    if (!session || !result) return;
    setCount(index, { kind: "counting" });
    try {
      const total = await countQuery({ ...session, sql: result.sql, queryId: newId() });
      setCount(index, { kind: "done", total });
    } catch (e) {
      setCount(index, undefined);
      toast.error(e);
    }
  }

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

      {active.kind === "error" && (
        <div>
          {onFixError && (
            <div className="results-error-actions">
              <button type="button" onClick={() => onFixError(safeIndex)}>
                ✦ Fix with AI
              </button>
            </div>
          )}
          <div className="results-error text-select">{active.error ?? "Unknown error"}</div>
        </div>
      )}

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
              {!active.truncated ? (
                `${active.rows.length} rows`
              ) : count?.kind === "done" ? (
                `${count.total} rows (${active.rows.length} shown)`
              ) : count?.kind === "counting" ? (
                `${active.rows.length}+ rows (counting…)`
              ) : session ? (
                <button
                  type="button"
                  className="link"
                  title="Truncated by the row limit — click to count all rows matching the statement"
                  onClick={() => void handleCount(safeIndex)}
                >
                  {active.rows.length}+ rows
                </button>
              ) : (
                `${active.rows.length}+ rows (truncated by limit)`
              )}
            </span>
            <span className="muted">{active.durationMs} ms</span>
            <div className="spacer" />
            {active.truncated && onLoadMore && (
              <button type="button" className="outline" onClick={() => onLoadMore(safeIndex)}>
                More
              </button>
            )}
            <ExportMenu
              columns={active.columns}
              rows={sortedRows}
              kind={kind}
              fileBaseName={`result_${safeIndex + 1}`}
              fullResult={active.truncated && session ? { ...session, sql: active.sql } : undefined}
            />
          </div>
        </>
      )}
    </div>
  );
}
