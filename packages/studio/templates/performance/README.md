# Performance evidence (initial release)

Use the existing game collectors; the adapter accepts a JSON or gzip JSON file containing
`frame_ms` or `post_draw_ms`. It preserves the original bytes and records the selected stream.
A raw import is an observation, never an approved baseline. True 1% low uses the slowest
ceil(N*0.01) frame durations; reciprocal p99 is named separately.

```sh
studio perf import --source frames.json.gz --meta metadata.json --out evidence/new-run --json
studio perf validate --source evidence/new-run --json
studio perf publish --source evidence/new-run --json
studio perf list --limit 50 --offset 0 --json
studio perf show --id <report-uuid> --json
studio perf compare --base <report-uuid> --id <report-uuid> --json
studio perf download --id <report-uuid> --out evidence/new-download --json
studio perf pending --source evidence --json
```

Minimal metadata: `{"case_id":"PF-example","testbed":"machine-name","profile":"observation"}`.
Project identity comes from studio.config.json. For comparable observations also provide actual
case_version, input_hash, config_hash, engine_hash and commit; do not invent missing fingerprints.
The CLI accepts server-only `STUDIO_PERF_TOKEN` or `VAULT_TOKEN`, or the existing token-file
configuration. `VAULT_URL` overrides config.vault.url. No tokens are sent to the browser.

A package has manifest.json plus explicitly listed path/size/sha256 files. The outbox is the
package directory: sync.json records local/pending/complete. Retry `publish` with the same immutable
package. A new capture always uses a new run UUID. Do not edit an already registered manifest.
The server must advertise reportCreateOnly and performanceArtifactIntegrity; old Vault versions
fail closed with vault_upgrade_required. Upgrade Vault before clients.

Uploads register an immutable report, transfer bytes, independently GET every object and verify its
hash, then write a separate deterministic completion receipt. An interrupted attempt remains partial.
`download` requires a new directory, verifies all hashes and writes the original manifest. Do not
pre-register files as stored: a manifest alone is not proof that object bytes exist.

The Studio viewer adds #/performance (runs), /run/<report-uuid>, /compare, /integration and /catalog.
The same-origin API is read-only. Bounded JSON/text preview and binary downloads verify hashes.
Nsight/RenderDoc/ETW formats use their native tools. Unconnected Conbench and undeployed CI are
explicit states. No baseline approval, F3 recording or automatic branch publishing is included here.

For future trusted CI routing, `studio perf issue --id <comparison-report-uuid>` is disabled unless
PERF_AUTO_ISSUE=1, STUDIO_PERF_CI_AUTHORS and CONBENCH_URL are configured. The comparison must
be a Vault report authored by a trusted CI identity, confirmed by Conbench, referencing two complete
independent ABBA sets and five complete controls. An arbitrary local verdict or single observation is
insufficient. The adapter uses existing Vault bug legacy identity and report links, retries safely,
and never closes a bug or merges code. Do not enable it before controlled CI trust is established.

Feature code does not bump package versions. Release a new coordinated @studio/* version after
validation; do not republish a previously released version.

Local preview (source checkout, Node standard library):

```sh
node scripts/performance-preview.mjs --root <project> --capture <existing-frames.json.gz>
```

This starts an isolated, non-durable memory Vault and a loopback-only read-only viewer; it never
writes to production. The UI labels this mode. The original files and local packages stay on disk.
For repeatable browser checks, run scripts/performance-browser-check.mjs with an installed Edge,
PLAYWRIGHT_MODULE pointing to an existing Playwright development installation and
STUDIO_PERF_BROWSER_OUTPUT pointing to an evidence directory. No browser dependency is added to
the runtime. The check covers five views at 390/1440, frame selection, empty/503/403 states.

CI status snapshots use `studio perf integration --source integration.json`. They are stored as
performance-integration reports, retain NOT_RUN/error states and never certify gameplay. The
Studio integration page reads recent snapshots from Vault rather than treating config as a run.
