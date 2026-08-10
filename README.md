# local-env-switch

Generic Infisical-backed local environment switcher for Node.js projects. It
exports secrets, merges a safe personal overlay, applies host-defined policy,
and atomically replaces a private generated `.env` file.

The package contains no project environment names, service domains, or business
key policy. Each host owns those choices in JSON configuration.

## Requirements

- Node.js 20.12 or newer
- An [Infisical CLI](https://infisical.com/docs/cli/overview) compatible with the
  target Infisical server
- A project ID or compatible `.infisical.json` project context
- Infisical login state, `INFISICAL_TOKEN`, or `infisical.tokenFile`

Check the installed CLI before switching:

```bash
infisical --version
infisical login
```

The current maintainer smoke test covers Infisical CLI 0.31.9 against its
configured self-hosted server. Other CLI/server combinations must be verified by
the host. The configured domain is passed to the CLI unchanged apart from
trailing slash removal; some older self-hosted combinations require an explicit
`/api` suffix. See the official
[`export` command](https://infisical.com/docs/cli/commands/export) documentation.

## Quick start

Install the development dependency:

```bash
pnpm add -D local-env-switch
npm install --save-dev local-env-switch
yarn add --dev local-env-switch
```

Ignore all generated and personal files:

```gitignore
.env
.env.local
.env.runtime-id
.secrets/infisical-token
```

If custom paths are configured, ignore those actual generated, overlay,
runtime-ID, and token files instead.

Create `local-env.config.json` in the project root:

```json
{
  "environments": ["development", "production"],
  "confirmEnvironments": ["production"],
  "infisical": {
    "domain": "https://secrets.example.com",
    "projectId": "your-project-id"
  },
  "requiredKeys": ["DATABASE_URL"]
}
```

Add host scripts:

```json
{
  "scripts": {
    "switch:env": "local-env-switch use",
    "switch:env:status": "local-env-switch status",
    "switch:env:guard": "local-env-switch guard",
    "dev": "local-env-switch guard && node ./src/server.js",
    "worker:dev": "local-env-switch guard --runner && node ./src/worker.js"
  }
}
```

Do not name the host script `env`; `pnpm env` is a pnpm built-in command.

Run the CLI from the project root because configuration discovery starts at the
current working directory:

```bash
pnpm switch:env development
pnpm switch:env:status
pnpm dev

npm run switch:env -- development
npm run switch:env:status
```

The first switch uses local Redis mode. Production confirmation fails unless the
caller passes `--yes`:

```bash
pnpm switch:env production --yes
```

## Examples and agent integration

[`examples/basic`](./examples/basic) contains a minimal host project with root
scripts, a safe configuration, and a non-secret personal-overlay template.

If an AI coding agent will perform the integration, give it
[`AGENT_INTEGRATION_PROMPT.md`](./AGENT_INTEGRATION_PROMPT.md). The prompt keeps
the change at the host project root, forbids secret exposure, and requires the
same status and guard checks documented here.

## Configuration

The default file name is `local-env.config.json`. The alias
`local-env-switch.config.json` is also supported; when both exist, the shorter
name wins. Relative paths are resolved from `projectRoot`, which defaults to the
current working directory.

`environments` must be present in JSON. The Infisical domain must come from
`infisical.domain`, `INFISICAL_API_URL`, or `INFISICAL_DOMAIN`. A usable export
also needs project context from `infisical.projectId`, `INFISICAL_PROJECT_ID`, or
the `workspaceId`/`projectId` in `.infisical.json` unless the installed CLI
provides compatible context itself.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `environments` | `string[]` | required | Allowed Infisical environment slugs. |
| `confirmEnvironments` | `string[]` | `[]` | Require `--yes` or `yes: true`. |
| `warnEnvironments` | `string[]` | `[]` | Print a CLI warning before switching. |
| `infisical.domain` | `string` | environment fallback | HTTP(S) domain or API base passed to the CLI. |
| `infisical.projectId` | `string` | environment/file fallback | Infisical project or workspace ID. |
| `infisical.tokenFile` | `string` | none | Private token file path. |
| `paths.env` | `string` | `.env` | Generated dotenv target. |
| `paths.localEnv` | `string` | `.env.local` | Optional personal overlay. |
| `paths.runtimeId` | `string` | `.env.runtime-id` | Stable local runtime identity. |
| `requiredKeys` | `string[]` | `[]` | Keys that must be non-empty after policy. |
| `protectedKeys` | `string[]` | `[]` | Exact keys forbidden in personal overrides. |
| `protectedKeyPatterns` | `string[]` | `[]` | Regular expressions for protected keys. |
| `inheritedIgnoreKeys` | `string[]` | `[]` plus built-ins | Skip named shell variables during conflict checks. |
| `localRedis.url` | `string` | `redis://127.0.0.1:6379` | Value forced into local Redis keys. |
| `localRedis.keys` | `string[]` | `[]` | Keys forced to `localRedis.url` in local mode. |
| `localModeOverrides` | `Record<string, string>` | `{}` | Local-only authoritative values. |
| `sharedModeOverrides` | `Record<string, string>` | `{}` | Shared-mode authoritative values. |
| `localModeDeleteKeyPrefixes` | `string[]` | `[]` | Literal key prefixes removed in local mode. `*` has no special meaning. |
| `toolName` | `string` | `local-env-switch` | Generated header identity. Changing it invalidates the old header. |

The built-in inherited-variable exclusions are Infisical control variables:
`INFISICAL_API_URL`, `INFISICAL_CUSTOM_HEADERS`,
`INFISICAL_DISABLE_UPDATE_CHECK`, `INFISICAL_DOMAIN`,
`INFISICAL_PROJECT_ID`, and `INFISICAL_TOKEN`. Add custom exclusions only for
tool-control variables that must not be compared with generated app settings;
this option deliberately bypasses one guard check.

Token lookup order is `INFISICAL_TOKEN`, configured `infisical.tokenFile`, the
CLI login token file, then the CLI's own login state. Tokens are passed through
the child-process environment and never placed in process arguments. An empty,
missing, or unreadable configured token file currently falls through to the next
source; configuring a file does not force that identity exclusively.

### Full policy example

```json
{
  "environments": ["development", "staging", "production"],
  "confirmEnvironments": ["production"],
  "warnEnvironments": ["staging", "production"],
  "infisical": {
    "domain": "https://secrets.example.com",
    "projectId": "your-project-id",
    "tokenFile": ".secrets/infisical-token"
  },
  "paths": {
    "env": ".env",
    "localEnv": ".env.local",
    "runtimeId": ".env.runtime-id"
  },
  "requiredKeys": ["DATABASE_URL"],
  "protectedKeys": ["DATABASE_URL", "CACHE_URL", "RUNTIME_SCOPE"],
  "protectedKeyPatterns": ["_TOKEN$"],
  "localRedis": {
    "url": "redis://127.0.0.1:6379",
    "keys": ["CACHE_URL"]
  },
  "localModeOverrides": {
    "RUNTIME_SCOPE": "{env}-{runtimeId}"
  },
  "sharedModeOverrides": {
    "RUNTIME_SCOPE": "{env}"
  },
  "localModeDeleteKeyPrefixes": ["REMOTE_QUEUE_"],
  "toolName": "local-env-switch"
}
```

`{env}` is available in both override maps. `{runtimeId}` is available in local
mode. A private runtime ID is created and reused only when a local override uses
that placeholder.

## CLI reference

```bash
local-env-switch use <environment> [--shared-redis] [--yes]
local-env-switch status
local-env-switch guard [--runner]
```

The block above is command syntax. For a locally installed development
dependency, invoke the bin through the package manager or the scripts from Quick
start:

```bash
pnpm exec local-env-switch use development
npm exec -- local-env-switch status
yarn exec local-env-switch guard
```

### `use`

`use` reads configuration and `.env.local`, exports Infisical secrets, applies
the selected mode policy, checks inherited shell conflicts, and atomically
replaces `.env` with mode `0600`.

Local mode is the default. `--shared-redis` explicitly selects shared mode. The
package rewrites only configured environment keys: it does not install, start,
stop, ping, or otherwise inspect a Redis server.

The local-mode order is:

1. merge `preset < secrets < .env.local`;
2. delete keys matching configured literal prefixes;
3. force `localRedis.keys` to `localRedis.url`;
4. apply `localModeOverrides`;
5. validate required keys and the resulting policy.

Shared mode merges the same inputs, applies `sharedModeOverrides`, and validates
required keys. It does not perform local deletion or force Redis keys.

### `status`

`status` reads only local configuration and files. It reports environment and
mode, lists protected personal keys, inherited shell conflicts, and generated
policy drift, and exits with status 1 when any are present. It does not contact
Infisical, compare against the latest remote secrets, or test Redis connectivity.

### `guard`

`guard` performs the same static checks and exits 1 on failure. Put it directly
before the application command so a stale or unsafe `.env` cannot start the
process.

`guard --runner` additionally blocks startup when the generated file selects
shared Redis. The caller must mark a queue consumer or worker explicitly; the
package does not auto-detect runners.

Both commands fail for a missing or invalid generated header, invalid dotenv,
protected `.env.local` keys, conflicting inherited values, and generated policy
drift. They do not retrieve secrets or modify files.

## Personal overrides and safety policy

`.env.local` is optional and may contain safe developer-specific values:

```dotenv
LOG_LEVEL=debug
FEATURE_PREVIEW=true
```

Keys matching `protectedKeys` or `protectedKeyPatterns` are rejected. Keys owned
by local Redis, either mode override map, or a local deletion prefix are
protected automatically, so safety does not depend on repeating them in
`protectedKeys`.

The guard rejects inherited protected values that differ from the generated
file. Error output contains key names, never secret values.

## Programmatic API

```ts
import {
  assertGuard,
  getStatus,
  resolveConfig,
  useEnvironment,
} from 'local-env-switch';

const switched = await useEnvironment({ environment: 'development' });
console.log(switched.environment, switched.envPath);

const status = await getStatus();
await assertGuard({ runner: true });

const config = resolveConfig({ projectRoot: process.cwd() });
await useEnvironment({
  config,
  environment: 'development',
  inheritedEnv: {},
  secrets: { DATABASE_URL: 'postgres://localhost/app' },
});
```

`UseEnvironmentInput` accepts:

- `environment` (required), `sharedRedis`, and `yes`;
- either a resolved `config` or a `projectRoot` used for discovery;
- `secrets` to bypass the Infisical export for an alternative provider or test;
- `inheritedEnv` to make shell-conflict checks deterministic.

Even when `secrets` is supplied, configuration resolution still requires an
Infisical domain because the current config model is not provider-neutral.

`useEnvironment()` returns only the selected environment, mode, and output path.
It deliberately does not return the generated secret map.

The package root also exports `buildEnvironment`, `inspectEnvironment`,
`isProtectedEnvKey`, `exportInfisicalSecrets`, `parseDotEnv`,
`serializeGeneratedEnv`, `parseGeneratedHeader`, `findConfigPath`,
`atomicWritePrivateFile`, `getOrCreateRuntimeId`, and
`readOptionalFile`. Several of these return or accept secret-bearing values and
must follow the same no-logging rule. The exported types are `LocalEnvConfig`,
`LocalEnvConfigFile`, `UseEnvironmentInput`, `UseEnvironmentResult`,
`StatusResult`, `GuardInput`, and `EnvironmentBuild`.

All high-level APIs throw on invalid configuration, failed export, parse errors,
policy violations, or file-system errors. They do not swallow a failed switch.

## Dotenv compatibility

Environment keys are limited to portable names matching
`[A-Za-z_][A-Za-z0-9_]*`; `__proto__` is rejected explicitly across supported
Node versions. Generated values must fit the package's conservative dotenv
encoding. Values containing NUL, carriage return, `$`, or combinations that
cannot be represented safely with one quote style are rejected before `.env` is
replaced. If a secret uses an unsupported value, change its representation or do
not use this package until the encoder supports it.

## Troubleshooting

| Error or symptom | Recovery |
| --- | --- |
| No local-env config found | Run from the project root or pass `projectRoot`/`config`. |
| Infisical export failed | Check `infisical --version`, login/token, domain form, project ID, environment slug, and CLI/server compatibility. |
| Protected keys are not allowed in `.env.local` | Remove the listed keys from the personal overlay; define them in Infisical or mode policy. |
| Conflicting inherited environment keys | Unset the listed shell variables before switching or starting the app. |
| Generated `.env` violates configured policy | Do not edit generated output; rerun `local-env-switch use <environment>`. |
| Root `.env` is missing or has an invalid generated header | Rerun `use`; changing `toolName` intentionally invalidates an older header. |
| Invalid runtime ID file | Delete the configured runtime-ID file and rerun `use`. It contains no secret. |
| `ENOENT` for a custom nested path | Create the parent directory first; the package does not create configured parent directories. |
| Dotenv value cannot be represented portably | Remove unsupported characters or wait for encoder support; the previous `.env` remains. |

Export, parsing, policy, and serialization failures happen before the final
temporary-file rename, so the previous generated `.env` is preserved. A runtime
ID may be created before a later check fails. Concurrent valid switches are not
locked; the last atomic rename wins.

## Design

The [design document](./DESIGN.md) contains layered and safety architecture
diagrams, switch and guard sequences, trust boundaries, invariants, and
concurrency behavior.

## Maintainer verification and release policy

Run the release gates in order:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack
```

Then inspect the tarball manifest, install the tarball in an empty project, and
smoke-test both a pure Node.js ESM import and the installed CLI. Run
`npm audit --omit=dev` before publishing. Do not publish when any gate fails.

Published files are limited to `dist`, the basic example, the agent integration
prompt, this README, `DESIGN.md`, the license, and package metadata. Consumers do
not need `tsx` or TypeScript. The package is ESM-only, supports Node.js 20.12 or
newer, and has no CommonJS `require` entry.

During the `0.x` series, incompatible public API changes may ship in a minor
release and must be called out in release notes. Stable releases should use the
default npm tag; prereleases should use an explicit prerelease version and tag.

Source code and issue tracking are hosted on
[GitHub](https://github.com/ByteFluffy/local-env-switch). Report vulnerabilities
through the repository's private security reporting flow as described in
[`SECURITY.md`](https://github.com/ByteFluffy/local-env-switch/blob/main/SECURITY.md).
