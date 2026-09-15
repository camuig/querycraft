import { EditorSelection, type StateCommand } from "@codemirror/state";

/**
 * Duplicate Line or Selection (DataGrip: Cmd/Ctrl+D). With an empty selection the
 * current line is copied below and the cursor keeps its column; otherwise the
 * selected text is inserted right after the selection and stays selected.
 */
export const duplicateLineOrSelection: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      const text = state.lineBreak + line.text;
      return {
        changes: { from: line.to, insert: text },
        range: EditorSelection.cursor(range.head + text.length),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.to, insert: text },
      range: EditorSelection.range(range.to, range.to + text.length),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.duplicate" }));
  return true;
};
