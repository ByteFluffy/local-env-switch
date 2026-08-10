# Basic CLI integration

This example shows a single root-level integration. It does not contain secrets
or modify scripts in workspace packages.

1. Copy `local-env.config.json`, `package.json`, and `app.mjs` into a new project.
2. Copy `.env.local.example` to `.env.local` only when personal, non-protected
   overrides are needed.
3. Install dependencies and authenticate the Infisical CLI.
4. Provide the project context through `INFISICAL_PROJECT_ID`, `.infisical.json`,
   or `infisical.projectId` in the config.
5. Switch and inspect the generated environment from the project root.

```bash
npm install
export INFISICAL_PROJECT_ID=replace-with-your-project-id
npm run switch:env -- development
npm run switch:env:status
npm run dev
```

The generated `.env`, `.env.local`, and `.env.runtime-id` must remain ignored.
Local Redis mode is the default; the example does not start or probe Redis.

See the package [README](../../README.md) for authentication precedence, shared
Redis mode, runner guards, and the complete configuration reference.
