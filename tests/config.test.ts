import assert from 'node:assert/strict';
import { link, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findConfigPath, resolveConfig } from '../src/config.js';
import type { LocalEnvConfigFile } from '../src/types.js';

test('resolveConfig resolves paths and policy from JSON config', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-config-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });

  const config = resolveConfig({
    projectRoot,
    configFile: {
      environments: ['development', 'production'],
      confirmEnvironments: ['production'],
      warnEnvironments: ['production'],
      infisical: {
        domain: 'https://secrets.example.com/',
        tokenFile: '.secrets/token',
      },
      paths: {
        env: 'var/generated.env',
        localEnv: 'var/personal.env',
        runtimeId: 'var/runtime-id',
      },
      protectedKeys: ['DATABASE_URL'],
      protectedKeyPatterns: ['_TOKEN$'],
      localRedis: {
        url: 'redis://localhost:6380',
        keys: ['CACHE_URL'],
      },
      localModeOverrides: {
        RUNTIME_SCOPE: '{env}-{runtimeId}',
      },
      sharedModeOverrides: {
        RUNTIME_SCOPE: '{env}',
      },
    },
  });

  assert.equal(config.infisicalDomain, 'https://secrets.example.com');
  assert.equal(config.tokenFile, path.join(projectRoot, '.secrets/token'));
  assert.equal(config.envPath, path.join(projectRoot, 'var/generated.env'));
  assert.deepEqual(config.confirmEnvironments, ['production']);
  assert.deepEqual(config.sharedModeOverrides, { RUNTIME_SCOPE: '{env}' });
});

test('resolveConfig has no project-specific key policy defaults', () => {
  const config = resolveConfig({
    projectRoot: '/tmp/example-project',
    configFile: {
      environments: ['development'],
      infisical: { domain: 'https://secrets.example.com/api' },
    },
  });

  assert.deepEqual(config.requiredKeys, []);
  assert.deepEqual(config.protectedKeys, []);
  assert.deepEqual(config.protectedKeyPatterns, []);
  assert.equal(config.inheritedIgnoreKeys.includes('INFISICAL_TOKEN'), true);
  assert.deepEqual(config.localRedisKeys, []);
  assert.deepEqual(config.localModeOverrides, {});
  assert.deepEqual(config.sharedModeOverrides, {});
  assert.deepEqual(config.localModeDeleteKeyPrefixes, []);
});

test('resolveConfig rejects invalid environment references and regular expressions', () => {
  assert.throws(
    () => resolveConfig({
      inheritedEnv: {},
      configFile: {
        environments: ['development'],
      },
    }),
    /infisical.domain .* is required/,
  );
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        confirmEnvironments: ['production'],
        infisical: { domain: 'https://secrets.example.com' },
      },
    }),
    /confirmEnvironments contains unknown environments: production/,
  );
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        protectedKeyPatterns: ['['],
      },
    }),
    /Invalid protected key pattern/,
  );
});

test('resolveConfig validates values crossing the JSON boundary', () => {
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development\nINJECTED=1'],
        infisical: { domain: 'https://secrets.example.com' },
      },
    }),
    /Invalid environment name/,
  );
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        localModeOverrides: { RUNTIME_SCOPE: 1 },
      } as unknown as LocalEnvConfigFile,
    }),
    /localModeOverrides value for RUNTIME_SCOPE must be a string/,
  );
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'not a URL' },
      },
    }),
    /infisical.domain must be an HTTP or HTTPS URL/,
  );
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        protectedKeys: ['   '],
      },
    }),
    /protectedKeys must not contain empty values/,
  );
  assert.throws(
    () => resolveConfig({
      projectRoot: '/tmp/example-project',
      configFile: {
        environments: ['development'],
        infisical: {
          domain: 'https://secrets.example.com',
          tokenFile: '.env',
        },
      },
    }),
    /Configured file paths must be distinct/,
  );
});

test('findConfigPath only discovers supported JSON config names in documented order', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-find-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  await writeFile(path.join(projectRoot, 'local-env-switch.config.json'), '{}');
  await writeFile(path.join(projectRoot, 'local-env.config.json'), '{}');

  assert.equal(findConfigPath(projectRoot), path.join(projectRoot, 'local-env.config.json'));
});

test('resolveConfig rejects configured paths that only differ by letter case', () => {
  assert.throws(
    () => resolveConfig({
      projectRoot: '/tmp/example-project',
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        paths: {
          env: '.env',
          localEnv: '.ENV',
        },
      },
    }),
    /Configured file paths must be distinct/,
  );
});

test('resolveConfig rejects configured paths that alias the same existing inode', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'local-env-path-alias-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }));
  });
  const envPath = path.join(projectRoot, 'generated.env');
  const localEnvPath = path.join(projectRoot, 'personal.env');
  await writeFile(envPath, 'EXAMPLE=value\n');
  await link(envPath, localEnvPath);

  assert.throws(
    () => resolveConfig({
      projectRoot,
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        paths: {
          env: 'generated.env',
          localEnv: 'personal.env',
        },
      },
    }),
    /Configured file paths must be distinct/,
  );
});

test('resolveConfig rejects an empty local Redis URL', () => {
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        localRedis: { url: '' },
      },
    }),
    /localRedis.url must not be empty/,
  );
});

test('resolveConfig rejects a whitespace-only local Redis URL', () => {
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        localRedis: { url: '   ' },
      },
    }),
    /localRedis.url must not be empty/,
  );
});

test('resolveConfig rejects non-record override objects', () => {
  assert.throws(
    () => resolveConfig({
      configFile: {
        environments: ['development'],
        infisical: { domain: 'https://secrets.example.com' },
        localModeOverrides: new Map([
          ['CACHE_URL', 'redis://127.0.0.1:6379'],
        ]) as unknown as Record<string, string>,
      },
    }),
    /localModeOverrides must be a plain object with string values/,
  );
});
