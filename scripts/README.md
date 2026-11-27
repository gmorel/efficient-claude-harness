# scripts

- `sync-lib.mjs`: copies `lib/shared/` into the plugins that use it. `--check` fails on drift.
- `run-plugin-tests.mjs`: runs one plugin's tests. `node scripts/run-plugin-tests.mjs plugins/<name>`.
