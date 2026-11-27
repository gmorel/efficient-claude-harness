# .github

`workflows/plugins.yml` validates and tests every plugin on each push and pull request.
It runs `claude plugin validate`, then `scripts/run-plugin-tests.mjs`, and checks that the shared lib copies have not drifted.
