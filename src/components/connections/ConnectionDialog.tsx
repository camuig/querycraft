import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import * as api from "../../api/commands";
import type { ConnectionInput, DbKind } from "../../api/types";
import { DB_KINDS, dialectFor } from "../../lib/dialect";
import { NO_AUTOCORRECT } from "../../lib/inputProps";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { DbIcon } from "../common/DbIcon";

const COLORS = ["#e55765", "#e6a23c", "#5fad65", "#4a9ede", "#3574f0", "#b384f0"];

interface FormState {
  kind: DbKind;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  savePassword: boolean;
  database: string;
  ssl: boolean;
  sslVerify: boolean;
  color: string | null;
  path: string;
}

const MYSQL_DEFAULTS = dialectFor("mysql");

const EMPTY_FORM: FormState = {
  kind: "mysql",
  name: "",
  host: "localhost",
  port: String(MYSQL_DEFAULTS.defaultPort),
  user: MYSQL_DEFAULTS.defaultUser,
  password: "",
  savePassword: true,
  database: MYSQL_DEFAULTS.defaultDatabase,
  ssl: false,
  sslVerify: true,
  color: null,
  path: "",
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form only when the dialog opens
  useEffect(() => {
    if (isNew) {
      setForm(EMPTY_FORM);
    } else if (editingConfig) {
      setForm({
        kind: editingConfig.kind,
        name: editingConfig.name,
        host: editingConfig.host,
        port: String(editingConfig.port),
        user: editingConfig.user,
        password: "",
        savePassword: true,
        database: editingConfig.database ?? "",
        ssl: editingConfig.ssl,
        sslVerify: editingConfig.sslVerify,
        color: editingConfig.color,
        path: editingConfig.path ?? "",
      });
    }
    setError(null);
    setConfirmingDelete(false);
  }, [dialog]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog]);

  const dialect = dialectFor(form.kind);

  function handleKindChange(kind: DbKind) {
    setForm((f) => {
      const prev = dialectFor(f.kind);
      const next = dialectFor(kind);
      return {
        ...f,
        kind,
        port: f.port === String(prev.defaultPort) ? String(next.defaultPort) : f.port,
        user: f.user === prev.defaultUser ? next.defaultUser : f.user,
        database: f.database === prev.defaultDatabase ? next.defaultDatabase : f.database,
        path: next.fileBased ? f.path : "",
      };
    });
  }

  async function handleBrowse() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
      });
      if (typeof selected === "string") {
        setForm((f) => ({ ...f, path: selected }));
      }
    } catch (e) {
      toast.error(e);
    }
  }

  const buildInput = useMemo(
    () => (): ConnectionInput | null => {
      const name = form.name.trim();

      if (dialect.fileBased) {
        const path = form.path.trim();
        if (!name || !path) {
          setError("Fill in name and file path");
          return null;
        }
        setError(null);
        return {
          id: isNew ? null : (editingConfig?.id ?? null),
          name,
          kind: form.kind,
          host: "",
          port: 0,
          user: "",
          password: null,
          savePassword: false,
          database: null,
          ssl: false,
          sslVerify: false,
          color: form.color,
          path,
        };
      }

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
      const database = form.database.trim();
      if (dialect.requiresDatabase && !database) {
        setError("PostgreSQL needs a database name");
        return null;
      }
      setError(null);
      return {
        id: isNew ? null : (editingConfig?.id ?? null),
        name,
        kind: form.kind,
        host,
        port,
        user,
        password: form.password.length > 0 ? form.password : null,
        savePassword: form.savePassword,
        database: database || null,
        ssl: form.ssl,
        sslVerify: form.sslVerify,
        color: form.color,
        path: null,
      };
    },
    [form, isNew, editingConfig, dialect],
  );

  if (dialog === null) return null;

  async function handleTest() {
    const input = buildInput();
    if (!input) return;
    setTesting(true);
    try {
      const info = await api.testConnection(input);
      toast.success(`Connected. ${dialectFor(input.kind).label} ${info.serverVersion}`);
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
              <span className="form-label">Type</span>
              <div className="form-row segmented">
                {DB_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={form.kind === k ? "active" : ""}
                    onClick={() => handleKindChange(k)}
                  >
                    <DbIcon kind={k} size={14} />
                    {dialectFor(k).label}
                  </button>
                ))}
              </div>

              <label htmlFor="conn-name">Name</label>
              <input
                id="conn-name"
                {...NO_AUTOCORRECT}
                autoFocus
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />

              {dialect.fileBased ? (
                <>
                  <label htmlFor="conn-path">File</label>
                  <div className="form-row">
                    <input
                      id="conn-path"
                      {...NO_AUTOCORRECT}
                      style={{ flex: 1 }}
                      value={form.path}
                      onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                    />
                    <button type="button" onClick={handleBrowse}>
                      Browse…
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label htmlFor="conn-host">Host</label>
                  <input
                    id="conn-host"
                    {...NO_AUTOCORRECT}
                    value={form.host}
                    onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                  />

                  <label htmlFor="conn-port">Port</label>
                  <input
                    id="conn-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                  />

                  <label htmlFor="conn-user">User</label>
                  <input
                    id="conn-user"
                    {...NO_AUTOCORRECT}
                    value={form.user}
                    onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
                  />

                  <label htmlFor="conn-password">Password</label>
                  <input
                    id="conn-password"
                    {...NO_AUTOCORRECT}
                    type="password"
                    placeholder={!isNew && editingConfig?.hasPassword ? "••••••••" : undefined}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />

                  <span className="form-label" />
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

                  <label htmlFor="conn-database">Database</label>
                  <input
                    id="conn-database"
                    {...NO_AUTOCORRECT}
                    placeholder={dialect.requiresDatabase ? undefined : "optional"}
                    value={form.database}
                    onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))}
                  />

                  <span className="form-label" />
                  <div className="form-row">
                    <label style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={form.ssl}
                        onChange={(e) => setForm((f) => ({ ...f, ssl: e.target.checked }))}
                      />
                      SSL
                    </label>
                    <label
                      style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}
                      title="Check the server certificate against the system trust store. Turn off only for self-signed certificates on a trusted network."
                    >
                      <input
                        type="checkbox"
                        checked={form.sslVerify}
                        disabled={!form.ssl}
                        onChange={(e) => setForm((f) => ({ ...f, sslVerify: e.target.checked }))}
                      />
                      Verify server certificate
                    </label>
                  </div>
                </>
              )}

              <span className="form-label">Color</span>
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
