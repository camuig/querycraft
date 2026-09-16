import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  updaterAvailable: true,
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(async () => "0.2.0"),
  updateMode: vi.fn(async () => "install"),
  relaunch: vi.fn(async () => undefined),
  openReleasePage: vi.fn(async () => undefined),
}));
vi.mock("../../api/updater", () => api);

import { useToastStore } from "../toastStore";
import { describeStatus, useUpdateStore } from "../updateStore";

function fakeUpdate(version = "0.3.0") {
  return {
    version,
    notes: "",
    download: vi.fn(async (onProgress: (d: number, t: number | null) => void) => {
      onProgress(50, 100);
      onProgress(100, 100);
    }),
    install: vi.fn(async () => undefined),
  };
}

describe("updateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.updateMode.mockResolvedValue("install");
    api.updaterAvailable = true;
    useUpdateStore.setState({ status: { kind: "idle" } });
    useToastStore.setState({ toasts: [] });
  });

  it("reports an up-to-date app only for manual checks", async () => {
    api.checkForUpdate.mockResolvedValue(null);
    await useUpdateStore.getState().check(false);
    expect(useUpdateStore.getState().status).toEqual({ kind: "upToDate", version: "0.2.0" });
    expect(useToastStore.getState().toasts).toHaveLength(0);

    await useUpdateStore.getState().check(true);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["QueryCraft 0.2.0 is up to date."]);
  });

  it("downloads and installs an update, then offers a restart", async () => {
    const update = fakeUpdate();
    api.checkForUpdate.mockResolvedValue(update);
    await useUpdateStore.getState().check(false);

    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().status).toEqual({ kind: "ready", version: "0.3.0" });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("QueryCraft 0.3.0 is ready to use after a restart.");
    expect(toasts[0].action?.label).toBe("Restart");

    toasts[0].action?.onClick();
    await vi.waitFor(() => expect(api.relaunch).toHaveBeenCalledTimes(1));
  });

  it("defers the installer to the restart on Windows", async () => {
    api.updateMode.mockResolvedValue("installOnRestart");
    const update = fakeUpdate();
    api.checkForUpdate.mockResolvedValue(update);
    await useUpdateStore.getState().check(false);
    expect(update.install).not.toHaveBeenCalled();

    await useUpdateStore.getState().restart();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("only announces the release on package-managed installs", async () => {
    api.updateMode.mockResolvedValue("notify");
    const update = fakeUpdate();
    api.checkForUpdate.mockResolvedValue(update);
    await useUpdateStore.getState().check(false);

    expect(update.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toEqual({ kind: "available", version: "0.3.0" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((t) => [t.kind, t.message])).toEqual([["info", "QueryCraft 0.3.0 is available."]]);
    toasts[0].action?.onClick();
    expect(api.openReleasePage).toHaveBeenCalledWith("0.3.0");
  });

  it("does not check again while an update is ready", async () => {
    api.checkForUpdate.mockResolvedValue(fakeUpdate());
    await useUpdateStore.getState().check(false);
    await useUpdateStore.getState().check(true);
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it("keeps startup failures quiet and shows manual ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    api.checkForUpdate.mockRejectedValue(new Error("offline"));

    await useUpdateStore.getState().check(false);
    expect(useUpdateStore.getState().status).toEqual({ kind: "error", message: "offline" });
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);

    await useUpdateStore.getState().check(true);
    expect(useToastStore.getState().toasts.map((t) => t.kind)).toEqual(["error"]);
    warn.mockRestore();
  });

  it("refuses to check outside the desktop app", async () => {
    api.updaterAvailable = false;
    await useUpdateStore.getState().check(true);
    expect(api.checkForUpdate).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]?.kind).toBe("error");
  });

  it("describes every status for the settings dialog", () => {
    expect(describeStatus({ kind: "idle" })).toBe("");
    expect(describeStatus({ kind: "downloading", version: "0.3.0", progress: 0.5 })).toContain("50%");
    expect(describeStatus({ kind: "downloading", version: "0.3.0", progress: null })).toBe(
      "Downloading QueryCraft 0.3.0…",
    );
    expect(describeStatus({ kind: "available", version: "0.3.0" })).toContain("GitHub");
    expect(describeStatus({ kind: "ready", version: "0.3.0" })).toContain("restart");
    expect(describeStatus({ kind: "error", message: "offline" })).toContain("offline");
  });
});
