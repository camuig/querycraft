import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import * as api from "../../api/commands";
import type { DbKind, SshAuth } from "../../api/types";
import {
  applyKindChange,
  buildInput,
  type ConnectionTab,
  EMPTY_FORM,
  type FormState,
  formFromConfig,
} from "../../lib/connectionForm";
import { DB_KINDS, dialectFor } from "../../lib/dialect";
import { NO_AUTOCORRECT } from "../../lib/inputProps";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { DbIcon } from "../common/DbIcon";

const COLORS = ["#e55765", "#e6a23c", "#5fad65", "#4a9ede", "#3574f0", "#b384f0"];

const SSH_AUTH_OPTIONS: { value: SshAuth; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key pair" },
  { value: "agent", label: "OpenSSH agent" },
];

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
  const [tab, setTab] = useState<ConnectionTab>("general");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form only when the dialog opens
  useEffect(() => {
    if (isNew) {
      setForm(EMPTY_FORM);
    } else if (editingConfig) {
      setForm(formFromConfig(editingConfig));
    }
    setTab("general");
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
    setForm((f) => applyKindChange(f, kind));
    if (dialectFor(kind).fileBased) setTab("general");
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

  async function handleBrowseCa() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Certificate", extensions: ["pem", "crt", "cer"] }],
      });
      if (typeof selected === "string") {
        setForm((f) => ({ ...f, sslCaPath: selected }));
      }
    } catch (e) {
      toast.error(e);
    }
  }

  async function handleBrowseSshKey() {
    try {
      const selected = await open({ multiple: false, directory: false });
      if (typeof selected === "string") {
        setForm((f) => ({ ...f, sshKeyPath: selected }));
      }
    } catch (e) {
      toast.error(e);
    }
  }

  if (dialog === null) return null;

  function resolveInput() {
    const id = isNew ? null : (editingConfig?.id ?? null);
    const result = buildInput(form, id);
    if (!result.ok) {
      setError(result.error);
      setTab(result.tab);
      return null;
    }
    setError(null);
    return result.input;
  }

  async function handleTest() {
    const input = resolveInput();
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
    const input = resolveInput();
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
        <div className="modal-tabs">
          <button type="button" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
            General
          </button>
          <button
            type="button"
            className={tab === "ssh" ? "active" : ""}
            disabled={dialect.fileBased}
            title={dialect.fileBased ? "Not available for file-based databases" : undefined}
            onClick={() => setTab("ssh")}
          >
            SSH/SSL
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {tab === "general" ? (
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
            ) : (
              <div className="form-grid">
                <span className="form-section">SSL</span>
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

                <label htmlFor="conn-ssl-ca">CA certificate</label>
                <div className="form-row">
                  <input
                    id="conn-ssl-ca"
                    {...NO_AUTOCORRECT}
                    style={{ flex: 1 }}
                    placeholder="optional, PEM file"
                    disabled={!form.ssl}
                    value={form.sslCaPath}
                    onChange={(e) => setForm((f) => ({ ...f, sslCaPath: e.target.value }))}
                  />
                  <button type="button" disabled={!form.ssl} onClick={handleBrowseCa}>
                    Browse…
                  </button>
                </div>
                <span className="form-hint">
                  Used in addition to the system trust store to verify the server certificate.
                </span>

                <span className="form-section">SSH tunnel</span>
                <span className="form-label" />
                <div className="form-row">
                  <label style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={form.sshEnabled}
                      onChange={(e) => setForm((f) => ({ ...f, sshEnabled: e.target.checked }))}
                    />
                    Use SSH tunnel
                  </label>
                </div>

                {form.sshEnabled && (
                  <>
                    <label htmlFor="conn-ssh-host">Host</label>
                    <input
                      id="conn-ssh-host"
                      {...NO_AUTOCORRECT}
                      value={form.sshHost}
                      onChange={(e) => setForm((f) => ({ ...f, sshHost: e.target.value }))}
                    />

                    <label htmlFor="conn-ssh-port">Port</label>
                    <input
                      id="conn-ssh-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={form.sshPort}
                      onChange={(e) => setForm((f) => ({ ...f, sshPort: e.target.value }))}
                    />

                    <label htmlFor="conn-ssh-user">User</label>
                    <input
                      id="conn-ssh-user"
                      {...NO_AUTOCORRECT}
                      value={form.sshUser}
                      onChange={(e) => setForm((f) => ({ ...f, sshUser: e.target.value }))}
                    />

                    <label htmlFor="conn-ssh-auth">Authentication</label>
                    <select
                      id="conn-ssh-auth"
                      value={form.sshAuth}
                      onChange={(e) => setForm((f) => ({ ...f, sshAuth: e.target.value as SshAuth }))}
                    >
                      {SSH_AUTH_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>

                    {form.sshAuth === "password" && (
                      <>
                        <label htmlFor="conn-ssh-password">Password</label>
                        <input
                          id="conn-ssh-password"
                          {...NO_AUTOCORRECT}
                          type="password"
                          placeholder={!isNew && editingConfig?.hasSshSecret ? "••••••••" : undefined}
                          value={form.sshSecret}
                          onChange={(e) => setForm((f) => ({ ...f, sshSecret: e.target.value }))}
                        />
                      </>
                    )}

                    {form.sshAuth === "key" && (
                      <>
                        <label htmlFor="conn-ssh-key">Private key</label>
                        <div className="form-row">
                          <input
                            id="conn-ssh-key"
                            {...NO_AUTOCORRECT}
                            style={{ flex: 1 }}
                            value={form.sshKeyPath}
                            onChange={(e) => setForm((f) => ({ ...f, sshKeyPath: e.target.value }))}
                          />
                          <button type="button" onClick={handleBrowseSshKey}>
                            Browse…
                          </button>
                        </div>

                        <label htmlFor="conn-ssh-passphrase">Passphrase</label>
                        <input
                          id="conn-ssh-passphrase"
                          {...NO_AUTOCORRECT}
                          type="password"
                          placeholder={!isNew && editingConfig?.hasSshSecret ? "••••••••" : undefined}
                          value={form.sshSecret}
                          onChange={(e) => setForm((f) => ({ ...f, sshSecret: e.target.value }))}
                        />
                      </>
                    )}

                    {form.sshAuth === "agent" && (
                      <>
                        <span className="form-label" />
                        <span className="form-hint" style={{ marginTop: 0 }}>
                          Keys are taken from the running OpenSSH agent (SSH_AUTH_SOCK).
                        </span>
                      </>
                    )}

                    <span className="form-label" />
                    <span className="form-hint" style={{ gridColumn: 2, marginTop: 0 }}>
                      The SSH password or passphrase follows the Save password setting on the General tab.
                    </span>
                  </>
                )}
              </div>
            )}
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
