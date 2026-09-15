# Security Policy

## Supported versions

Only the latest release of QueryCraft receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/camuig/querycraft/security/advisories/new) instead of
opening a public issue. Include a description of the problem, steps to reproduce and the affected version.
You will receive a response as soon as possible, and a fix will be published before details are disclosed.

## Scope notes

- Connection passwords are stored in the operating system keyring (Keychain, Credential Manager,
  Secret Service), never in plain-text configuration files.
- With SSL enabled, the server certificate and host name are verified against the system trust store.
  The per-connection "Verify server certificate" option can turn this off for self-signed certificates;
  doing so makes the connection vulnerable to man-in-the-middle attacks.
- Query history (`history.json` in the application data directory) stores executed SQL as plain text.
  Statements that embed secrets (for example `CREATE USER ... IDENTIFIED BY`) end up there too; clear
  the history if that is a concern.
- The WebView runs under a restrictive Content Security Policy (no remote scripts, no remote connections).
- QueryCraft executes the SQL you type against your own servers; it is not a hardened multi-tenant service.
