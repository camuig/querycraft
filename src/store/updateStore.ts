import { create } from "zustand";
import {
  type AvailableUpdate,
  checkForUpdate,
  currentVersion,
  openReleasePage,
  relaunch,
  updateMode,
  updaterAvailable,
} from "../api/updater";
import { toast } from "./toastStore";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate"; version: string }
  /** A newer release exists but this installation (deb, rpm) is updated by the package manager. */
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; progress: number | null }
  /** Installed (macOS, Linux) or downloaded (Windows); a restart finishes the update. */
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

interface UpdateState {
  status: UpdateStatus;
  /**
   * Checks GitHub for a newer release and downloads it (installing right away where that is
   * safe). `manual` checks report every outcome with a toast; the automatic startup check
   * only announces a new release and stays quiet when offline.
   */
  check: (manual: boolean) => Promise<void>;
  /** Restarts into the downloaded version (on Windows this runs the installer first). */
  restart: () => Promise<void>;
}

/** How long the "new release" notice for package-managed installs stays on screen. */
const AVAILABLE_TOAST_MS = 15000;

let pending: AvailableUpdate | null = null;
let pendingInstallsOnRestart = false;

/** Text for the settings dialog. */
export function describeStatus(status: UpdateStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return `QueryCraft ${status.version} is up to date.`;
    case "available":
      return `QueryCraft ${status.version} is available on GitHub.`;
    case "downloading":
      return status.progress === null
        ? `Downloading QueryCraft ${status.version}…`
        : `Downloading QueryCraft ${status.version}… ${Math.round(status.progress * 100)}%`;
    case "ready":
      return `QueryCraft ${status.version} is ready — restart to finish the update.`;
    case "error":
      return `Update check failed: ${status.message}`;
  }
}

function readyMessage(version: string): string {
  return `QueryCraft ${version} is ready to use after a restart.`;
}

function announceAvailable(version: string): void {
  toast.info(`QueryCraft ${version} is available.`, {
    ttlMs: AVAILABLE_TOAST_MS,
    action: { label: "View release", onClick: () => openReleasePage(version).catch(toast.error) },
  });
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  status: { kind: "idle" },

  check: async (manual) => {
    const { status } = get();
    if (status.kind === "checking" || status.kind === "downloading") return;
    if (status.kind === "ready") {
      if (manual) toast.info(readyMessage(status.version), { ttlMs: 0, action: restartAction() });
      return;
    }
    if (!updaterAvailable) {
      if (manual) toast.error("Updates are only available in the desktop app.");
      return;
    }
    set({ status: { kind: "checking" } });
    try {
      const update = await checkForUpdate();
      if (!update) {
        const version = await currentVersion();
        set({ status: { kind: "upToDate", version } });
        if (manual) toast.success(`QueryCraft ${version} is up to date.`);
        return;
      }
      const mode = await updateMode();
      if (mode === "notify") {
        set({ status: { kind: "available", version: update.version } });
        announceAvailable(update.version);
        return;
      }
      set({ status: { kind: "downloading", version: update.version, progress: null } });
      if (manual) toast.info(`Downloading QueryCraft ${update.version}…`);
      await update.download((downloaded, total) => {
        set({
          status: { kind: "downloading", version: update.version, progress: total ? downloaded / total : null },
        });
      });
      pendingInstallsOnRestart = mode === "installOnRestart";
      if (!pendingInstallsOnRestart) await update.install();
      pending = update;
      set({ status: { kind: "ready", version: update.version } });
      toast.success(readyMessage(update.version), { ttlMs: 0, action: restartAction() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ status: { kind: "error", message } });
      if (manual) toast.error(`Update check failed: ${message}`);
      else console.warn("Update check failed:", message);
    }
  },

  restart: async () => {
    try {
      if (pendingInstallsOnRestart && pending) await pending.install();
      await relaunch();
    } catch (e) {
      toast.error(e);
    }
  },
}));

function restartAction() {
  return { label: "Restart", onClick: () => void useUpdateStore.getState().restart() };
}
