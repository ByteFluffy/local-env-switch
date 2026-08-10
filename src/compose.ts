import type { EnvironmentBuild, LocalEnvConfig, StatusResult } from './types.js';
import { parseDotEnv, parseGeneratedHeader } from './dotenv.js';

export function isProtectedEnvKey(key: string, config: LocalEnvConfig): boolean {
  if (config.protectedKeys.includes(key)) return true;
  if (config.localRedisKeys.includes(key)) return true;
  if (Object.hasOwn(config.localModeOverrides, key)) return true;
  if (Object.hasOwn(config.sharedModeOverrides, key)) return true;
  if (config.localModeDeleteKeyPrefixes.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  for (const source of config.protectedKeyPatterns) {
    if (new RegExp(source).test(key)) return true;
  }
  return false;
}

function requireValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`Missing required environment key: ${key}`);
  return value;
}

function applyTemplate(
  template: string,
  ctx: { env: string; runtimeId?: string },
): string {
  return template
    .replaceAll('{env}', ctx.env)
    .replaceAll('{runtimeId}', ctx.runtimeId ?? '');
}

/**
 * Merge secrets + optional presets, then apply local or shared safety policy.
 * Generic API for any caller.
 */
export function buildEnvironment(input: {
  config: LocalEnvConfig;
  environment: string;
  sharedRedis: boolean;
  runtimeId?: string;
  /** Optional non-secret defaults (usually empty). */
  preset?: Record<string, string>;
  secrets: Record<string, string>;
  /** Safe host-local values applied after fetched secrets. */
  overlay?: Record<string, string>;
}): EnvironmentBuild {
  const { config, environment } = input;
  if (!config.environments.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Allowed: ${config.environments.join(', ')}`,
    );
  }

  const values = {
    ...(input.preset ?? {}),
    ...input.secrets,
    ...(input.overlay ?? {}),
  };

  if (input.sharedRedis) {
    for (const [key, template] of Object.entries(config.sharedModeOverrides)) {
      values[key] = applyTemplate(template, { env: environment });
    }
    for (const key of config.requiredKeys) {
      requireValue(values, key);
    }
    return { environment, localRedis: false, values };
  }

  const needsRuntimeId = Object.values(config.localModeOverrides)
    .some((template) => template.includes('{runtimeId}'));
  if (
    needsRuntimeId
    && (!input.runtimeId || !/^local-[a-f0-9]{16,}$/.test(input.runtimeId))
  ) {
    throw new Error('Local Redis mode requires a valid local runtime ID');
  }

  for (const key of Object.keys(values)) {
    for (const prefix of config.localModeDeleteKeyPrefixes) {
      if (key.startsWith(prefix)) {
        delete values[key];
        break;
      }
    }
  }

  for (const key of config.localRedisKeys) {
    values[key] = config.localRedisUrl;
  }

  const ctx = { env: environment, runtimeId: input.runtimeId };
  for (const [key, template] of Object.entries(config.localModeOverrides)) {
    values[key] = applyTemplate(template, ctx);
  }
  for (const key of config.requiredKeys) {
    requireValue(values, key);
  }

  return { environment, localRedis: true, values };
}

export function inspectEnvironment(input: {
  config: LocalEnvConfig;
  generatedEnv: string;
  localEnv: string | null;
  inheritedEnv: Readonly<Record<string, string | undefined>>;
  runner: boolean;
  runtimeId?: string;
}): StatusResult {
  const header = parseGeneratedHeader(
    input.generatedEnv,
    input.config.toolName,
    input.config.environments,
  );
  const generatedValues = parseDotEnv(input.generatedEnv);
  const localValues = input.localEnv === null ? {} : parseDotEnv(input.localEnv);

  const protectedLocalKeys = Object.keys(localValues)
    .filter((key) => isProtectedEnvKey(key, input.config))
    .sort();
  const inheritedConflictKeys = Object.keys(input.inheritedEnv)
    .filter((key) => !input.config.inheritedIgnoreKeys.includes(key))
    .filter((key) => isProtectedEnvKey(key, input.config))
    .filter((key) => {
      const inheritedValue = input.inheritedEnv[key];
      return inheritedValue !== undefined && generatedValues[key] !== inheritedValue;
    })
    .sort();

  const generatedPolicyKeys = new Set<string>();
  for (const key of input.config.requiredKeys) {
    if (!generatedValues[key]?.trim()) generatedPolicyKeys.add(key);
  }

  const modeOverrides = header.localRedis
    ? input.config.localModeOverrides
    : input.config.sharedModeOverrides;
  for (const [key, template] of Object.entries(modeOverrides)) {
    if (
      template.includes('{runtimeId}')
      && !/^local-[a-f0-9]{16,}$/.test(input.runtimeId ?? '')
    ) {
      generatedPolicyKeys.add(key);
      continue;
    }
    const expected = applyTemplate(template, {
      env: header.environment,
      runtimeId: header.localRedis ? input.runtimeId : undefined,
    });
    if (generatedValues[key] !== expected) generatedPolicyKeys.add(key);
  }

  if (header.localRedis) {
    for (const key of input.config.localRedisKeys) {
      if (generatedValues[key] !== input.config.localRedisUrl) {
        generatedPolicyKeys.add(key);
      }
    }
    for (const key of Object.keys(generatedValues)) {
      if (
        input.config.localModeDeleteKeyPrefixes
          .some((prefix) => key.startsWith(prefix))
      ) {
        generatedPolicyKeys.add(key);
      }
    }
  }

  return {
    ...header,
    protectedLocalKeys,
    inheritedConflictKeys,
    generatedPolicyKeys: [...generatedPolicyKeys].sort(),
    runnerBlocked: input.runner && !header.localRedis,
  };
}
