import { describe, expect, it } from "vitest";
import {
  actionsForEvent,
  actionsSharingShortcut,
  detectPlatform,
  formatShortcut,
  type KeyLike,
  shortcutLabel,
} from "../keymap";

function key(code: string, mods: Partial<Omit<KeyLike, "code">> = {}): KeyLike {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("keymap", () => {
  it("matches DataGrip shortcuts on macOS", () => {
    expect(actionsForEvent(key("Enter", { metaKey: true }), "mac")).toEqual(["executeStatement", "submitChanges"]);
    expect(actionsForEvent(key("KeyR", { metaKey: true }), "mac")).toEqual(["refresh"]);
    expect(actionsForEvent(key("KeyN", { metaKey: true, altKey: true }), "mac")).toEqual(["setNull"]);
    expect(actionsForEvent(key("Backspace", { metaKey: true }), "mac")).toEqual(["deleteRow"]);
    expect(actionsForEvent(key("F4"), "mac")).toEqual(["openTableData"]);
    expect(actionsForEvent(key("Comma", { metaKey: true }), "mac")).toEqual(["openSettings"]);
    expect(actionsForEvent(key("Backslash", { metaKey: true }), "mac")).toEqual(["aiGenerate"]);
  });

  it("matches DataGrip shortcuts on Windows/Linux", () => {
    expect(actionsForEvent(key("F5", { ctrlKey: true }), "other")).toEqual(["refresh"]);
    expect(actionsForEvent(key("Insert", { altKey: true }), "other")).toEqual(["addRow"]);
    expect(actionsForEvent(key("KeyY", { ctrlKey: true }), "other")).toEqual(["deleteRow"]);
    expect(actionsForEvent(key("F4", { ctrlKey: true }), "other")).toEqual(["closeTab"]);
    expect(actionsForEvent(key("KeyS", { ctrlKey: true, altKey: true }), "other")).toEqual(["openSettings"]);
    expect(actionsForEvent(key("Backslash", { ctrlKey: true }), "other")).toEqual(["aiGenerate"]);
  });

  it("requires exact modifiers", () => {
    expect(actionsForEvent(key("KeyR", { metaKey: true, shiftKey: true }), "mac")).toEqual([]);
    expect(actionsForEvent(key("KeyR"), "mac")).toEqual([]);
  });

  it("knows which actions share a shortcut", () => {
    expect(actionsSharingShortcut("submitChanges", "mac")).toEqual(["executeStatement", "submitChanges"]);
    expect(actionsSharingShortcut("refresh", "other")).toEqual(["refresh"]);
  });

  it("formats shortcuts per platform", () => {
    expect(shortcutLabel("executeScript", "mac")).toBe("⇧⌘⏎");
    expect(shortcutLabel("executeScript", "other")).toBe("Ctrl+Shift+Enter");
    expect(shortcutLabel("nextTab", "mac")).toBe("⇧⌘]");
    expect(shortcutLabel("nextTab", "other")).toBe("Alt+→");
    expect(shortcutLabel("newConnection", "mac")).toBe("");
    expect(shortcutLabel("aiGenerate", "mac")).toBe("⌘\\");
    expect(shortcutLabel("aiGenerate", "other")).toBe("Ctrl+\\");
    expect(formatShortcut({ code: "KeyQ", ctrl: true, shift: true }, "mac")).toBe("⌃⇧Q");
  });

  it("detects the platform from navigator", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32" })).toBe("other");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" })).toBe("mac");
    expect(detectPlatform({})).toBe("other");
  });
});
