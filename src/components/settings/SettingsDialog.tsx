import { useEffect } from "react";
import {
  MAX_EDITOR_FONT_SIZE,
  MAX_ROWS_OPTIONS,
  MIN_EDITOR_FONT_SIZE,
  type ThemePreference,
  useSettingsStore,
} from "../../store/settingsStore";

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Follow the OS appearance" },
  { value: "light", label: "Light", hint: "" },
  { value: "dark", label: "Dark", hint: "" },
];

/** Settings dialog: theme, row limit, editor font size. Changes apply immediately. */
export function SettingsDialog() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const maxRows = useSettingsStore((s) => s.maxRows);
  const setMaxRows = useSettingsStore((s) => s.setMaxRows);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const setEditorFontSize = useSettingsStore((s) => s.setEditorFontSize);
  const closeDialog = useSettingsStore((s) => s.closeDialog);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <div className="modal" style={{ minWidth: 420 }}>
        <div className="modal-header">Settings</div>
        <div className="modal-body">
          <div className="form-grid">
            <label>Theme</label>
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

            <label>Row limit</label>
            <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
              {MAX_ROWS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            <label>Editor font size</label>
            <input
              type="number"
              min={MIN_EDITOR_FONT_SIZE}
              max={MAX_EDITOR_FONT_SIZE}
              value={editorFontSize}
              onChange={(e) => setEditorFontSize(Number(e.target.value))}
              style={{ width: 80 }}
            />
          </div>
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
