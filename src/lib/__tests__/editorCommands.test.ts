import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { duplicateLineOrSelection } from "../../components/editor/editorCommands";

function run(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  duplicateLineOrSelection({ state, dispatch: (tr) => (state = tr.state) });
  return { doc: state.doc.toString(), sel: state.selection.main };
}

describe("duplicateLineOrSelection", () => {
  it("duplicates the current line below and keeps the column", () => {
    const { doc, sel } = run("SELECT 1;\nSELECT 2;", 3);
    expect(doc).toBe("SELECT 1;\nSELECT 1;\nSELECT 2;");
    expect(sel.head).toBe(13);
  });

  it("duplicates the last line without a trailing newline problem", () => {
    const { doc } = run("a\nb", 3);
    expect(doc).toBe("a\nb\nb");
  });

  it("duplicates the selection right after itself and selects the copy", () => {
    const { doc, sel } = run("SELECT id FROM t", 7, 9);
    expect(doc).toBe("SELECT idid FROM t");
    expect([sel.from, sel.to]).toEqual([9, 11]);
  });
});
