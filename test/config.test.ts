import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { childEnvironment, loadConfig } from '../src/config.js';
import { hasCode } from './helpers.js';

describe('configuration', () => {
  it('uses conservative defaults and never changes the supplied environment', () => {
    const env = { GMIC_MCP_BIN: 'gmic', GMIC_PATH: 'personal-settings' };
    const config = loadConfig(env);
    assert.equal(config.maxConcurrency, 1);
    assert.equal(config.timeoutMs, 120_000);
    assert.equal(config.guiCatalog, 'auto');
    assert.equal(config.enableRaw, false);
    assert.deepEqual(env, { GMIC_MCP_BIN: 'gmic', GMIC_PATH: 'personal-settings' });
  });

  it('validates configuration rather than silently coercing it', () => {
    for (const value of ['', '0', '-1', '1.5', '17', 'oops']) {
      assert.throws(
        () => loadConfig({ GMIC_MCP_MAX_CONCURRENCY: value }),
        hasCode('CONFIGURATION_ERROR'),
      );
    }
    assert.throws(
      () => loadConfig({ GMIC_MCP_BIN: '"/path/to/gmic"' }),
      hasCode('CONFIGURATION_ERROR'),
    );
    assert.throws(() => loadConfig({ GMIC_MCP_BIN: '' }), hasCode('CONFIGURATION_ERROR'));
    assert.throws(() => loadConfig({ GMIC_MCP_STATE_DIR: '' }), hasCode('CONFIGURATION_ERROR'));
    assert.throws(
      () => loadConfig({ GMIC_MCP_PASS_ENV: 'GOOD,bad=value' }),
      hasCode('CONFIGURATION_ERROR'),
    );
    assert.throws(
      () => loadConfig({ GMIC_MCP_ENABLE_RAW: 'sometimes' }),
      hasCode('CONFIGURATION_ERROR'),
    );
  });

  it('does not forward harness credentials and isolates native state', () => {
    const original = {
      Path: 'old-path',
      SYSTEMROOT: 'system-root',
      HOME: 'home',
      GMIC_PATH: 'personal-settings',
      SENSITIVE_VALUE: 'test-only-placeholder',
      CUSTOM_TOKEN: 'explicit',
      GMIC_MCP_PASS_ENV: 'CUSTOM_TOKEN,GMIC_PATH',
    };
    const config = loadConfig(original);
    const child = childEnvironment(config, path.resolve('gmic.exe'), path.resolve('job'));
    assert.equal(child.SENSITIVE_VALUE, undefined);
    assert.equal(child.CUSTOM_TOKEN, 'explicit');
    assert.equal(child.GMIC_PATH, path.resolve('job', 'gmic'));
    assert.equal(child.TMP, path.resolve('job'));
    assert.equal(Object.keys(child).filter((key) => key.toUpperCase() === 'PATH').length, 1);
    assert.equal(original.GMIC_PATH, 'personal-settings');
  });
});
