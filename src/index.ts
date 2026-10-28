/**
 * local-env-switch — generic Infisical local .env switcher
 *
 * Programmatic API for any host project:
 *   import { useEnvironment, getStatus, assertGuard, resolveConfig } from 'local-env-switch'
 *
 * CLI:
 *   local-env-switch use test
 *   local-env-switch status
 *   local-env-switch guard [--runner]
 */

export {
  useEnvironment,
  getStatus,
  assertGuard,
  resolveConfig,
  findConfigPath,
  buildEnvironment,
  inspectEnvironment,
  isProtectedEnvKey,
  exportInfisicalSecrets,
  parseDotEnv,
  serializeGeneratedEnv,
  parseGeneratedHeader,
  atomicWritePrivateFile,
  getOrCreateRuntimeId,
  readOptionalFile,
} from './api.js';

export type {
  LocalEnvConfig,
  LocalEnvConfigFile,
  UseEnvironmentInput,
  UseEnvironmentResult,
  StatusResult,
  GuardInput,
  EnvironmentBuild,
} from './types.js';

export { runDev } from './dev-command.js';
export { parseDevProfile, validateDevBootstrap } from './dev-profile.js';
export type { DevConfigFile, DevProfileConfig, RunDevInput } from './dev-command.js';
export type { DevBootstrapExpected, ValidatedDevBootstrap } from './dev-profile.js';
