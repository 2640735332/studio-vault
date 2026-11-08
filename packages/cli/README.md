# @studio/cli

The command-line entry point for Studio. It parses and dispatches arguments to
`@studio/local`; it contains no behaviour of its own.

- Source checkout: `node packages/cli/bin/studio-cli.js <command>` works without
  `npm install` (the entry falls back to the vendored `@studio/local`).
- Installed (npm or workspace link): the `studio-cli` executable is provided by
  this package.
- Help: `studio-cli --help` lists every command and flag.
