# lib

`shared/` holds files that more than one plugin needs.
A plugin cannot import from a sibling, so `scripts/sync-lib.mjs` copies each file into every plugin that uses it.
Edit the file here, never the copy.
