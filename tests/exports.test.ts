import assert from 'node:assert/strict';
import test from 'node:test';
import * as packageApi from '../src/index.js';

test('package root does not expose the unvalidated config file reader', () => {
  assert.equal(Object.hasOwn(packageApi, 'loadConfigFile'), false);
});
