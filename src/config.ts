import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  isPortableEnvironmentKey,
  normalizeStringRecord as normalizePlainStringRecord,
} from './dotenv.js';
import type { LocalEnvConfig, LocalEnvConfigFile } from './types.js';

const INFISICAL_CONTROL_KEYS = [
  'INFISICAL_API_URL',
  'INFISICAL_CUSTOM_HEADERS',
  'INFISICAL_DISABLE_UPDATE_CHECK',
  'INFISICAL_DOMAIN',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_TOKEN',
] as const;

export const CONFIG_FILE_NAMES = [
  'local-env.config.json',
  'local-env-switch.config.json',
] as const;

export function findConfigPath(projectRoot: string, explicit?: string): string | null {
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.join(projectRoot, explicit);
    return existsSync(p) ? p : null;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const p = path.join(projectRoot, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfigFile(filePath: string): LocalEnvConfigFile {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config ${filePath}: expected a JSON object`);
  }
  const file = parsed as LocalEnvConfigFile;
  if (!Array.isArray(file.environments) || file.environments.length === 0) {
    throw new Error(`Config ${filePath}: environments must be a non-empty array`);
  }
  return file;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  const normalized = value.map((item) => item.trim());
  if (normalized.some((item) => item === '')) {
    throw new Error(`${label} must not contain empty values`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized;
}

function normalizeEnvKeyList(value: unknown, label: string): string[] {
  const keys = normalizeStringList(value, label);
  const invalid = keys.find((key) => !isPortableEnvironmentKey(key));
  if (invalid) throw new Error(`${label} contains an invalid environment key: ${invalid}`);
  return keys;
}

function normalizeEnvStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = normalizePlainStringRecord(value, label);
  const entries = Object.entries(record);
  const invalidKey = entries.find(([key]) => !isPortableEnvironmentKey(key));
  if (invalidKey) {
    throw new Error(`${label} contains an invalid environment key: ${invalidKey[0]}`);
  }
  return record;
}

function assertOptionalObject(value: unknown, label: string): void {
  if (
    value !== undefined
    && (value === null || typeof value !== 'object' || Array.isArray(value))
  ) {
    throw new Error(`${label} must be an object`);
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function assertEnvironmentSubset(
  values: readonly string[],
  environments: readonly string[],
  label: string,
): void {
  const unknown = values.filter((value) => !environments.includes(value));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown environments: ${unknown.join(', ')}`);
  }
}

function assertDistinctFilePaths(filePaths: readonly string[]): void {
  const lexicalPaths = filePaths.map((filePath) => path.normalize(filePath).toLowerCase());
  if (new Set(lexicalPaths).size !== lexicalPaths.length) {
    throw new Error('Configured file paths must be distinct');
  }

  const existingPaths = filePaths.filter(existsSync);
  const realPaths = existingPaths.map((filePath) => realpathSync.native(filePath).toLowerCase());
  if (new Set(realPaths).size !== realPaths.length) {
    throw new Error('Configured file paths must be distinct');
  }

  const inodeKeys = existingPaths
    .map((filePath) => statSync(filePath))
    .filter((stats) => stats.ino !== 0)
    .map((stats) => `${stats.dev}:${stats.ino}`);
  if (new Set(inodeKeys).size !== inodeKeys.length) {
    throw new Error('Configured file paths must be distinct');
  }
}

export function resolveConfig(options?: {
  projectRoot?: string;
  configPath?: string;
  configFile?: LocalEnvConfigFile;
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
}): LocalEnvConfig {
  const projectRoot = path.resolve(options?.projectRoot ?? process.cwd());
  const filePath = options?.configFile
    ? null
    : findConfigPath(projectRoot, options?.configPath);
  const file = options?.configFile
    ?? (filePath ? loadConfigFile(filePath) : null);

  if (!file) {
    throw new Error(
      `No local-env config found under ${projectRoot}. Add local-env.config.json or pass configFile.`,
    );
  }

  assertOptionalObject(file.infisical, 'infisical');
  assertOptionalObject(file.paths, 'paths');
  assertOptionalObject(file.localRedis, 'localRedis');

  const environments = normalizeStringList(file.environments, 'environments');
  if (environments.length === 0) {
    throw new Error('environments must not be empty');
  }
  const invalidEnvironment = environments.find(
    (environment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment),
  );
  if (invalidEnvironment) {
    throw new Error(`Invalid environment name: ${invalidEnvironment}`);
  }
  const confirmEnvironments = normalizeStringList(
    file.confirmEnvironments ?? [],
    'confirmEnvironments',
  );
  const warnEnvironments = normalizeStringList(
    file.warnEnvironments ?? [],
    'warnEnvironments',
  );
  assertEnvironmentSubset(confirmEnvironments, environments, 'confirmEnvironments');
  assertEnvironmentSubset(warnEnvironments, environments, 'warnEnvironments');

  const inheritedEnv = options?.inheritedEnv ?? process.env;
  const configuredDomain = optionalString(file.infisical?.domain, 'infisical.domain');
  const domainRaw = (
    configuredDomain
    || inheritedEnv.INFISICAL_API_URL
    || inheritedEnv.INFISICAL_DOMAIN
    || ''
  ).replace(/\/+$/, '');
  if (!domainRaw) {
    throw new Error('infisical.domain (or INFISICAL_API_URL) is required');
  }
  try {
    const url = new URL(domainRaw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('invalid Infisical URL');
    }
  } catch {
    throw new Error('infisical.domain must be an HTTP or HTTPS URL without credentials');
  }
  const infisicalDomain = domainRaw;

  const configuredProjectId = optionalString(
    file.infisical?.projectId,
    'infisical.projectId',
  )?.trim();
  const projectId = configuredProjectId
    || inheritedEnv.INFISICAL_PROJECT_ID?.trim()
    || readWorkspaceId(projectRoot);
  const configuredTokenFile = optionalString(
    file.infisical?.tokenFile,
    'infisical.tokenFile',
  );

  const protectedKeyPatterns = normalizeStringList(
    file.protectedKeyPatterns ?? [],
    'protectedKeyPatterns',
  );
  for (const source of protectedKeyPatterns) {
    try {
      new RegExp(source);
    } catch {
      throw new Error(`Invalid protected key pattern: ${source}`);
    }
  }

  const configuredToolName = optionalString(file.toolName, 'toolName');
  const toolName = configuredToolName?.trim() || 'local-env-switch';
  if (/[\r\n]/.test(toolName)) {
    throw new Error('toolName must not contain line breaks');
  }

  const envPath = path.resolve(
    projectRoot,
    optionalString(file.paths?.env, 'paths.env') ?? '.env',
  );
  const localEnvPath = path.resolve(
    projectRoot,
    optionalString(file.paths?.localEnv, 'paths.localEnv') ?? '.env.local',
  );
  const runtimeIdPath = path.resolve(
    projectRoot,
    optionalString(file.paths?.runtimeId, 'paths.runtimeId') ?? '.env.runtime-id',
  );
  const tokenFile = configuredTokenFile
    ? path.resolve(projectRoot, configuredTokenFile)
    : undefined;
  const configuredPaths = [envPath, localEnvPath, runtimeIdPath, tokenFile]
    .filter((filePath): filePath is string => filePath !== undefined);
  assertDistinctFilePaths(configuredPaths);

  const localRedisUrl = optionalString(file.localRedis?.url, 'localRedis.url')
    ?? 'redis://127.0.0.1:6379';
  if (!localRedisUrl.trim()) {
    throw new Error('localRedis.url must not be empty');
  }

  return {
    projectRoot,
    environments,
    confirmEnvironments,
    warnEnvironments,
    infisicalDomain,
    projectId,
    tokenFile,
    envPath,
    localEnvPath,
    runtimeIdPath,
    requiredKeys: normalizeEnvKeyList(file.requiredKeys ?? [], 'requiredKeys'),
    protectedKeys: normalizeEnvKeyList(file.protectedKeys ?? [], 'protectedKeys'),
    protectedKeyPatterns,
    inheritedIgnoreKeys: [...new Set([
      ...INFISICAL_CONTROL_KEYS,
      ...normalizeEnvKeyList(file.inheritedIgnoreKeys ?? [], 'inheritedIgnoreKeys'),
    ])].sort(),
    localRedisKeys: normalizeEnvKeyList(file.localRedis?.keys ?? [], 'localRedis.keys'),
    localRedisUrl,
    localModeOverrides: normalizeEnvStringRecord(
      file.localModeOverrides,
      'localModeOverrides',
    ),
    sharedModeOverrides: normalizeEnvStringRecord(
      file.sharedModeOverrides,
      'sharedModeOverrides',
    ),
    localModeDeleteKeyPrefixes: normalizeStringList(
      file.localModeDeleteKeyPrefixes ?? [],
      'localModeDeleteKeyPrefixes',
    ),
    toolName,
  };
}

function readWorkspaceId(projectRoot: string): string | undefined {
  const p = path.join(projectRoot, '.infisical.json');
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { workspaceId?: string; projectId?: string };
    return j.workspaceId?.trim() || j.projectId?.trim() || undefined;
  } catch {
    return undefined;
  }
}
