# Vault direct-report API contract

Status: implemented in Vault **0.1.2**. All changes are additive on top of
`/api/v1`: optional fields and new endpoints only, existing clients keep
working. Breaking changes would ship under a new API version.

Base URL: `http://127.0.0.1:3460` by default (set `VAULT_BIND` / `VAULT_PORT`
to change it). Examples use the project `demo-project` and a game with an
8-digit in-game bug id.

## 1. Authentication, project and author

| Item | Rule |
|---|---|
| Header | `Authorization: Bearer vt_<id>_<secret>` (or `X-Vault-Token` with the same value). |
| Project | **Derived from the token scope.** A single-project token needs no project parameter. A multi-project token must send `X-Vault-Project: <project>` (or `?project=`), otherwise `400 bad_request`. |
| Role | Writes (POST / PATCH / PUT / links / token administration) require `writer`; reads and downloads accept `reader` or `writer`. Token administration requires `admin`. |
| Author | **Derived from the token** (`author=token:<label>`). Clients must not send `author` / `updatedBy` in the body, headers or query - doing so returns `403 author_forged` and is audited. Reporter identity goes into `payload.reporter`. |
| Transport | HTTP on the private network; put a TLS-terminating proxy in front of it if remote clients need access. Tokens are passwords: read them from environment variables or files, never log or print them. |

## 2. `POST /api/v1/bugs` - direct report (idempotent)

### 2.1 Top-level fields

| Field | Type | Required | Notes / enum |
|---|---|---|---|
| `legacyId` | string(1..64) | yes | In-game 8-digit id; **idempotency key** = `(project, legacyId)`. If it exists, the API returns **200** with the existing bug (`created:false`) and does not insert or update. |
| `title` | string(1..400) | yes | Title. |
| `status` | enum | no | `new` (default) / `triaged` / `in_progress` / `fixed` / `closed` / `duplicate` / `wontfix` / `cannot_reproduce` / `false_red`. |
| `severity` | enum | no | `low` / `medium` (default) / `high` / `critical`. |
| `priority` | enum | no | `P0` / `P1` / `P2` / `P3`; lower case is normalised; un-triaged is null. |
| `repo` | string(<=200) | no | Repository name; defaults to `demo-project`. |
| `branch` | string(<=200) | no | Code branch captured by the build. |
| `commitSha` | string(7..64 hex) | no | HEAD commit at report time (short or long). |
| `worktree` | string(<=200) | no | Worktree / test-machine identifier. |
| `sourceTrack` | string(<=200) | no | Source track, for example `track-stone-age-release`. |
| `assignee` | string(<=200) | no | Triage / fix owner. |
| `resolution` | string(<=400) | no | Close reason / conclusion (detail). |
| `payload` | object | yes (direct report) | Extension fields, see 2.2. Unknown keys are preserved for forward compatibility. |

### 2.2 `payload` extension fields (all optional; unknown keys are preserved)

| Field | Shape | Notes |
|---|---|---|
| `description` | string(<=8000) | Description (may be empty, but should not be). |
| `reproducedAt` | ISO string | Reproduction time. |
| `rawStatus` | string | Original status text (importer use). |
| `history` | string[] | History bullets (`- [ISO] ...`). |
| `readmeFields` | object | Full Readme field set (import compatibility; clients may omit). |
| `build` | object | `{commit, branch, version, milestone, engine:{name,version,build}, os:{name,version,arch}, hw:{cpu,gpu,vendor,driver,ram_gb}}`. |
| `steps` | array | `[{id?, text, expect?, actual?}]` (at most 200 steps). |
| `worldState` | object | `{seed, slot, saveMtime, scene, chunk:{x,y}, player:{x,y}, camera:{x,y,zoom}, time:{hour,day,paused}, weather, loadedChunks}`. |
| `reproRate` | object | `{frequency: always|often|sometimes|rare|unknown, attempts: int>=0, lastSeen?: ISO}`. |
| `reporter` | object | `{id?, name?, source: f3|e2e|agent|api|import}` - identity, not authentication. |
| `caseContext` | object | `{case_id, case_sha?, session_id?, file?, step?, atom?, checkpoint?: bool, assertions?: string[], expected?: {current_section?, fr?, ac?}, report_bundle?}`. |
| `domain` | string | Domain id (for example `presentation`). |
| `dataGaps` | string[] | **Read only**: computed by the server / importer for legacy packages; client values are ignored. |

### 2.3 Request example

```json
{
  "legacyId": "88067018",
  "title": "Clinic UI does not follow the building anchor",
  "status": "new",
  "severity": "medium",
  "priority": "P2",
  "repo": "demo-project",
  "branch": "feat/game-001",
  "commitSha": "33ed4e9a6",
  "worktree": "demo-worktree",
  "sourceTrack": "track-stone-age-release",
  "payload": {
    "description": "The clinic build menu stays in the centre of the screen instead of following the building anchor.",
    "reproducedAt": "2026-11-01T17:30:00",
    "build": {
      "commit": "33ed4e9a6", "branch": "feat/game-001", "version": "0.1.0", "milestone": "M1",
      "engine": { "name": "Godot", "version": "4.5-stable" },
      "os": { "name": "Windows", "version": "10.0.26200", "arch": "x86_64" },
      "hw": { "cpu": "AMD Ryzen 9 7950X", "gpu": "NVIDIA GeForce RTX 5080", "vendor": "NVIDIA", "driver": "610.88" }
    },
    "steps": [
      { "id": "1", "text": "Open the build menu", "expect": "The menu appears" },
      { "id": "2", "text": "Select the clinic and place it", "expect": "A placement preview appears", "actual": "The UI stays in the centre" }
    ],
    "worldState": { "seed": "123456", "slot": "save_01", "scene": "Main",
                    "chunk": { "x": 61, "y": 26 }, "player": { "x": 1975.0, "y": 863.3 },
                    "camera": { "x": 1975.0, "y": 834.4, "zoom": 1.75 },
                    "time": { "hour": 9.2, "day": 3, "paused": false },
                    "weather": "clear", "loadedChunks": 49 },
    "reproRate": { "frequency": "always", "attempts": 3, "lastSeen": "2026-11-01T17:29:00" },
    "reporter": { "id": "tester-01", "name": "QA-01", "source": "f3" },
    "domain": "presentation"
  }
}
```

### 2.4 Responses and errors

- **201 Created**: `{"project":"demo-project","created":true,"bug":{...}}`
- **200 OK** (idempotent hit): `{"project":"demo-project","created":false,"idempotent":true,"bug":{...}}`
- **400** `bad_request` - invalid type / enum / length; `error.details.field` names the field.
- **401** `unauthorized` - missing, invalid or revoked token.
- **403** `project_forbidden` / `insufficient_role` / `no_project_scope` / `author_forged`.
- **413** `payload_too_large` - JSON body larger than `VAULT_MAX_BODY_BYTES` (default 4 MB).
- **500** `internal_error`.
- Error body: `{"error":{"code","message","request_id","details?"}}`.

## 3. `PATCH /api/v1/bugs/:id` - triage, status and verification evidence

- Writable top-level fields: `title/status/severity/priority/assignee/sourceTrack/resolution/branch/commitSha/repo/worktree`.
- `payload` is **shallow-merged**: only the submitted sub-keys are replaced; a `null` value deletes a key; omitted sub-keys are kept. This lets a client report the fields first and add verification evidence later.
- Optimistic locking: send `If-Match: <version>` or `ifVersion` in the body. A mismatch returns **`409 version_conflict`** with the current bug in `error.current`.
- Status changes append an audit event (`bug.update`) and a line to `payload.history` (`- [ISO] <status>: <reason>`; pass `historyNote` as the reason).
- **Verification evidence** (written by the fix/review side) goes into `payload.verification`:

  ```json
  {
    "result": "fixed|false_red|duplicate|cannot_reproduce|design_followup",
    "commit": "...",
    "branch": "...",
    "commands": ["node --test"],
    "e2e": { "case_id": "...", "case_sha": "...", "passed": "11/11", "report_bundle": "..." },
    "closed_reason": "...",
    "at": "2026-11-01T18:00:00Z",
    "by": "dev-a"
  }
  ```

  Example: `PATCH /api/v1/bugs/<uuid>` with
  `{"status":"fixed","priority":"P1","assignee":"dev-a","payload":{"verification":{...}}}`.

## 4. Evidence files (report, upload, link)

Required evidence for a report: `Readme.md`, the logs (`log-*.jsonl`) and every screenshot. End-to-end runs additionally upload `report.json` and the engine log (optional: a screenshots directory).

1. **Create a report**

   ```json
   POST /api/v1/reports
   {"kind":"bug-package","title":"<title>",
    "payload":{"legacyId":"88067018","worktree":"demo-worktree",
               "sourcePath":"game/reports/bugs/bug-20261101-120000-88067018"}}
   ```

   -> **201** `{"project","report":{"id",...},"files":[]}`. Keep `report.id`.

2. **Upload files** - `PUT /api/v1/reports/:id/files?path=<url-encoded-relative-path>&role=<readme|log|screenshot|attachment>`
   - Body: raw bytes, `Content-Type: application/octet-stream`. The server computes sha256 and size, writes the object store and `report_files`.
   - Role defaults to an extension-based guess (`.md` -> readme, `.jsonl/.log/.txt` -> log, images -> screenshot, else attachment).
   - Response **201** `{"project","reportId","file":{"path","sha256","sizeBytes","role"},"created":true}`; re-uploading the same path with the same content returns **200** `created:false`.
   - Limits: one file up to `VAULT_MAX_UPLOAD_BYTES` (default 64 MB); over the limit -> **413** `payload_too_large`.

3. **Link the report to the bug** - `POST /api/v1/links` with
   `{"reportId":"<uuid>","bugId":"<uuid>","role":"evidence"}` -> **201** (duplicate -> 200).

4. (Optional) `PATCH /api/v1/bugs/:id` with
   `{"payload":{"evidence":{"reportIds":["<reportId>"]}}}` so a detail page can show the evidence directly.

## 5. Read-back and download

| Endpoint | Description |
|---|---|
| `GET /api/v1/bugs?limit&offset&status` | List; `items[]` contains full bugs (top-level fields + payload); `total`. |
| `GET /api/v1/bugs/:id`; `/bugs/by-legacy/:legacyId` | Single bug (detail page / client read-back). |
| `GET /api/v1/reports/:id` | Report + `files[]` (path / sha256 / sizeBytes / role). |
| `GET /api/v1/reports/:id/file?path=<url-encoded>` | Raw file stream (`Content-Type` by extension, `X-Vault-Content-Sha256` response header); `404 not_found`. |
| `GET /api/v1/audit?action=bug.update&entity=bug&entity_id=<id>` | Audit events. |
| `GET /api/v1/health` | Counts (bugs / reports), version, migration state. |

`dataGaps` on `GET /api/v1/bugs`: when a payload has no explicit
`dataGaps`, the server computes the list of missing fields (for example
`branch`, `commitSha`, `build`, `env`, `repro`, `steps`,
`worldState`, `caseContext`, `sourceTrack`); legacy packages therefore show
their gaps. An explicit value wins.

## 6. Audit events

The following actions append an `audit_events` row (actor / action / entity /
entityId / statusCode / before / after / details / requestId):
`bug.create`, `bug.create.idempotent`, `bug.update`,
`bug.status_change`, `report.create`, `report.file.upload`,
`report.link`, `auth.denied`, `auth.forged_author_rejected`. The importer
adds `bug.import` / `report.import` (or a run-level `import.run`
summary).

## 7. Error codes

| HTTP | Code | Scenario |
|---|---|---|
| 400 | `bad_request` | Field validation / invalid JSON / multi-project token without a project. |
| 401 | `unauthorized` | Missing, malformed, invalid or revoked token. |
| 403 | `project_forbidden` / `insufficient_role` / `no_project_scope` / `author_forged` | Out of scope / role too low / token without a project / client-supplied author. |
| 404 | `not_found` | Bug / report / file does not exist. |
| 409 | `version_conflict` | Optimistic-lock mismatch (`error.current` returns the current version). |
| 413 | `payload_too_large` | JSON body or single file over the limit. |
| 500 | `internal_error` | Server error (`request_id` available for log lookup). |

## 8. Client conventions

- Read the endpoint and credentials from environment variables:
  `VAULT_URL` and a token file (for example `VAULT_WRITER_TOKEN_FILE`); never
  hard-code a token in source or logs.
- On submit failure, write the package to a local pending directory (Readme,
  screenshots, logs and the payload JSON) and retry with exponential backoff. If
  the in-game id was already generated, retry with the same `legacyId` - the
  server's idempotency returns 200 instead of creating a duplicate.
- Suggested first integration order: `POST /bugs` (fields only) ->
  `GET /bugs/by-legacy/:legacyId` to confirm -> report upload -> link -> read back
  the report.
- End-to-end runners can pass structured `caseContext` so that failures link
  back to the test case that produced them.

## 9. Migrations and legacy data

- Migration `007_bug_priority.sql` adds the nullable `priority` column
  (check P0..P3); existing rows stay null and payloads are not rewritten.
- Legacy packages are not migrated speculatively: the API computes `dataGaps`
  and the importer can backfill the recoverable fields, which reduces the gap
  list over time.
- All other new fields live in the `payload` jsonb column, so there is no
  schema break for existing clients.
