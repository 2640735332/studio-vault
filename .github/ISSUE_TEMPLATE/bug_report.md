---
name: Bug report
about: Report something that does not work as documented
title: "[bug] "
labels: bug
assignees: ""
---

## What happened

<!-- A clear and concise description of the problem. -->

## What did you expect to happen

<!-- What should have happened instead? -->

## Steps to reproduce

1.
2.
3.

## Which component is affected?

- [ ] Studio CLI (`packages/cli`, `packages/studio`)
- [ ] Studio viewer (`studio serve`)
- [ ] Vault service (`vault/src`, REST API)
- [ ] Vault deployment (Compose / Windows example / systemd)
- [ ] Documentation
- [ ] Not sure

## Environment

- Operating system:
- Node.js version (`node --version`):
- Studio package version (`node packages/cli/bin/studio-cli.js --version`):
- Vault version (`GET /api/v1/health`, if relevant):
- How it is started (`studio serve`, `node vault/src/server.mjs`, Docker Compose, ...):

## Logs and evidence

<!--
Paste relevant output. Redact tokens, passwords, private hostnames and paths
before posting. Do not paste a full .env file or a plaintext Vault token.
-->

```text

```

## Additional context

<!-- Anything else that helps: screenshots, config excerpts (redacted), related issues. -->
