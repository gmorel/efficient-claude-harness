# tests/plugin

`run.mjs` runs the original plugin's hooks against a local Jev stub, in a temp directory with a temp HOME.
`ledger-guard.mjs` and its test check the parity ledger split.
Run `node tests/plugin/run.mjs`. It must exit 0.
