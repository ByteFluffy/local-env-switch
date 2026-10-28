import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDevProfile, validateDevBootstrap } from '../src/dev-profile.js';

const expected = {
  profile: 'fixture-test',
  project: 'fixture',
  environment: 'test',
  region: 'fixture-region',
  production: false,
  allowedEnv: ['NODE_ENV', 'LOG_LEVEL', 'PUBLIC_API_URL'],
};

function bootstrap() {
  return {
    profile: expected.profile,
    project: expected.project,
    environment: expected.environment,
    region: expected.region,
    authorization: 'kubernetes-rbac',
    revision: 'fixture-revision',
    phase: 'database-pilot',
    env: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PUBLIC_API_URL: 'http://127.0.0.1:3000',
    },
    database: {
      alias: 'fixture_test',
      user: 'developer',
      transport: 'kubectl-port-forward',
      localPort: 15432,
    },
    redis: { host: '127.0.0.1', port: 16379, minimumDatabases: 24 },
    capabilities: { database: true, ordinaryConfig: true, fullLocalDevelopment: false },
    limitations: { backendTls: false },
  };
}

function rejected(payload: unknown, selection = expected) {
  assert.throws(
    () => validateDevBootstrap(selection, payload),
    (error: unknown) => error instanceof Error
      && error.message === 'INVALID_DEV_BOOTSTRAP'
      && error.cause === undefined,
  );
}

test('parseDevProfile accepts a single profile with comments and quoting', () => {
  for (const contents of [
    '# Local selection\n\nVIBEPAPER_DEV_PROFILE=fixture-test\n',
    'VIBEPAPER_DEV_PROFILE="fixture-test"',
    "VIBEPAPER_DEV_PROFILE='fixture-vip'\r\n",
    '  VIBEPAPER_DEV_PROFILE = fixture-test # Local selection\n',
  ]) {
    assert.equal(parseDevProfile(contents), contents.includes('fixture-vip') ? 'fixture-vip' : 'fixture-test');
  }
});

test('parseDevProfile rejects missing, duplicate, secret and malformed content without echoing it', () => {
  for (const contents of [
    '', '# Nothing selected', 'VIBEPAPER_DEV_PROFILE=', 'VIBEPAPER_DEV_PROFILE=""',
    'VIBEPAPER_DEV_PROFILE=fixture-test\nVIBEPAPER_DEV_PROFILE=fixture-test',
    'DATABASE_URL=canary-private-url\nVIBEPAPER_DEV_PROFILE=fixture-test',
    'VIBEPAPER_DEV_PROFILE=fixture-test\nJWT_SECRET=canary-signing-secret',
    'export VIBEPAPER_DEV_PROFILE=fixture-test',
    'VIBEPAPER_DEV_PROFILE=fixture-test; echo canary-value',
    'VIBEPAPER_DEV_PROFILE="fixture-test',
    'VIBEPAPER_DEV_PROFILE="fixture\ntest"',
    'VIBEPAPER_DEV_PROFILE=$(canary-command)',
  ]) {
    assert.throws(() => parseDevProfile(contents), {
      message: 'ENV_FILE_MUST_CONTAIN_ONLY_PROFILE',
    });
  }
});

test('bootstrap validation returns only approved env and password-free frontend metadata', () => {
  const payload = bootstrap();
  const result = validateDevBootstrap(expected, payload);
  assert.deepEqual(result, { env: payload.env, database: payload.database });
  payload.env.LOG_LEVEL = 'debug';
  payload.database.alias = 'different_database';
  assert.equal(result.env.LOG_LEVEL, 'info');
  assert.equal(result.database.alias, 'fixture_test');
});

test('selection metadata and Kubernetes authorization must all match', () => {
  for (const [key, value] of Object.entries({
    profile: 'other-profile', project: 'other-project', environment: 'other-environment',
    region: 'other-region', authorization: 'client-asserted',
  })) {
    rejected({ ...bootstrap(), [key]: value });
  }
});

test('production requires an explicit server production flag independent of profile spelling', () => {
  const selection = { ...expected, profile: 'fixture-vip', environment: 'vip', production: true };
  const payload = { ...bootstrap(), profile: selection.profile, environment: selection.environment };
  rejected(payload, selection);
  rejected({ ...payload, production: false }, selection);
  rejected({ ...payload, production: 'true' }, selection);
  assert.deepEqual(validateDevBootstrap(selection, { ...payload, production: true }), {
    env: payload.env,
    database: payload.database,
  });
  rejected({ ...bootstrap(), production: true });
  rejected({ ...bootstrap(), production: 'false' });
});

test('the ordinary env allowlist cannot grant access to shared secrets', () => {
  for (const key of [
    'JWT_SECRET', 'REDIS_PASSWORD', 'TASK_GATEWAY_TOKEN', 'NEXRA_API_KEY',
    'STORAGE_ACCESS_KEY_ID', 'PRIVATE_KEY', 'PAPERCONSOLE_PKEY', 'jwtSecret',
  ]) {
    rejected({ ...bootstrap(), env: { [key]: 'canary-shared-secret' } }, {
      ...expected, allowedEnv: [...expected.allowedEnv, key],
    });
  }
  rejected(bootstrap(), { ...expected, allowedEnv: [...expected.allowedEnv, 'JWT_SECRET'] });
});

test('unreviewed, malformed and non-string environment entries are rejected', () => {
  for (const env of [
    { UNREVIEWED_PUBLIC_URL: 'http://127.0.0.1:3000' },
    { LOG_LEVEL: 1 }, { LOG_LEVEL: null }, { LOG_LEVEL: ['info'] },
    { LOG_LEVEL: 'info\0canary-value' },
    Object.fromEntries([['__proto__', 'canary-value']]),
  ]) {
    rejected({ ...bootstrap(), env });
  }
});

test('credentials cannot be disguised inside an allowlisted URL', () => {
  rejected({ ...bootstrap(), env: { PUBLIC_API_URL: 'https://canary-user:canary-password@example.test' } });
});

test('unexpected top-level, upstream and nested metadata fields are rejected', () => {
  for (const payload of [
    { ...bootstrap(), sharedSecret: 'canary-shared-secret' },
    { ...bootstrap(), database: { ...bootstrap().database, password: '' } },
    { ...bootstrap(), database: { ...bootstrap().database, host: 'private-database.example' } },
    { ...bootstrap(), database: { ...bootstrap().database, backendUser: 'root_user' } },
    { ...bootstrap(), redis: { ...bootstrap().redis, password: 'canary-shared-secret' } },
    { ...bootstrap(), capabilities: { ...bootstrap().capabilities, signingSecret: 'canary-shared-secret' } },
    { ...bootstrap(), limitations: { ...bootstrap().limitations, upstream: 'canary-value' } },
  ]) {
    rejected(payload);
  }
});

test('database frontend targets require normal aliases, the public user and a local port', () => {
  for (const alias of ['', '2database', 'database-name', 'database/name', 'a'.repeat(64)]) {
    rejected({ ...bootstrap(), database: { ...bootstrap().database, alias } });
  }
  for (const user of ['root_user', '', 'other-developer']) {
    rejected({ ...bootstrap(), database: { ...bootstrap().database, user } });
  }
  for (const localPort of [0, 1023, 65536, 15432.5, NaN, Infinity, '15432']) {
    rejected({ ...bootstrap(), database: { ...bootstrap().database, localPort } });
  }
  rejected({ ...bootstrap(), database: { ...bootstrap().database, transport: 'direct-database' } });
  for (const localPort of [1024, 65535]) {
    assert.equal(validateDevBootstrap(expected, {
      ...bootstrap(), database: { ...bootstrap().database, localPort },
    }).database.localPort, localPort);
  }
});

test('malformed objects and secret-bearing getter failures become a fixed safe error', () => {
  for (const payload of [undefined, null, [], new Date(), new Error('canary-private-error')]) {
    rejected(payload);
  }
  for (const key of ['env', 'database', 'redis', 'capabilities', 'limitations']) {
    rejected({ ...bootstrap(), [key]: [] });
  }
  const payload = Object.defineProperty(bootstrap(), 'env', {
    enumerable: true,
    get() { throw new Error('canary-private-error'); },
  });
  rejected(payload);
});

test('optional current protocol metadata is checked without becoming child configuration', () => {
  rejected({ ...bootstrap(), redis: { ...bootstrap().redis, host: 'private-redis.example' } });
  rejected({ ...bootstrap(), capabilities: { ...bootstrap().capabilities, database: 'true' } });
  rejected({ ...bootstrap(), limitations: { backendTls: 'false' } });
});
