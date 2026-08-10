# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development

Use Node.js 20.12 or newer, then install dependencies and run every verification
gate before opening a pull request:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Keep changes focused and include regression tests for behavior changes. Do not
include real secrets, generated `.env` files, personal overlays, runtime IDs, or
authentication tokens in commits or test fixtures.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow
[`SECURITY.md`](./SECURITY.md) instead.
