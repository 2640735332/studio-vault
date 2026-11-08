# Security Policy

## Supported versions

The project is pre-1.0. Security fixes are applied to the latest released
version of the Studio packages (`@studio/*`, currently `0.1.x`) and the
Vault service (`@studio/vault`, currently `0.1.x`). Older versions do not
receive backports; upgrading to the latest release is the supported path.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Please report sensitive issues privately through GitHub's
[Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities)
feature ("Report a vulnerability" on the repository's Security tab). That
creates a private channel between you and the maintainers.

If GitHub advisories are unavailable to you, open a minimal issue that asks a
maintainer to establish a private contact channel - without disclosing the
vulnerability details in public.

Please include:

- the affected component and version (Studio CLI, viewer server, Vault service,
  deployment files);
- a description of the issue and its impact;
- reproduction steps or a proof of concept, if you have one;
- any suggested mitigation.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement | within 3 business days |
| Initial triage and severity assessment | within 7 business days |
| Fix or mitigation plan | depends on severity; critical issues are prioritised |
| Public disclosure | coordinated with the reporter after a fix is available |

We will keep you informed of progress and credit reporters in the advisory
unless you prefer to stay anonymous. There is no bug bounty program.

## Security model and deployment expectations

Understanding the intended trust boundaries helps distinguish a vulnerability
from a misconfiguration:

- **The Studio viewer binds to loopback by default.** `--allow-lan` /
  `SPECVIEWER_BIND` expose it to the network. Run it only on trusted
  development networks, and use `--readonly` when writes are not needed.
- **Vault is intended to run on a private network or behind a TLS-terminating
  reverse proxy.** The bundled Compose stack publishes API, PostgreSQL, MinIO
  and OpenSearch ports on loopback by default. Do not expose port 3460 directly
  to the internet; terminate TLS in front of it if remote clients need access.
- **Vault tokens are passwords.** The API returns a plaintext token once and
  stores only its SHA-256. Keep tokens in a user-scoped file or credential
  store (for example `~/.studio/secrets/`), never in the repository, and
  revoke leaked tokens through `DELETE /api/v1/tokens/:id`.
- **Never enable `VAULT_DEV_SEED` in production.** It creates development
  projects and tokens; production deployments must keep it at `0`.
- **The author is derived from the token.** Clients cannot impersonate another
  author; attempts are rejected with `403` and audited.
- **`.env` files and deployment secrets are out of scope of the repository.**
  All examples contain placeholders only.

## Out of scope

- Vulnerabilities caused by running the software with configuration the
  documentation warns against (for example exposing Vault directly to the
  internet, sharing admin tokens, or disabling the loopback binding on an
  untrusted network).
- Denial of service through deliberately unbounded local file input, or through
  the `memory` store which is explicitly non-durable and development-only.
- Social engineering, physical access and dependency vulnerabilities - the
  runtime has no third-party dependencies, but please report anything that
  looks like a supply-chain concern in the build and deployment files.
