import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { getConsoleEditor, registerConsoleEditor } from "../editorRegistry";

/** A fake EditorView is fine here: the registry only ever stores/returns the reference. */
function fakeView(): EditorView {
  return {} as EditorView;
}

describe("editorRegistry", () => {
  it("returns undefined for an unregistered tab", () => {
    expect(getConsoleEditor("nope")).toBeUndefined();
  });

  it("registers and looks up a view by tab id", () => {
    const view = fakeView();
    const off = registerConsoleEditor("tab-1", view);
    expect(getConsoleEditor("tab-1")).toBe(view);
    off();
  });

  it("clears the entry on unregister", () => {
    const view = fakeView();
    const off = registerConsoleEditor("tab-2", view);
    off();
    expect(getConsoleEditor("tab-2")).toBeUndefined();
  });

  it("does not clear a newer view registered under the same tab id", () => {
    const first = fakeView();
    const second = fakeView();
    const offFirst = registerConsoleEditor("tab-3", first);
    registerConsoleEditor("tab-3", second);
    offFirst();
    expect(getConsoleEditor("tab-3")).toBe(second);
  });
});
