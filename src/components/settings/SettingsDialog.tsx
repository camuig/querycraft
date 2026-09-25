import { useEffect } from "react";
import { updaterAvailable } from "../../api/updater";
import {
  MAX_EDITOR_FONT_SIZE,
  MAX_ROWS_OPTIONS,
  MIN_EDITOR_FONT_SIZE,
  type SettingsTab,
  type ThemePreference,
  useSettingsStore,
} from "../../store/settingsStore";
import { describeStatus, useUpdateStore } from "../../store/updateStore";
import { AiSettings } from "./AiSettings";

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "ai", label: "AI" },
];

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Follow the OS appearance" },
  { value: "light", label: "Light", hint: "" },
  { value: "dark", label: "Dark", hint: "" },
];

/** Settings dialog: theme, row limit, editor font size, updates. Changes apply immediately. */
export function SettingsDialog() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const maxRows = useSettingsStore((s) => s.maxRows);
  const setMaxRows = useSettingsStore((s) => s.setMaxRows);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const setEditorFontSize = useSettingsStore((s) => s.setEditorFontSize);
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const dialogTab = useSettingsStore((s) => s.dialogTab);
  const switchTab = useSettingsStore((s) => s.openDialog);
  const updateStatus = useUpdateStore((s) => s.status);
  const checkForUpdates = useUpdateStore((s) => s.check);
  const updateBusy = updateStatus.kind === "checking" || updateStatus.kind === "downloading";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <div className="modal" style={{ minWidth: dialogTab === "ai" ? 620 : 420 }}>
        <div className="modal-header">Settings</div>
        <div className="modal-tabs">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={dialogTab === t.value ? "active" : ""}
              onClick={() => switchTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {dialogTab === "ai" ? (
            <AiSettings />
          ) : (
            <div className="form-grid">
              <span className="form-label">Theme</span>
              <div className="segmented" role="radiogroup" aria-label="Theme">
                {THEME_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={theme === o.value}
                    className={theme === o.value ? "active" : ""}
                    title={o.hint || undefined}
                    onClick={() => setTheme(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              <label htmlFor="settings-max-rows">Row limit</label>
              <select id="settings-max-rows" value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
                {MAX_ROWS_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>

              <label htmlFor="settings-font-size">Editor font size</label>
              <input
                id="settings-font-size"
                type="number"
                min={MIN_EDITOR_FONT_SIZE}
                max={MAX_EDITOR_FONT_SIZE}
                value={editorFontSize}
                onChange={(e) => setEditorFontSize(Number(e.target.value))}
                style={{ width: 80 }}
              />

              <span className="form-label">Updates</span>
              <div className="form-row">
                <label style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} />
                  Check for updates at startup and install them automatically
                </label>
              </div>
              <span className="form-label" />
              <div className="form-row">
                <button type="button" disabled={updateBusy || !updaterAvailable} onClick={() => checkForUpdates(true)}>
                  Check now
                </button>
                <span className="form-hint" style={{ margin: 0 }}>
                  {describeStatus(updateStatus)}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="primary" onClick={closeDialog}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
