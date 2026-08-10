import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertGuard, getStatus, useEnvironment } from '../src/api.js';
import { parseDotEnv } from '../src/dotenv.js';
import type { LocalEnvConfig } from '../src/types.js';

function createConfig(projectRoot: string): LocalEnvConfig {
  return {
    projectRoot,
    environments: ['development', 'production'],
    confirmEnvironments: ['production'],
    warnEnvironments: ['production'],
    infisicalDomain: 'https://secrets.example.com/api',
    envPath: path.join(projectRoot, '.env'),
    localEnvPath: path.join(projectRoot, '.env.local'),
    runtimeIdPath: path.join(projectRoot, '.env.runtime-id'),
    requiredKeys: ['PRIMARY_DATABASE_URL'],
    protectedKeys: ['PRIMARY_DATABASE_URL', 'CACHE_URL', 'RUNTIME_SCOPE'],
    protectedKeyPatterns: [],
    inheritedIgnoreKeys: [
      'INFISICAL_API_URL',
      'INFISICAL_DISABLE_UPDATE_CHECK',
      'INFISICAL_DOMAIN',
      'INFISICAL_PROJECT_ID',
      'INFISICAL_TOKEN',
    ],
    localRedisKeys: ['CACHE_URL'],
    localRedisUrl: 'redis://127.0.0.1:6379',
    localModeOverrides: { RUNTIME_SCOPE: '{env}-{runtimeId}' },
    sharedModeOverrides: { RUNTIME_SCOPE: '{env}' },
    localModeDeleteKeyPrefixes: ['REMOTE_QUEUE_'],
    toolName: 'fixture-env-switch',
  };
}

test('useEnvironment merges safe local overlay and atomically writes a private env file', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-use-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = createConfig(projectRoot);
  await writeFile(config.localEnvPath, 'LOG_LEVEL=debug\n');

  const result = await useEnvironment({
    config,
    environment: 'development',
    secrets: {
      PRIMARY_DATABASE_URL: 'postgres://example.invalid/app',
      CACHE_URL: 'redis://remote:6379',
      REMOTE_QUEUE_BLUE: 'remote-only',
    },
    inheritedEnv: {},
  });

  const generated = await readFile(config.envPath, 'utf8');
  const generatedValues = parseDotEnv(generated);
  assert.equal('values' in result, false);
  assert.equal(generatedValues.LOG_LEVEL, 'debug');
  assert.equal(generatedValues.CACHE_URL, 'redis://127.0.0.1:6379');
  assert.match(generatedValues.RUNTIME_SCOPE ?? '', /^development-local-[a-f0-9]{16}$/);
  assert.equal('REMOTE_QUEUE_BLUE' in generatedValues, false);
  assert.match(generated, /LOG_LEVEL=debug/);
  assert.equal((await stat(config.envPath)).mode & 0o777, 0o600);
});

test('useEnvironment refuses protected local overlay without changing the generated env', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-protected-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = createConfig(projectRoot);
  await writeFile(config.envPath, 'existing env\n');
  await writeFile(config.localEnvPath, 'PRIMARY_DATABASE_URL=postgres://forbidden\n');

  await assert.rejects(
    useEnvironment({
      config,
      environment: 'development',
      secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
      inheritedEnv: {},
    }),
    /Protected keys are not allowed in .env.local: PRIMARY_DATABASE_URL/,
  );
  assert.equal(await readFile(config.envPath, 'utf8'), 'existing env\n');
});

test('status and guard reject a local runner when shared mode is selected', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-guard-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = createConfig(projectRoot);
  await useEnvironment({
    config,
    environment: 'development',
    sharedRedis: true,
    secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
    inheritedEnv: {},
  });

  const status = await getStatus({ config, inheritedEnv: {} });
  assert.equal(status.localRedis, false);
  await assert.rejects(
    assertGuard({ config, runner: true, inheritedEnv: {} }),
    /Local runner is disabled while shared Redis is selected/,
  );
});

test('guard rejects protected local and inherited overrides by key name', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-conflict-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = createConfig(projectRoot);
  await useEnvironment({
    config,
    environment: 'development',
    secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
    inheritedEnv: {},
  });
  await writeFile(config.localEnvPath, 'CACHE_URL=redis://forbidden:6379\n');

  await assert.rejects(
    assertGuard({ config, inheritedEnv: {} }),
    /Protected keys are not allowed in .env.local: CACHE_URL/,
  );
  await writeFile(config.localEnvPath, 'LOG_LEVEL=debug\n');
  await assert.rejects(
    assertGuard({
      config,
      inheritedEnv: { PRIMARY_DATABASE_URL: 'postgres://wrong.invalid/app' },
    }),
    /Conflicting inherited environment keys: PRIMARY_DATABASE_URL/,
  );
});

test('status and guard detect generated env drift from configured local policy', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-drift-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = createConfig(projectRoot);
  await useEnvironment({
    config,
    environment: 'development',
    secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
    inheritedEnv: {},
  });
  const generated = await readFile(config.envPath, 'utf8');
  const tampered = generated
    .replace(/^CACHE_URL=.*$/m, 'CACHE_URL=redis://remote.invalid:6379')
    .replace(/^PRIMARY_DATABASE_URL=.*$/m, 'PRIMARY_DATABASE_URL=')
    .replace(/^RUNTIME_SCOPE=.*$/m, 'RUNTIME_SCOPE=wrong')
    .concat('REMOTE_QUEUE_BLUE=redis://remote.invalid:6379\n');
  await writeFile(config.envPath, tampered);

  const status = await getStatus({ config, inheritedEnv: {} });
  assert.deepEqual(status.generatedPolicyKeys, [
    'CACHE_URL',
    'PRIMARY_DATABASE_URL',
    'REMOTE_QUEUE_BLUE',
    'RUNTIME_SCOPE',
  ]);
  await assert.rejects(
    assertGuard({ config, inheritedEnv: {} }),
    /Generated .env violates configured policy: CACHE_URL, PRIMARY_DATABASE_URL, REMOTE_QUEUE_BLUE, RUNTIME_SCOPE/,
  );
});

test('useEnvironment ignores Infisical control variables during inherited conflict checks', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-control-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = {
    ...createConfig(projectRoot),
    protectedKeyPatterns: ['_TOKEN$', '_URL$'],
  };

  const result = await useEnvironment({
    config,
    environment: 'development',
    secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
    inheritedEnv: {
      INFISICAL_API_URL: 'https://secrets.example.com/api',
      INFISICAL_TOKEN: 'secret-token',
    },
  });

  assert.equal(result.environment, 'development');
});

test('useEnvironment rejects non-string secret values instead of writing empty values', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-secret-type-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const config = {
    ...createConfig(projectRoot),
    requiredKeys: [],
  };
  await writeFile(config.envPath, 'existing env\n');

  await assert.rejects(
    useEnvironment({
      config,
      environment: 'development',
      secrets: { API_KEY: undefined } as unknown as Record<string, string>,
      inheritedEnv: {},
    }),
    /secrets value for API_KEY must be a string/,
  );
  assert.equal(await readFile(config.envPath, 'utf8'), 'existing env\n');
});

test('useEnvironment rejects a non-string environment', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-environment-type-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });

  await assert.rejects(
    useEnvironment({
      config: createConfig(projectRoot),
      environment: false as unknown as string,
      secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
      inheritedEnv: {},
    }),
    /environment must be a string/,
  );
});

test('useEnvironment rejects a non-boolean confirmation flag', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-confirm-type-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });

  await assert.rejects(
    useEnvironment({
      config: createConfig(projectRoot),
      environment: 'production',
      yes: 'false' as unknown as boolean,
      secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
      inheritedEnv: {},
    }),
    /yes must be a boolean/,
  );
});

test('useEnvironment rejects a non-boolean shared Redis flag', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-shared-type-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });

  await assert.rejects(
    useEnvironment({
      config: createConfig(projectRoot),
      environment: 'development',
      sharedRedis: 'false' as unknown as boolean,
      secrets: { PRIMARY_DATABASE_URL: 'postgres://example.invalid/app' },
      inheritedEnv: {},
    }),
    /sharedRedis must be a boolean/,
  );
});

test('assertGuard rejects a non-boolean runner flag before reading files', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-runner-type-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });

  await assert.rejects(
    assertGuard({
      config: createConfig(projectRoot),
      runner: 'false' as unknown as boolean,
      inheritedEnv: {},
    }),
    /runner must be a boolean/,
  );
});
