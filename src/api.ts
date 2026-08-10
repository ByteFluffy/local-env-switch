import { randomBytes } from 'node:crypto';
import { resolveConfig } from './config.js';
import { buildEnvironment, inspectEnvironment, isProtectedEnvKey } from './compose.js';
import {
  assertBoolean,
  normalizeStringRecord,
  assertString,
  serializeGeneratedEnv,
} from './dotenv.js';
import { parseDotEnv } from './dotenv.js';
import {
  atomicWritePrivateFile,
  getOrCreateRuntimeId,
  readOptionalFile,
} from './files.js';
import { exportInfisicalSecrets } from './infisical.js';
import type {
  GuardInput,
  LocalEnvConfig,
  StatusResult,
  UseEnvironmentInput,
  UseEnvironmentResult,
} from './types.js';

export type { LocalEnvConfig, LocalEnvConfigFile, UseEnvironmentInput, UseEnvironmentResult, StatusResult, GuardInput, EnvironmentBuild } from './types.js';
export { resolveConfig, findConfigPath } from './config.js';
export { buildEnvironment, inspectEnvironment, isProtectedEnvKey } from './compose.js';
export { exportInfisicalSecrets } from './infisical.js';
export { parseDotEnv, serializeGeneratedEnv, parseGeneratedHeader } from './dotenv.js';
export {
  atomicWritePrivateFile,
  getOrCreateRuntimeId,
  readOptionalFile,
} from './files.js';

function assertNoKeys(label: string, keys: readonly string[]): void {
  if (keys.length > 0) throw new Error(`${label}: ${keys.join(', ')}`);
}

function getConfig(input?: { config?: LocalEnvConfig; projectRoot?: string }): LocalEnvConfig {
  return input?.config ?? resolveConfig({ projectRoot: input?.projectRoot });
}

/**
 * Switch local environment: Infisical export → merge → write root .env.
 * Public API for any host project / agent.
 */
export async function useEnvironment(
  input: UseEnvironmentInput,
): Promise<UseEnvironmentResult> {
  assertString(input.environment, 'environment');
  if (input.yes !== undefined) assertBoolean(input.yes, 'yes');
  if (input.sharedRedis !== undefined) {
    assertBoolean(input.sharedRedis, 'sharedRedis');
  }
  const suppliedSecrets = input.secrets === undefined
    ? undefined
    : normalizeStringRecord(input.secrets, 'secrets');

  const config = getConfig(input);
  const environment = input.environment.trim();
  if (!config.environments.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Allowed: ${config.environments.join(', ')}`,
    );
  }
  if (config.confirmEnvironments.includes(environment) && !input.yes) {
    throw new Error(
      `${environment} requires confirmation. Pass yes: true or CLI --yes.`,
    );
  }

  const localEnvSource = await readOptionalFile(config.localEnvPath);
  const localValues = localEnvSource === null ? {} : parseDotEnv(localEnvSource);
  if (localEnvSource !== null) {
    const bad = Object.keys(localValues)
      .filter((k) => isProtectedEnvKey(k, config))
      .sort();
    assertNoKeys('Protected keys are not allowed in .env.local', bad);
  }

  const secrets = suppliedSecrets
    ?? await exportInfisicalSecrets({ config, environment });

  const sharedRedis = input.sharedRedis ?? false;
  const needsRuntimeId = !sharedRedis && Object.values(config.localModeOverrides)
    .some((template) => template.includes('{runtimeId}'));
  const runtimeId = needsRuntimeId
    ? await getOrCreateRuntimeId(
      config.runtimeIdPath,
      () => `local-${randomBytes(8).toString('hex')}`,
    )
    : undefined;

  const built = buildEnvironment({
    config,
    environment,
    sharedRedis,
    runtimeId,
    secrets,
    overlay: localValues,
  });

  const serialized = serializeGeneratedEnv({
    toolName: config.toolName,
    environment: built.environment,
    localRedis: built.localRedis,
    values: built.values,
  });

  const inspection = inspectEnvironment({
    config,
    generatedEnv: serialized,
    localEnv: localEnvSource,
    inheritedEnv: input.inheritedEnv ?? process.env,
    runner: false,
    runtimeId,
  });
  assertNoKeys(
    'Generated .env violates configured policy',
    inspection.generatedPolicyKeys,
  );
  assertNoKeys(
    'Unset conflicting inherited environment keys before switching',
    inspection.inheritedConflictKeys,
  );

  await atomicWritePrivateFile(config.envPath, serialized);

  return {
    environment: built.environment,
    localRedis: built.localRedis,
    envPath: config.envPath,
  };
}

/** Read static status of generated .env (and optional conflicts). */
export async function getStatus(input?: {
  config?: LocalEnvConfig;
  projectRoot?: string;
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<StatusResult> {
  const config = getConfig(input);
  const generatedEnv = await readOptionalFile(config.envPath);
  if (generatedEnv === null) {
    throw new Error(`Root .env is missing at ${config.envPath}. Run local-env-switch use first.`);
  }
  const runtimeIdSource = await readOptionalFile(config.runtimeIdPath);
  return inspectEnvironment({
    config,
    generatedEnv,
    localEnv: await readOptionalFile(config.localEnvPath),
    inheritedEnv: input?.inheritedEnv ?? process.env,
    runner: false,
    runtimeId: runtimeIdSource?.trim(),
  });
}

/** Pre-dev guard. Throws on failure; the CLI converts failures to exit code 1. */
export async function assertGuard(input: GuardInput = {}): Promise<StatusResult> {
  if (input.runner !== undefined) assertBoolean(input.runner, 'runner');
  const config = getConfig(input);
  const generatedEnv = await readOptionalFile(config.envPath);
  if (generatedEnv === null) {
    throw new Error(`Root .env is missing at ${config.envPath}. Run local-env-switch use first.`);
  }
  const inspection = inspectEnvironment({
    config,
    generatedEnv,
    localEnv: await readOptionalFile(config.localEnvPath),
    inheritedEnv: input.inheritedEnv ?? process.env,
    runner: input.runner ?? false,
    runtimeId: (await readOptionalFile(config.runtimeIdPath))?.trim(),
  });
  if (inspection.protectedLocalKeys.length > 0) {
    throw new Error(
      `Protected keys are not allowed in .env.local: ${inspection.protectedLocalKeys.join(', ')}`,
    );
  }
  if (inspection.inheritedConflictKeys.length > 0) {
    throw new Error(
      `Conflicting inherited environment keys: ${inspection.inheritedConflictKeys.join(', ')}`,
    );
  }
  if (inspection.generatedPolicyKeys.length > 0) {
    throw new Error(
      `Generated .env violates configured policy: ${inspection.generatedPolicyKeys.join(', ')}`,
    );
  }
  if (inspection.runnerBlocked) {
    throw new Error('Local runner is disabled while shared Redis is selected.');
  }
  return inspection;
}
