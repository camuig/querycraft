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
- QueryCraft executes the SQL you type against your own servers; it is not a hardened multi-tenant service.
