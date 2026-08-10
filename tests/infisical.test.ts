import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportInfisicalSecrets } from '../src/infisical.js';
import type { LocalEnvConfig } from '../src/types.js';

test('exportInfisicalSecrets keeps file tokens out of process arguments', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-infisical-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const tokenFile = path.join(projectRoot, 'token');
  await writeFile(tokenFile, 'secret-token\n', { mode: 0o600 });
  const config: LocalEnvConfig = {
    projectRoot,
    environments: ['development'],
    confirmEnvironments: [],
    warnEnvironments: [],
    infisicalDomain: 'https://secrets.example.com/api',
    projectId: 'project-id',
    tokenFile,
    envPath: path.join(projectRoot, '.env'),
    localEnvPath: path.join(projectRoot, '.env.local'),
    runtimeIdPath: path.join(projectRoot, '.env.runtime-id'),
    requiredKeys: [],
    protectedKeys: [],
    protectedKeyPatterns: [],
    inheritedIgnoreKeys: [],
    localRedisKeys: [],
    localRedisUrl: 'redis://127.0.0.1:6379',
    localModeOverrides: {},
    sharedModeOverrides: {},
    localModeDeleteKeyPrefixes: [],
    toolName: 'fixture-env-switch',
  };

  const secrets = await exportInfisicalSecrets({
    config,
    environment: 'development',
    runner: async (command, args, options) => {
      assert.equal(command, 'infisical');
      assert.equal(args.some((arg) => arg.includes('secret-token')), false);
      assert.equal(options.env.INFISICAL_TOKEN, 'secret-token');
      return JSON.stringify([{ key: 'API_KEY', value: 'value' }]);
    },
  });

  assert.deepEqual(secrets, { API_KEY: 'value' });
});

test('exportInfisicalSecrets rejects invalid environment keys at the provider boundary', async () => {
  const config = {
    projectRoot: '/tmp/example-project',
    environments: ['development'],
    confirmEnvironments: [],
    warnEnvironments: [],
    infisicalDomain: 'https://secrets.example.com/api',
    envPath: '/tmp/example-project/.env',
    localEnvPath: '/tmp/example-project/.env.local',
    runtimeIdPath: '/tmp/example-project/.env.runtime-id',
    requiredKeys: [],
    protectedKeys: [],
    protectedKeyPatterns: [],
    inheritedIgnoreKeys: [],
    localRedisKeys: [],
    localRedisUrl: 'redis://127.0.0.1:6379',
    localModeOverrides: {},
    sharedModeOverrides: {},
    localModeDeleteKeyPrefixes: [],
    toolName: 'fixture-env-switch',
  } satisfies LocalEnvConfig;

  await assert.rejects(
    exportInfisicalSecrets({
      config,
      environment: 'development',
      runner: async () => JSON.stringify([{ key: 'INVALID-KEY', value: 'secret' }]),
    }),
    /Infisical returned an invalid secret key: INVALID-KEY/,
  );
});

test('exportInfisicalSecrets rejects prototype-named environment keys', async () => {
  const config = {
    projectRoot: '/tmp/example-project',
    environments: ['development'],
    confirmEnvironments: [],
    warnEnvironments: [],
    infisicalDomain: 'https://secrets.example.com',
    envPath: '/tmp/example-project/.env',
    localEnvPath: '/tmp/example-project/.env.local',
    runtimeIdPath: '/tmp/example-project/.env.runtime-id',
    requiredKeys: [],
    protectedKeys: [],
    protectedKeyPatterns: [],
    inheritedIgnoreKeys: [],
    localRedisKeys: [],
    localRedisUrl: 'redis://127.0.0.1:6379',
    localModeOverrides: {},
    sharedModeOverrides: {},
    localModeDeleteKeyPrefixes: [],
    toolName: 'fixture-env-switch',
  } satisfies LocalEnvConfig;

  await assert.rejects(
    exportInfisicalSecrets({
      config,
      environment: 'development',
      runner: async () => JSON.stringify([{ key: '__proto__', value: 'secret' }]),
    }),
    /Infisical returned an invalid secret key: __proto__/,
  );
});
