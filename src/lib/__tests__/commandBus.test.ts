import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchCommand, registerCommand, resetCommandBus } from "../commandBus";

describe("commandBus", () => {
  beforeEach(() => resetCommandBus());

  it("returns false when nothing is registered", () => {
    expect(dispatchCommand("refresh", "mac")).toBe(false);
  });

  it("calls the most recently registered handler first", () => {
    const calls: string[] = [];
    registerCommand("refresh", () => void calls.push("explorer"));
    registerCommand("refresh", () => void calls.push("table"));
    expect(dispatchCommand("refresh", "mac")).toBe(true);
    expect(calls).toEqual(["table"]);
  });

  it("falls through when a handler declines", () => {
    const calls: string[] = [];
    registerCommand("refresh", () => void calls.push("explorer"));
    registerCommand("refresh", () => {
      calls.push("table");
      return false;
    });
    expect(dispatchCommand("refresh", "mac")).toBe(true);
    expect(calls).toEqual(["table", "explorer"]);
  });

  it("unregisters handlers", () => {
    const handler = vi.fn();
    const off = registerCommand("closeTab", handler);
    off();
    expect(dispatchCommand("closeTab", "mac")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("tries actions that share the same shortcut", () => {
    const submit = vi.fn();
    registerCommand("submitChanges", submit);
    expect(dispatchCommand("executeStatement", "mac")).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not cross over to actions with different shortcuts", () => {
    const submit = vi.fn();
    registerCommand("submitChanges", submit);
    expect(dispatchCommand("refresh", "mac")).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
