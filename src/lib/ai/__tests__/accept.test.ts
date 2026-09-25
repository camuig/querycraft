import { describe, expect, it } from "vitest";
import { acceptEditSelection, acceptFix, insertAtCursor } from "../accept";

describe("acceptEditSelection", () => {
  it("replaces the remembered range and selects the new text", () => {
    const edit = acceptEditSelection(10, 25, "SELECT 1");
    expect(edit).toEqual({ from: 10, to: 25, insert: "SELECT 1", selectionFrom: 10, selectionTo: 18 });
  });
});

describe("insertAtCursor", () => {
  it("inserts at the cursor without a leading newline on a blank line", () => {
    const doc = "SELECT 1;\n\nSELECT 2;";
    const pos = 10; // the empty line between the two statements
    const edit = insertAtCursor(doc, pos, "SELECT 3;");
    expect(edit).toEqual({ from: 10, to: 10, insert: "SELECT 3;", selectionFrom: 10, selectionTo: 19 });
  });

  it("starts a new line first when the current line has content", () => {
    const doc = "SELECT 1;";
    const pos = doc.length; // end of the (non-blank) line
    const edit = insertAtCursor(doc, pos, "SELECT 2;");
    expect(edit).toEqual({ from: 9, to: 9, insert: "\nSELECT 2;", selectionFrom: 10, selectionTo: 19 });
  });

  it("treats a line of only whitespace as blank", () => {
    const doc = "SELECT 1;\n   \nSELECT 2;";
    const pos = 12; // inside the whitespace-only line
    const edit = insertAtCursor(doc, pos, "X");
    expect(edit.insert).toBe("X");
  });

  it("works at the very start of an empty document", () => {
    const edit = insertAtCursor("", 0, "SELECT 1;");
    expect(edit).toEqual({ from: 0, to: 0, insert: "SELECT 1;", selectionFrom: 0, selectionTo: 9 });
  });
});

describe("acceptFix", () => {
  it("replaces the single matching occurrence", () => {
    const doc = "SELECT * FROM nope;\nSELECT 1;";
    const edit = acceptFix(doc, "SELECT * FROM nope;", 5, "SELECT * FROM users;");
    expect(edit).toEqual({ from: 0, to: 19, insert: "SELECT * FROM users;", selectionFrom: 0, selectionTo: 20 });
  });

  it("picks the occurrence closest to the remembered position when the statement repeats", () => {
    const stmt = "SELECT * FROM nope";
    const doc = `${stmt}\n\n-- unrelated\n${stmt}`;
    const anchorNearSecond = doc.length - 2;
    const edit = acceptFix(doc, stmt, anchorNearSecond, "FIXED");
    expect(edit.from).toBe(doc.lastIndexOf(stmt));
  });

  it("falls back to inserting at the cursor when the statement is no longer in the document", () => {
    const doc = "SELECT 1;";
    const edit = acceptFix(doc, "SELECT * FROM gone;", doc.length, "SELECT * FROM users;");
    expect(edit).toEqual(insertAtCursor(doc, doc.length, "SELECT * FROM users;"));
  });

  it("falls back to inserting at the cursor for a blank original statement", () => {
    const doc = "SELECT 1;";
    const edit = acceptFix(doc, "   ", 3, "SELECT 2;");
    expect(edit).toEqual(insertAtCursor(doc, 3, "SELECT 2;"));
  });

  it("also consumes the document's trailing semicolon when the original statement text has none", () => {
    // ExecuteRequest splits statements on ";", so a failed StatementResult.sql never carries the
    // terminator even though the console document does — the replaced range must still swallow it,
    // or the accepted SQL (which brings its own ";") leaves a stray one behind.
    const doc = "SELECT * FROM nope;";
    const edit = acceptFix(doc, "SELECT * FROM nope", 5, "SELECT * FROM users;");
    expect(edit).toEqual({ from: 0, to: 19, insert: "SELECT * FROM users;", selectionFrom: 0, selectionTo: 20 });
  });
});
