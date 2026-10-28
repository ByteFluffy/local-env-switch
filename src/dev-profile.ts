import { isPortableEnvironmentKey } from './dotenv.js';

export type DevBootstrapExpected = {
  profile: string;
  project: string;
  environment: string;
  region: string;
  production: boolean;
  allowedEnv: readonly string[];
};

export type ValidatedDevBootstrap = {
  env: Record<string, string>;
  database: {
    alias: string;
    user: 'developer';
    transport: 'kubectl-port-forward';
    localPort: number;
  };
};

const SECRET_NAME = /SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|PKEY/i;

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('INVALID_DEV_BOOTSTRAP');
}

function record(value: unknown): Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValid(prototype === Object.prototype || prototype === null);
  requireValid(Object.getOwnPropertySymbols(value).length === 0);
  return Object.fromEntries(Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]));
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  requireValid(Object.keys(value).every((key) => allowed.includes(key)));
}

function isLocalPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function parseDevProfile(contents: string): string {
  if (typeof contents === 'string') {
    const lines = contents.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const match = lines.length === 1 && lines[0].match(
      /^VIBEPAPER_DEV_PROFILE\s*=\s*(?:([a-z0-9-]+)|"([a-z0-9-]+)"|'([a-z0-9-]+)')\s*(?:#.*)?$/,
    );
    if (match) return match[1] || match[2] || match[3];
  }
  throw new Error('ENV_FILE_MUST_CONTAIN_ONLY_PROFILE');
}

export function validateDevBootstrap(
  expected: DevBootstrapExpected,
  payload: unknown,
): ValidatedDevBootstrap {
  try {
    const body = record(payload);
    onlyKeys(body, ['profile', 'project', 'environment', 'region', 'authorization', 'production',
      'revision', 'phase', 'env', 'database', 'redis', 'capabilities', 'limitations']);
    for (const name of ['profile', 'project', 'environment', 'region'] as const) {
      requireValid(typeof expected[name] === 'string' && expected[name].trim() !== '');
      requireValid(body[name] === expected[name]);
    }
    requireValid(body.authorization === 'kubernetes-rbac');
    requireValid(typeof expected.production === 'boolean');
    requireValid(expected.production ? body.production === true
      : body.production === undefined || body.production === false);
    for (const name of ['revision', 'phase']) {
      requireValid(body[name] === undefined || typeof body[name] === 'string');
    }

    requireValid(Array.isArray(expected.allowedEnv));
    requireValid(expected.allowedEnv.every((key) => typeof key === 'string'
      && isPortableEnvironmentKey(key) && !SECRET_NAME.test(key)));
    const source = record(body.env);
    const values: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(source)) {
      requireValid(expected.allowedEnv.includes(key) && !SECRET_NAME.test(key));
      requireValid(isPortableEnvironmentKey(key) && typeof value === 'string' && !value.includes('\0'));
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        const url = new URL(value);
        requireValid(!url.username && !url.password);
      }
      values.push([key, value]);
    }

    const database = record(body.database);
    onlyKeys(database, ['alias', 'user', 'transport', 'localPort']);
    requireValid(typeof database.alias === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database.alias));
    requireValid(database.user === 'developer' && database.transport === 'kubectl-port-forward');
    requireValid(isLocalPort(database.localPort));

    if (body.redis !== undefined) {
      const redis = record(body.redis);
      onlyKeys(redis, ['host', 'port', 'minimumDatabases']);
      requireValid(redis.host === '127.0.0.1' || redis.host === 'localhost');
      requireValid(isLocalPort(redis.port));
      requireValid(typeof redis.minimumDatabases === 'number'
        && Number.isSafeInteger(redis.minimumDatabases) && redis.minimumDatabases >= 1);
    }
    if (body.capabilities !== undefined) {
      const capabilities = record(body.capabilities);
      onlyKeys(capabilities, ['database', 'ordinaryConfig', 'fullLocalDevelopment']);
      requireValid(['database', 'ordinaryConfig', 'fullLocalDevelopment']
        .every((key) => typeof capabilities[key] === 'boolean'));
    }
    if (body.limitations !== undefined) {
      const limitations = record(body.limitations);
      onlyKeys(limitations, ['backendTls']);
      requireValid(typeof limitations.backendTls === 'boolean');
    }

    return {
      env: Object.fromEntries(values),
      database: {
        alias: database.alias,
        user: database.user,
        transport: database.transport,
        localPort: database.localPort,
      },
    };
  } catch {
    throw new Error('INVALID_DEV_BOOTSTRAP');
  }
}
