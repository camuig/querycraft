import { useEffect, useMemo, useState } from "react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useTabsStore } from "../../store/tabsStore";
import * as api from "../../api/commands";
import type { ConnectionInput } from "../../api/types";
import { toast } from "../../store/toastStore";
import { NO_AUTOCORRECT } from "../../lib/inputProps";

const COLORS = ["#e55765", "#e6a23c", "#5fad65", "#4a9ede", "#3574f0", "#b384f0"];

interface FormState {
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  savePassword: boolean;
  database: string;
  ssl: boolean;
  color: string | null;
}

const EMPTY_FORM: FormState = {
  name: "",
  host: "localhost",
  port: "3306",
  user: "root",
  password: "",
  savePassword: true,
  database: "",
  ssl: false,
  color: null,
};

/** Modal for creating/editing a connection. */
export function ConnectionDialog() {
  const dialog = useConnectionsStore((s) => s.dialog);
  const closeDialog = useConnectionsStore((s) => s.closeDialog);
  const save = useConnectionsStore((s) => s.save);
  const remove = useConnectionsStore((s) => s.remove);
  const closeTabsForConnection = useTabsStore((s) => s.closeTabsForConnection);

  const editingConfig = useConnectionsStore((s) =>
    dialog && dialog !== "new" ? s.configs.find((c) => c.id === dialog) : undefined,
  );
  const isNew = dialog === "new";

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (isNew) {
      setForm(EMPTY_FORM);
    } else if (editingConfig) {
      setForm({
        name: editingConfig.name,
        host: editingConfig.host,
        port: String(editingConfig.port),
        user: editingConfig.user,
        password: "",
        savePassword: true,
        database: editingConfig.database ?? "",
        ssl: editingConfig.ssl,
        color: editingConfig.color,
      });
    }
    setError(null);
    setConfirmingDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog]);

  const buildInput = useMemo(
    () =>
      (): ConnectionInput | null => {
        const name = form.name.trim();
        const host = form.host.trim();
        const user = form.user.trim();
        const port = Number(form.port);
        if (!name || !host || !user) {
          setError("Fill in name, host and user");
          return null;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setError("Port must be a number between 1 and 65535");
          return null;
        }
        setError(null);
        return {
          id: isNew ? null : (editingConfig?.id ?? null),
          name,
          host,
          port,
          user,
          password: form.password.length > 0 ? form.password : null,
          savePassword: form.savePassword,
          database: form.database.trim() || null,
          ssl: form.ssl,
          color: form.color,
        };
      },
    [form, isNew, editingConfig],
  );

  if (dialog === null) return null;

  async function handleTest() {
    const input = buildInput();
    if (!input) return;
    setTesting(true);
    try {
      const info = await api.testConnection(input);
      toast.success(`Connected. Server version: ${info.serverVersion}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input = buildInput();
    if (!input) return;
    setSaving(true);
    try {
      await save(input);
      closeDialog();
    } catch (e2) {
      toast.error(e2);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingConfig) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    try {
      await remove(editingConfig.id);
      closeTabsForConnection(editingConfig.id);
      closeDialog();
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <div className="modal" style={{ minWidth: 480 }}>
        <div className="modal-header">{isNew ? "New connection" : "Edit connection"}</div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-grid">
              <label>Name</label>
              <input
                {...NO_AUTOCORRECT}
                autoFocus
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />

              <label>Host</label>
              <input {...NO_AUTOCORRECT} value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />

              <label>Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
              />

              <label>User</label>
              <input {...NO_AUTOCORRECT} value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} />

              <label>Password</label>
              <input
                {...NO_AUTOCORRECT}
                type="password"
                placeholder={!isNew && editingConfig?.hasPassword ? "••••••••" : undefined}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />

              <label></label>
              <div className="form-row">
                <label style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.savePassword}
                    onChange={(e) => setForm((f) => ({ ...f, savePassword: e.target.checked }))}
                  />
                  Save password
                </label>
              </div>

              <label>Database</label>
              <input
                {...NO_AUTOCORRECT}
                placeholder="optional"
                value={form.database}
                onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))}
              />

              <label></label>
              <div className="form-row">
                <label style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.ssl}
                    onChange={(e) => setForm((f) => ({ ...f, ssl: e.target.checked }))}
                  />
                  SSL
                </label>
              </div>

              <label>Color</label>
              <div className="form-row">
                <button
                  type="button"
                  className="icon"
                  title="No color"
                  onClick={() => setForm((f) => ({ ...f, color: null }))}
                  style={{
                    width: 18,
                    height: 18,
                    minWidth: 18,
                    borderRadius: 9,
                    border: form.color === null ? "2px solid var(--accent)" : "1px solid var(--border-strong)",
                    background: "transparent",
                    padding: 0,
                  }}
                />
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => setForm((f) => ({ ...f, color: c }))}
                    style={{
                      width: 18,
                      height: 18,
                      minWidth: 18,
                      borderRadius: 9,
                      background: c,
                      border: form.color === c ? "2px solid var(--fg)" : "1px solid var(--border-strong)",
                      padding: 0,
                    }}
                  />
                ))}
              </div>
            </div>
            {error && (
              <div className="danger" style={{ marginTop: 12 }}>
                {error}
              </div>
            )}
          </div>
          <div className="modal-footer">
            {!isNew && (
              <button
                type="button"
                className={confirmingDelete ? "danger" : ""}
                onClick={handleDelete}
                style={{ marginRight: "auto" }}
              >
                {confirmingDelete ? "Confirm delete?" : "Delete"}
              </button>
            )}
            <button type="button" onClick={handleTest} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button type="button" className="outline" onClick={closeDialog}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              OK
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
