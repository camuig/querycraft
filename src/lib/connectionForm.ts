// Pure form <-> ConnectionInput conversion and validation for the connection dialog.
// Kept separate from the React component so the logic can be unit-tested without rendering.

import type { ConnectionConfig, ConnectionInput, DbKind, SshAuth } from "../api/types";
import { dialectFor } from "./dialect";

/** Which tab of the connection dialog a validation error belongs to. */
export type ConnectionTab = "general" | "ssh";

export interface FormState {
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
  sslCaPath: string;
  color: string | null;
  path: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshKeyPath: string;
  sshSecret: string;
}

const MYSQL_DEFAULTS = dialectFor("mysql");

/** Blank form for a new connection, defaulting to MySQL. */
export const EMPTY_FORM: FormState = {
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
  sslCaPath: "",
  color: null,
  path: "",
  sshEnabled: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "password",
  sshKeyPath: "",
  sshSecret: "",
};

/** Builds the form state for editing an existing connection. */
export function formFromConfig(config: ConnectionConfig): FormState {
  const ssh = config.ssh;
  return {
    kind: config.kind,
    name: config.name,
    host: config.host,
    port: String(config.port),
    user: config.user,
    password: "",
    savePassword: true,
    database: config.database ?? "",
    ssl: config.ssl,
    sslVerify: config.sslVerify,
    sslCaPath: config.sslCaPath ?? "",
    color: config.color,
    path: config.path ?? "",
    sshEnabled: ssh !== null,
    sshHost: ssh?.host ?? "",
    sshPort: String(ssh?.port ?? 22),
    sshUser: ssh?.user ?? "",
    sshAuth: ssh?.auth ?? "password",
    sshKeyPath: ssh?.keyPath ?? "",
    sshSecret: "",
  };
}

/**
 * Applies dialect defaults when switching the database type, the same way the form did before it
 * grew SSH/SSL fields: a field only follows the new dialect's default while it still holds the
 * previous dialect's default, so a value the user typed in is left alone. Switching to a
 * file-based engine (SQLite) also turns off the SSH tunnel, since it has no network connection.
 */
export function applyKindChange(form: FormState, kind: DbKind): FormState {
  const prev = dialectFor(form.kind);
  const next = dialectFor(kind);
  return {
    ...form,
    kind,
    port: form.port === String(prev.defaultPort) ? String(next.defaultPort) : form.port,
    user: form.user === prev.defaultUser ? next.defaultUser : form.user,
    database: form.database === prev.defaultDatabase ? next.defaultDatabase : form.database,
    path: next.fileBased ? form.path : "",
    sshEnabled: next.fileBased ? false : form.sshEnabled,
  };
}

export type BuildInputResult = { ok: true; input: ConnectionInput } | { ok: false; error: string; tab: ConnectionTab };

/** Validates the form and converts it into the payload the backend expects. */
export function buildInput(form: FormState, id: string | null): BuildInputResult {
  const dialect = dialectFor(form.kind);
  const name = form.name.trim();

  if (dialect.fileBased) {
    const path = form.path.trim();
    if (!name || !path) {
      return { ok: false, error: "Fill in name and file path", tab: "general" };
    }
    return {
      ok: true,
      input: {
        id,
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
        sslCaPath: null,
        color: form.color,
        path,
        ssh: null,
        sshSecret: null,
      },
    };
  }

  const host = form.host.trim();
  const user = form.user.trim();
  const port = Number(form.port);
  // Redis/Valkey: the user is an optional ACL username (empty means the default user).
  if (!name || !host || (!user && dialect.queryLanguage !== "redis")) {
    return { ok: false, error: "Fill in name, host and user", tab: "general" };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "Port must be a number between 1 and 65535", tab: "general" };
  }
  const database = form.database.trim();
  if (dialect.requiresDatabase && !database) {
    return { ok: false, error: "PostgreSQL needs a database name", tab: "general" };
  }
  if (dialect.queryLanguage === "redis" && database && !/^\d+$/.test(database)) {
    return { ok: false, error: "Database index must be a number", tab: "general" };
  }

  let ssh: ConnectionInput["ssh"] = null;
  if (form.sshEnabled) {
    const sshHost = form.sshHost.trim();
    const sshUser = form.sshUser.trim();
    const sshPort = Number(form.sshPort);
    if (!sshHost || !sshUser) {
      return { ok: false, error: "Fill in SSH host and user", tab: "ssh" };
    }
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      return { ok: false, error: "SSH port must be a number between 1 and 65535", tab: "ssh" };
    }
    const sshKeyPath = form.sshKeyPath.trim();
    if (form.sshAuth === "key" && !sshKeyPath) {
      return { ok: false, error: "Choose the private key file", tab: "ssh" };
    }
    ssh = {
      host: sshHost,
      port: sshPort,
      user: sshUser,
      auth: form.sshAuth,
      keyPath: form.sshAuth === "key" ? sshKeyPath : null,
    };
  }

  return {
    ok: true,
    input: {
      id,
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
      sslCaPath: form.ssl ? form.sslCaPath.trim() || null : null,
      color: form.color,
      path: null,
      ssh,
      sshSecret: form.sshSecret.length > 0 ? form.sshSecret : null,
    },
  };
}
