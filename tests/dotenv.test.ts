import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDotEnv, serializeGeneratedEnv } from '../src/dotenv.js';

test('parseDotEnv rejects prototype-named keys instead of silently dropping them', () => {
  assert.throws(
    () => parseDotEnv('__proto__=secret\n'),
    /Unsupported environment key: __proto__/,
  );
});

test('parseDotEnv rejects keys that cannot be serialized portably', () => {
  assert.throws(
    () => parseDotEnv('INVALID-KEY=value\n'),
    /Invalid dotenv content/,
  );
});

test('serializeGeneratedEnv rejects line breaks in environment names', () => {
  assert.throws(
    () => serializeGeneratedEnv({
      toolName: 'fixture-env-switch',
      environment: 'development\nINJECTED=1',
      localRedis: true,
      values: { SAFE_KEY: 'safe-value' },
    }),
    /environment must not contain line breaks/,
  );
});

test('serializeGeneratedEnv rejects line breaks in tool names', () => {
  assert.throws(
    () => serializeGeneratedEnv({
      toolName: 'fixture-env-switch\nINJECTED=1',
      environment: 'development',
      localRedis: true,
      values: { SAFE_KEY: 'safe-value' },
    }),
    /toolName must not contain line breaks/,
  );
});

test('serializeGeneratedEnv rejects a non-boolean local Redis flag', () => {
  assert.throws(
    () => serializeGeneratedEnv({
      toolName: 'fixture-env-switch',
      environment: 'development',
      localRedis: 'false' as unknown as boolean,
      values: { SAFE_KEY: 'safe-value' },
    }),
    /localRedis must be a boolean/,
  );
});

test('serializeGeneratedEnv rejects non-string values', () => {
  assert.throws(
    () => serializeGeneratedEnv({
      toolName: 'fixture-env-switch',
      environment: 'development',
      localRedis: true,
      values: { API_KEY: undefined } as unknown as Record<string, string>,
    }),
    /values value for API_KEY must be a string/,
  );
});

test('serializeGeneratedEnv rejects non-record objects', () => {
  assert.throws(
    () => serializeGeneratedEnv({
      toolName: 'fixture-env-switch',
      environment: 'development',
      localRedis: true,
      values: new Map([['API_KEY', 'secret']]) as unknown as Record<string, string>,
    }),
    /values must be a plain object with string values/,
  );
});

test('serializeGeneratedEnv snapshots record values during validation', () => {
  let reads = 0;
  const values = Object.defineProperty({}, 'API_KEY', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'secret' : undefined;
    },
  }) as Record<string, string>;

  const serialized = serializeGeneratedEnv({
    toolName: 'fixture-env-switch',
    environment: 'development',
    localRedis: true,
    values,
  });

  assert.match(serialized, /^API_KEY=secret$/m);
  assert.equal(reads, 1);
});
