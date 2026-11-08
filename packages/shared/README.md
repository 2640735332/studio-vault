# @studio/shared

Zero-dependency primitives shared by the Studio packages. Node.js standard
library only - this package has no runtime dependencies and no build step.

## Contents

- **JSON and files** - atomic JSON read/write, text IO, sha256 helpers.
- **git** - a small wrapper around the `git` binary (no shell interpolation).
- **LFS** - Git LFS pointer parsing and detection.
- **tree** - file-tree enumeration with symlink and junction detection.
- **levels** - the `ok` / `degraded` / `fail` check model used by `studio doctor`
  (`degraded` still exits 0).
- **args** - minimal argument parsing for the CLI commands.
- **errors** - the shared error payload shape (`code`, `message`, `hint`).

```js
import { git, readLfsPointer, evaluateChecks } from '@studio/shared';
```

## Design notes

- Everything here must stay generic: no file-system layout assumptions, no
  command behaviour, no viewer logic. Those live in `@studio/local`.
- New helpers need a `node:test` suite and must run on Node.js 22.5+.
- The package is published from this monorepo; the repository's
  `scripts/verify-packages.mjs` checks that the packed tarball can be imported.
