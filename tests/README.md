# tests

- `plugin/`: checks of the original plugin's hooks. Needs only node and git.
- `parity/`: compares those hooks to the owner's originals. Owner only: exits 3 without them.
- `lib-sync.test.mjs`: fails when a shared lib copy has drifted.
- `harness-config.test.mjs`: the engine config.

Each small plugin keeps its own tests in `plugins/<name>/tests/`.
