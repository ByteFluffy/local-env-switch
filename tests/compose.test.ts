import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEnvironment, isProtectedEnvKey } from '../src/compose.js';
import type { LocalEnvConfig } from '../src/types.js';

const baseConfig: LocalEnvConfig = {
  projectRoot: '/repo',
  environments: ['development', 'staging', 'production'],
  confirmEnvironments: [],
  warnEnvironments: ['staging', 'production'],
  infisicalDomain: 'https://example.invalid/api',
  envPath: '/repo/.env',
  localEnvPath: '/repo/.env.local',
  runtimeIdPath: '/repo/.env.runtime-id',
  requiredKeys: ['PRIMARY_DATABASE_URL'],
  protectedKeys: ['PRIMARY_DATABASE_URL', 'RUNTIME_SCOPE', 'CACHE_URL'],
  protectedKeyPatterns: ['^REMOTE_QUEUE_'],
  inheritedIgnoreKeys: [],
  localRedisKeys: ['CACHE_URL'],
  localRedisUrl: 'redis://127.0.0.1:6379',
  localModeOverrides: {
    RUNTIME_SCOPE: '{env}-{runtimeId}',
    DEPLOYMENT_REGION: 'default',
  },
  sharedModeOverrides: {
    RUNTIME_SCOPE: '{env}',
  },
  localModeDeleteKeyPrefixes: ['REMOTE_QUEUE_'],
  toolName: 'local-env-switch',
};

test('buildEnvironment applies local redis overlay', () => {
  const built = buildEnvironment({
    config: baseConfig,
    environment: 'development',
    sharedRedis: false,
    runtimeId: 'local-0123456789abcdef',
    secrets: {
      PRIMARY_DATABASE_URL: 'postgres://example.invalid/db',
      CACHE_URL: 'redis://remote:6379',
      REMOTE_QUEUE_BLUE: 'redis://x:6379',
    },
    overlay: {
      LOG_LEVEL: 'debug',
      CACHE_URL: 'redis://overlay:6379',
    },
  });
  assert.equal(built.localRedis, true);
  assert.equal(built.values.CACHE_URL, 'redis://127.0.0.1:6379');
  assert.equal(built.values.RUNTIME_SCOPE, 'development-local-0123456789abcdef');
  assert.equal(built.values.DEPLOYMENT_REGION, 'default');
  assert.equal(built.values.LOG_LEVEL, 'debug');
  assert.equal('REMOTE_QUEUE_BLUE' in built.values, false);
});

test('buildEnvironment applies configured shared overrides without built-in business keys', () => {
  const built = buildEnvironment({
    config: {
      ...baseConfig,
      sharedModeOverrides: {
        RELEASE_CHANNEL: '{env}',
      },
    },
    environment: 'staging',
    sharedRedis: true,
    secrets: {
      PRIMARY_DATABASE_URL: 'postgres://example.invalid/db',
    },
  });

  assert.equal(built.values.RELEASE_CHANNEL, 'staging');
  assert.equal('RUNTIME_SCOPE' in built.values, false);
});

test('isProtectedEnvKey uses config patterns', () => {
  const config = {
    ...baseConfig,
    protectedKeys: ['PRIMARY_DATABASE_URL'],
    protectedKeyPatterns: [],
  };
  assert.equal(isProtectedEnvKey('PRIMARY_DATABASE_URL', config), true);
  assert.equal(isProtectedEnvKey('CACHE_URL', config), true);
  assert.equal(isProtectedEnvKey('RUNTIME_SCOPE', config), true);
  assert.equal(isProtectedEnvKey('REMOTE_QUEUE_BLUE', baseConfig), true);
  assert.equal(isProtectedEnvKey('LOG_LEVEL', config), false);
});
