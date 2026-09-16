import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../../api/types";
import { applyKindChange, buildInput, EMPTY_FORM, type FormState, formFromConfig } from "../connectionForm";

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "c1",
    name: "prod",
    kind: "postgres",
    host: "db.example.com",
    port: 5432,
    user: "app",
    database: "shop",
    ssl: true,
    sslVerify: true,
    sslCaPath: "/etc/ca.pem",
    color: "#3574f0",
    path: null,
    ssh: { host: "bastion.example.com", port: 2222, user: "deploy", auth: "key", keyPath: "~/.ssh/id_ed25519" },
    hasPassword: true,
    hasSshSecret: true,
    ...overrides,
  };
}

describe("formFromConfig", () => {
  it("fills the form from an existing config with an SSH tunnel", () => {
    const form = formFromConfig(config());
    expect(form.sshEnabled).toBe(true);
    expect(form.sshHost).toBe("bastion.example.com");
    expect(form.sshPort).toBe("2222");
    expect(form.sshUser).toBe("deploy");
    expect(form.sshAuth).toBe("key");
    expect(form.sshKeyPath).toBe("~/.ssh/id_ed25519");
    expect(form.sshSecret).toBe("");
    expect(form.sslCaPath).toBe("/etc/ca.pem");
    // The saved password/secret is never sent back to the form.
    expect(form.password).toBe("");
  });

  it("defaults SSH fields when the config has no tunnel", () => {
    const form = formFromConfig(config({ ssh: null, sslCaPath: null }));
    expect(form.sshEnabled).toBe(false);
    expect(form.sshHost).toBe("");
    expect(form.sshPort).toBe("22");
    expect(form.sshUser).toBe("");
    expect(form.sshAuth).toBe("password");
    expect(form.sshKeyPath).toBe("");
    expect(form.sslCaPath).toBe("");
  });
});

describe("applyKindChange", () => {
  it("follows the new dialect's defaults only where the previous default was untouched", () => {
    const changed: FormState = { ...EMPTY_FORM, port: "3307", user: "custom" };
    const next = applyKindChange(changed, "postgres");
    // port and user were edited away from the MySQL defaults, so they are kept.
    expect(next.port).toBe("3307");
    expect(next.user).toBe("custom");
    expect(next.database).toBe("postgres");
  });

  it("applies every default when nothing was touched", () => {
    const next = applyKindChange(EMPTY_FORM, "postgres");
    expect(next.port).toBe("5432");
    expect(next.user).toBe("postgres");
    expect(next.database).toBe("postgres");
  });

  it("disables the SSH tunnel when switching to a file-based engine", () => {
    const withSsh: FormState = { ...EMPTY_FORM, sshEnabled: true, sshHost: "bastion", sshUser: "root" };
    const next = applyKindChange(withSsh, "sqlite");
    expect(next.sshEnabled).toBe(false);
    // The rest of the SSH fields are left alone so re-enabling it does not lose them.
    expect(next.sshHost).toBe("bastion");
  });
});

describe("buildInput", () => {
  it("requires name, host and user", () => {
    const result = buildInput({ ...EMPTY_FORM, name: "", host: "", user: "" }, null);
    expect(result).toEqual({ ok: false, error: "Fill in name, host and user", tab: "general" });
  });

  it("rejects an out-of-range port", () => {
    const result = buildInput({ ...EMPTY_FORM, name: "n", port: "99999" }, null);
    expect(result).toEqual({ ok: false, error: "Port must be a number between 1 and 65535", tab: "general" });
  });

  it("requires a database name for PostgreSQL", () => {
    const result = buildInput({ ...EMPTY_FORM, kind: "postgres", name: "n", database: "" }, null);
    expect(result).toEqual({ ok: false, error: "PostgreSQL needs a database name", tab: "general" });
  });

  it("builds a plain connection with SSL and no CA file", () => {
    const result = buildInput({ ...EMPTY_FORM, name: "n" }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.ssl).toBe(false);
    expect(result.input.sslCaPath).toBeNull();
    expect(result.input.ssh).toBeNull();
    expect(result.input.sshSecret).toBeNull();
  });

  it("nulls out the CA path when SSL is off even if one was typed", () => {
    const result = buildInput({ ...EMPTY_FORM, name: "n", ssl: false, sslCaPath: "/etc/ca.pem" }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.sslCaPath).toBeNull();
  });

  it("trims the CA path and keeps it when SSL is on", () => {
    const result = buildInput({ ...EMPTY_FORM, name: "n", ssl: true, sslCaPath: "  /etc/ca.pem  " }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.sslCaPath).toBe("/etc/ca.pem");
  });

  it("requires SSH host and user when the tunnel is enabled", () => {
    const result = buildInput({ ...EMPTY_FORM, name: "n", sshEnabled: true, sshHost: "", sshUser: "" }, null);
    expect(result).toEqual({ ok: false, error: "Fill in SSH host and user", tab: "ssh" });
  });

  it("rejects an out-of-range SSH port", () => {
    const result = buildInput(
      { ...EMPTY_FORM, name: "n", sshEnabled: true, sshHost: "h", sshUser: "u", sshPort: "0" },
      null,
    );
    expect(result).toEqual({ ok: false, error: "SSH port must be a number between 1 and 65535", tab: "ssh" });
  });

  it("requires a private key file for key auth", () => {
    const result = buildInput(
      { ...EMPTY_FORM, name: "n", sshEnabled: true, sshHost: "h", sshUser: "u", sshAuth: "key", sshKeyPath: "" },
      null,
    );
    expect(result).toEqual({ ok: false, error: "Choose the private key file", tab: "ssh" });
  });

  it("builds an SSH tunnel with a key and drops the key path for other auth modes", () => {
    const result = buildInput(
      {
        ...EMPTY_FORM,
        name: "n",
        sshEnabled: true,
        sshHost: "bastion",
        sshUser: "deploy",
        sshPort: "2222",
        sshAuth: "key",
        sshKeyPath: "~/.ssh/id_ed25519",
        sshSecret: "passphrase",
      },
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.ssh).toEqual({
      host: "bastion",
      port: 2222,
      user: "deploy",
      auth: "key",
      keyPath: "~/.ssh/id_ed25519",
    });
    expect(result.input.sshSecret).toBe("passphrase");

    const agentResult = buildInput(
      { ...EMPTY_FORM, name: "n", sshEnabled: true, sshHost: "bastion", sshUser: "deploy", sshAuth: "agent" },
      null,
    );
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) throw new Error("expected ok");
    expect(agentResult.input.ssh?.keyPath).toBeNull();
  });

  it("nulls out every SSL/SSH field for file-based engines", () => {
    const result = buildInput(
      { ...EMPTY_FORM, kind: "sqlite", name: "n", path: "/tmp/db.sqlite", ssl: true, sshEnabled: true },
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.ssl).toBe(false);
    expect(result.input.sslVerify).toBe(false);
    expect(result.input.sslCaPath).toBeNull();
    expect(result.input.ssh).toBeNull();
    expect(result.input.sshSecret).toBeNull();
  });

  it("requires a name and file path for file-based engines", () => {
    const result = buildInput({ ...EMPTY_FORM, kind: "sqlite", name: "", path: "" }, null);
    expect(result).toEqual({ ok: false, error: "Fill in name and file path", tab: "general" });
  });
});
