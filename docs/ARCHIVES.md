# Permanent workspace archives

Use `studio archive` for source material, saves, captures and local work that must survive
workspace cleanup. Git remains authoritative for code and specification documents. Rebuildable
engine imports, package caches and downloaded toolchains do not need archival.

Configure `vault.url` and `project.id` in the normal Studio config. Store a project-scoped writer
token outside repositories at `~/.studio/secrets/vault-writer-token.txt`, or set
`STUDIO_VAULT_WRITER_TOKEN_FILE`. Reader-only clients can use `STUDIO_VAULT_READER_TOKEN_FILE`.

Create a selection JSON with `root`, `label`, `files` (relative paths) and optional `metadata`:

```json
{"root":"<source-directory>","label":"asset-source-before-cleanup","files":["models/source.blend","notes.md"],"metadata":{"commit":"<git-sha>"}}
```

```sh
studio archive upload --source <selection.json> --id <uuid> --cwd <game-repository>
studio archive list --cwd <game-repository>
studio archive search --query source.blend --cwd <game-repository>
studio archive show --id <uuid> --cwd <game-repository>
studio archive download --id <uuid> --file models/source.blend --out <new-directory> --cwd <game-repository>
```

Omit `--file` to restore the whole archive. Upload never removes source files. Keep its returned
`vault://<project>/reports/<uuid>` URI in the related spec, bug or performance investigation;
the report UUID also works with the existing report/bug links API. Verify an actual restore
before deleting an original. Record excluded caches and any source changes separately.

`studio-archive/v1` stores a gzip JSON index plus bounded gzip packs in existing authenticated
Vault report/file APIs, under kind `workspace-archive`. The index records original paths, SHA-256,
sizes, timestamps and pack segments. Packs contain at most 16 MiB before compression; large
files span packs. Every uploaded object is independently downloaded and SHA-256 checked before
`complete.json` seals the archive. Interrupted uploads remain incomplete and can be retried with
the same selection and UUID. Search ignores incomplete uploads. Completed archives cannot be
overwritten by this client. Download uses a new destination and verifies every restored file.

Workspace archives are permanent: automatic report expiration excludes this kind in both stores.
Cold-tier metadata may still change. Explicit administrator deletion is separate from retention.
Credential-looking paths, symlinks and unsafe Windows paths are rejected. Secrets belong in
protected host credential storage, never in archive selections or Git.

Vault rejects file downloads when stored bytes fail their registered SHA-256. Repeating an
identical upload restores missing object bytes without changing the file identity. Interrupted
archive uploads revalidate existing packs and re-upload missing objects. A disk that changes
verified bytes must be taken out of active storage; retain originals and restore from verified
copies before any cleanup.

For a sealed archive whose object backup is incomplete, retain the previously downloaded
manifest and original files, then run `studio archive repair --id <uuid> --source <saved-manifest.json>
--root <original-directory>`. The saved manifest must match the service's registered SHA-256,
and regenerated packs must match it byte for byte; changed sources are rejected. Repair restores
missing objects through authenticated uploads and renews the verification seal without changing
the archived file contents. Quarantine known corrupt objects during storage recovery first.

For filesystem deployments, set `VAULT_OBJECTS_DIR` to a large data disk while keeping PostgreSQL
on the database disk. Stop the writer during final copy and hash verification, retain the old
store for rollback, restart and verify an authenticated upload/download. Include the new object
root in host backup sources; moving objects alone does not move or recreate their metadata.
