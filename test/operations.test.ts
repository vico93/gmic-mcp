import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  buildRegistry,
  compileOperation,
  describeOperation,
  discoverOperations,
  parseGuiOperations,
} from '../src/gmic/operations.js';
import { hasCode } from './helpers.js';

async function registry() {
  const gui = parseGuiOperations(
    JSON.parse(await readFile('test/fixtures/gui-catalog.json', 'utf8')),
  );
  return buildRegistry(
    [
      {
        name: 'blur',
        category: 'Filters',
        arguments: 'sigma',
        description: 'Blur images.',
        documentation: 'Blur selected images.',
      },
      {
        name: 'resize',
        category: 'Geometry',
        arguments: 'width,height',
        description: 'Resize images.',
        documentation: 'Resize selected images.',
      },
    ],
    gui.filters,
    [],
    gui.sourceVersion,
  );
}

describe('unified operation registry', () => {
  it('discovers GUI filters by human title and compact command spelling', async () => {
    const index = await registry();
    for (const query of [
      'dream smoothing',
      'dreamsmooth',
      'fx_dreamsmooth',
      'make photo dreamlike',
      'suavizar sonho',
    ]) {
      assert.equal(
        discoverOperations(index, {
          query,
          kind: 'all',
          interactive: 'exclude',
          offset: 0,
          limit: 10,
        })[0]?.operationId,
        'filter:fx_dreamsmooth',
      );
    }
  });

  it('returns real colorization operations and excludes interactive filters by default', async () => {
    const results = discoverOperations(await registry(), {
      query: 'colorize',
      kind: 'all',
      interactive: 'exclude',
      offset: 0,
      limit: 10,
    });
    assert.ok(results.some((item) => item.operationId === 'filter:fx_recolorize'));
    assert.ok(results.some((item) => item.operationId === 'filter:fx_bwrecolorize'));
    assert.ok(!results.some((item) => item.operationId === 'filter:fx_colorize_interactive'));
    assert.ok(!results.some((item) => item.operationId === 'filter:fx_colorize'));
  });

  it('describes named parameters and all defaults', async () => {
    const operation = (await registry()).byId.get('filter:fx_dreamsmooth')!;
    const defaults = describeOperation(operation).default_parameters as Record<string, unknown>;
    assert.equal(defaults.iterations, 3);
    assert.equal(defaults.equalize_at_each_step, true);
    assert.equal(defaults.merging_option, 'alpha');
    assert.equal(defaults.spatial_overlap, 24);
  });

  it('can page one choice parameter without returning the full descriptor', async () => {
    const operation = (await registry()).byId.get('filter:fx_dreamsmooth')!;
    const result = describeOperation(operation, {
      parameterKey: 'merging_option',
      choiceOffset: 0,
      choiceLimit: 2,
    });
    const parameter = (result.parameters as Record<string, unknown>[])[0]!;
    assert.equal(Object.keys(parameter.choices as object).length, 2);
    assert.equal(parameter.choices_truncated, true);
    assert.equal(result.default_parameters, undefined);
  });

  it('compiles filter defaults and named overrides into complete positional arguments', async () => {
    const operation = (await registry()).byId.get('filter:fx_dreamsmooth')!;
    const compiled = compileOperation(operation, {
      operation_id: operation.operationId,
      parameters: { iterations: 4, merging_option: 'average', opacity: 0.75 },
      copy: false,
    });
    assert.equal(compiled.arguments, '4,1,2,0.75,0,0.8,1,24,0');
  });

  it('rejects unknown and out-of-range parameters before native execution', async () => {
    const operation = (await registry()).byId.get('filter:fx_dreamsmooth')!;
    assert.throws(
      () =>
        compileOperation(operation, {
          operation_id: operation.operationId,
          parameters: { made_up: 1 },
          copy: false,
        }),
      hasCode('UNKNOWN_PARAMETER'),
    );
    assert.throws(
      () =>
        compileOperation(operation, {
          operation_id: operation.operationId,
          parameters: { opacity: 2 },
          copy: false,
        }),
      hasCode('VALUE_OUT_OF_RANGE'),
    );
  });

  it('keeps documented CLI commands exact and positional', async () => {
    const operation = (await registry()).byId.get('cli:blur')!;
    const compiled = compileOperation(operation, {
      operation_id: 'cli:blur',
      arguments: '1.5',
      selection: '0',
      copy: false,
    });
    assert.deepEqual(compiled, {
      command: 'blur',
      arguments: '1.5',
      selection: '0',
      copy: false,
    });
  });
});
