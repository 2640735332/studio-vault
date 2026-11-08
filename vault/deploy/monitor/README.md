# Optional monitoring helpers

This directory contains two optional helper scripts that connect the Vault
health endpoint to a self-hosted uptime-monitoring service:

| Script | Role |
|---|---|
| `monitor-add-vault.js` | Creates an HTTP monitor for `GET /api/v1/health` (idempotent: an existing monitor is only reported), attaches the default notification and adds it to a status page. |
| `monitor-verify-vault.js` | Checks that the monitor exists and that its latest heartbeat is up. Exit code 0 = up, 2 = down, 1 = error. |

These helpers are **not required** for a Vault deployment and are not part of
the service runtime. The Windows example deploy script can register the monitor
automatically; pass `-SkipMonitor` to omit that step.

## Running

The scripts talk to the monitoring service's local API and reuse the client
library that ships with an existing installation, so point `NODE_PATH` at that
installation's `node_modules` directory and run the scripts with Node.js:

```bash
NODE_PATH=<monitor-install>/node_modules node monitor-add-vault.js
NODE_PATH=<monitor-install>/node_modules node monitor-verify-vault.js
```

The Windows deploy script stages both files into `<VaultHome>\monitor\`, registers the
monitor, and `verify-windows.ps1` checks the registration; you can also run the
scripts by hand as shown above.

Each script documents its environment variables in its header (monitor base
URL, admin credentials file, status page slug/group, Vault URL, timeout). Admin
credentials must live in a file outside the repository; the scripts contain no
token or password.

## Security

- Keep the credentials file out of the repository and restrict its permissions.
- The scripts are idempotent and read-only apart from creating the monitor.
- They are deployment tooling, not part of the Vault service; delete this
  directory if you use a different monitoring system.
