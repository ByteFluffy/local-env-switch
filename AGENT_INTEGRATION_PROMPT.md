# Agent integration prompt

Copy the prompt below into a coding agent when integrating `local-env-switch`
into an existing project.

```text
Integrate local-env-switch into this repository for safe local environment
switching.

Before editing:
- Inspect the repository root, package manager, workspace layout, existing dev
  commands, dotenv loading behavior, and secret-provider configuration.
- Preserve existing behavior and unrelated user changes.
- Use the repository root as the single integration point. Do not edit each
  workspace package's scripts unless I explicitly request it.

Required changes:
- Install local-env-switch as a root development dependency.
- Add a root local-env.config.json using only host-specific environment names,
  required keys, protected keys, Redis keys, and mode overrides that you can
  verify from this repository. Do not invent policy.
- Add root scripts for `local-env-switch use`, `status`, and `guard`.
- Put `guard` immediately before root application startup. Mark a queue runner
  explicitly with `guard --runner`; do not infer runner status.
- Ignore the configured generated env, personal overlay, runtime-ID, and token
  paths. Never commit `.env`, `.env.local`, runtime IDs, tokens, or real secrets.
- Keep local Redis mode as the default. Do not select `--shared-redis` unless I
  explicitly request it.

Safety constraints:
- Never print, log, summarize, copy, or return secret values. Error reports may
  name keys only.
- Do not place protected or policy-owned keys in `.env.local`.
- Do not weaken confirmation environments, inherited-conflict checks, required
  keys, or generated-policy checks to make a command pass.
- Do not force-push, publish a package, or modify remote secret-provider state.

Verification:
- Run the package manager's install/lockfile check.
- Run the host repository's relevant tests and typecheck.
- Run the root switch command for a non-production environment only if suitable
  credentials are already configured.
- Run `local-env-switch status` and `local-env-switch guard` from the repository
  root. Also run `guard --runner` when a runner entry exists.
- Confirm no secret files are tracked and report changed file paths, commands,
  and results without exposing values.

If a required host policy or credential choice cannot be determined from the
repository, stop and ask instead of guessing.
```
