# Summary

<!-- What does this pull request change, and why? Link the issue it fixes. -->

Refs:

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Behaviour change (documented in CHANGELOG.md)
- [ ] Refactor / internal cleanup
- [ ] Documentation
- [ ] CI / release tooling

## Affected area

- [ ] Studio CLI / runtime (`packages/studio`, `packages/shared`, `packages/cli`)
- [ ] Studio viewer / front end
- [ ] Vault service (`vault/src`, `vault/migrations`)
- [ ] Vault deployment / scripts
- [ ] Documentation

## How was this tested?

<!--
List the exact commands you ran and their results. For viewer changes add a
screenshot or short recording (before/after). For Vault changes mention whether
you used the memory driver, PostgreSQL, or the selftest.
-->

```bash
npm test
npm run verify:packages
cd vault && node scripts/vault-selftest.mjs --driver memory
```

## Checklist

- [ ] No runtime npm dependency was added (zero-dependency rule).
- [ ] New behaviour is covered by a `node:test` test (or the reason it cannot be is explained).
- [ ] Existing tests were not weakened to make CI green.
- [ ] Migrations are append-only; no applied migration file was edited.
- [ ] No credentials, `.env` files, tokens, dumps or evidence archives are included.
- [ ] User-visible changes are reflected in `CHANGELOG.md` (and the docs where relevant).
- [ ] Documentation is in English, and bilingual entry points stay in sync.
