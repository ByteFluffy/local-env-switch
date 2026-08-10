/** Resolved configuration used by all APIs. */
export type LocalEnvConfig = {
  /** Absolute project root (where .env is written). */
  projectRoot: string;
  /** Allowed environment names (Infisical env slugs). */
  environments: string[];
  /**
   * Environments that require an extra CLI flag `--yes` before write.
   * Empty = never block (simplest UX).
   */
  confirmEnvironments: string[];
  /** Environments that only print a warning. */
  warnEnvironments: string[];
  /** Infisical CLI domain/API base, passed through unchanged except trailing slashes. */
  infisicalDomain: string;
  /** Infisical project / workspace id. */
  projectId?: string;
  /** Optional absolute path to a JWT/token file. */
  tokenFile?: string;
  /** Path to generated .env (absolute). */
  envPath: string;
  /** Path to optional personal .env.local (absolute). */
  localEnvPath: string;
  /** Path to runtime id file (absolute). */
  runtimeIdPath: string;
  /** Required keys after all overlays are applied. */
  requiredKeys: string[];
  /** Exact protected keys (identity / safety). */
  protectedKeys: string[];
  /** Regex sources for protected keys (matched with new RegExp(source)). */
  protectedKeyPatterns: string[];
  /** Tool control variables excluded from inherited app-environment conflicts. */
  inheritedIgnoreKeys: string[];
  /** Keys forced to local Redis URL in local mode. */
  localRedisKeys: string[];
  /** Local Redis URL. */
  localRedisUrl: string;
  /**
   * Extra keys forced in local mode (e.g. region defaults).
   * Values may use `{env}` and `{runtimeId}` placeholders.
   */
  localModeOverrides: Record<string, string>;
  /** Extra keys forced in shared mode. Values may use the `{env}` placeholder. */
  sharedModeOverrides: Record<string, string>;
  /** Literal key prefixes deleted in local mode. */
  localModeDeleteKeyPrefixes: string[];
  /** Header generator label. */
  toolName: string;
};

/** JSON config file shape (relative paths ok). */
export type LocalEnvConfigFile = {
  environments: string[];
  confirmEnvironments?: string[];
  warnEnvironments?: string[];
  infisical?: {
    domain?: string;
    projectId?: string;
    tokenFile?: string;
  };
  paths?: {
    env?: string;
    localEnv?: string;
    runtimeId?: string;
  };
  requiredKeys?: string[];
  protectedKeys?: string[];
  protectedKeyPatterns?: string[];
  inheritedIgnoreKeys?: string[];
  localRedis?: {
    url?: string;
    keys?: string[];
  };
  localModeOverrides?: Record<string, string>;
  sharedModeOverrides?: Record<string, string>;
  localModeDeleteKeyPrefixes?: string[];
  toolName?: string;
};

export type UseEnvironmentInput = {
  environment: string;
  sharedRedis?: boolean;
  /** Required when environment is listed in confirmEnvironments. */
  yes?: boolean;
  /** Optional secrets from an alternative provider or deterministic test. */
  secrets?: Record<string, string>;
  /** Optional inherited environment override for deterministic callers/tests. */
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
  config?: LocalEnvConfig;
  projectRoot?: string;
};

export type UseEnvironmentResult = {
  environment: string;
  localRedis: boolean;
  envPath: string;
};

export type StatusResult = {
  environment: string;
  localRedis: boolean;
  protectedLocalKeys: string[];
  inheritedConflictKeys: string[];
  generatedPolicyKeys: string[];
  runnerBlocked: boolean;
};

export type GuardInput = {
  runner?: boolean;
  config?: LocalEnvConfig;
  projectRoot?: string;
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
};

export type EnvironmentBuild = {
  environment: string;
  localRedis: boolean;
  values: Record<string, string>;
};
