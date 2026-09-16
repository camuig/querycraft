// Bridge to the Tauri updater (GitHub releases). Unavailable in the browser.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const RELEASES_URL = "https://github.com/camuig/querycraft/releases";

/** Whether the running build can check for and install updates. */
export const updaterAvailable = isTauri;

/**
 * What the updater may do on this installation (decided by the backend from the bundle type):
 * - `install`: files are replaced in place, the new version starts at the next launch;
 * - `installOnRestart`: the update is an installer that closes the app (Windows), so it runs
 *   only when the user agrees to restart;
 * - `notify`: package-managed installs (deb, rpm) are left alone, the release is only announced.
 */
export type UpdateMode = "install" | "installOnRestart" | "notify";

export type ProgressHandler = (downloaded: number, total: number | null) => void;

export interface AvailableUpdate {
  version: string;
  notes: string;
  download(onProgress: ProgressHandler): Promise<void>;
  install(): Promise<void>;
}

export function currentVersion(): Promise<string> {
  return getVersion();
}

export function updateMode(): Promise<UpdateMode> {
  return invoke<UpdateMode>("update_mode");
}

/** Resolves with the newer version published on GitHub, or `null` when the app is up to date. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    async download(onProgress) {
      let downloaded = 0;
      let total: number | null = null;
      await update.download((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? null;
        else if (e.event === "Progress") {
          downloaded += e.data.chunkLength;
          onProgress(downloaded, total);
        }
      });
    },
    install: () => update.install(),
  };
}

export function relaunch(): Promise<void> {
  return tauriRelaunch();
}

/** Opens the GitHub page of the release in the browser. */
export function openReleasePage(version: string): Promise<void> {
  return openUrl(`${RELEASES_URL}/tag/v${version}`);
}
