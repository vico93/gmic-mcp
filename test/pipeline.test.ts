import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileStep, parseBitDepth, parseMetadata } from '../src/gmic/pipeline.js';
import {
  helpSchema,
  imageInfoSchema,
  pipelineSchema,
  scriptSchema,
  stepSchema,
} from '../src/schemas.js';
import { hasCode } from './helpers.js';

describe('pipeline syntax and schemas', () => {
  it('keeps native formulas intact and adds explicit selections/copy mode', () => {
    const step = stepSchema.parse({
      command: 'fill',
      arguments: 'x + y + c',
      selection: '-1',
      copy: true,
    });
    assert.equal(compileStep(step), '+fill[-1] x + y + c');
    assert.equal(compileStep(stepSchema.parse({ command: '+', arguments: '5' })), '-+ 5');
    assert.equal(compileStep(stepSchema.parse({ command: '-', arguments: '5' })), '-sub 5');
    assert.equal(compileStep(stepSchema.parse({ command: 'box3d' })), '-box3d ,');
  });

  it('rejects shell fragments/decorated names and malformed selections', () => {
    assert.equal(stepSchema.safeParse({ command: 'blur; exec' }).success, false);
    assert.equal(stepSchema.safeParse({ command: 'blur[0]' }).success, false);
    assert.equal(stepSchema.safeParse({ command: 'blur', selection: '[0]' }).success, false);
    assert.equal(
      stepSchema.safeParse({ command: 'blur', arguments: '1\nexec anything' }).success,
      false,
    );
    assert.equal(helpSchema.safeParse({ command: 'blur exec anything' }).success, false);
    assert.equal(
      imageInfoSchema.safeParse({ input: { path: 'image.png', options: '8 -exec anything' } })
        .success,
      false,
    );
    assert.equal(
      imageInfoSchema.safeParse({ input: { path: 'image.png', options: '${"exec anything"}' } })
        .success,
      false,
    );
    assert.equal(
      imageInfoSchema.safeParse({ input: { path: 'image.raw', options: 'uint8,128,128' } }).success,
      true,
    );
  });

  it('supports conversion without steps and generation without path inputs', () => {
    assert.equal(
      pipelineSchema.parse({ inputs: ['image.png'], outputs: [{ path: 'result.jpg' }] }).steps
        .length,
      0,
    );
    assert.equal(
      pipelineSchema.safeParse({
        outputs: [{ path: 'result.png' }],
        steps: [{ command: 'input', arguments: '8,8,1,3' }],
      }).success,
      true,
    );
    assert.equal(pipelineSchema.safeParse({ outputs: [{ path: 'result.png' }] }).success, false);
  });

  it('requires exactly one script source', () => {
    assert.equal(scriptSchema.safeParse({}).success, false);
    assert.equal(scriptSchema.safeParse({ script: '_main_:', path: 'script.gmic' }).success, false);
    assert.equal(scriptSchema.parse({ script: '_main_ : blur 1' }).entrypoint, '_main_');
  });
});

describe('machine-readable native metadata', () => {
  it('parses dimension/statistic markers instead of human log messages', () => {
    const images = parseMetadata('noise\nMETA:0,8,6,1,3,0,14,7,9\n', 'META');
    assert.deepEqual(images[0], {
      index: 0,
      width: 8,
      height: 6,
      depth: 1,
      channels: 3,
      pixelCount: 144,
      min: 0,
      max: 14,
      mean: 7,
      standardDeviation: 3,
    });
    assert.equal(parseMetadata('OTHER:0,1,1,1,1,0,1,1,0', 'META').length, 0);
  });

  it('represents non-finite statistics as null and rejects malformed dimensions', () => {
    assert.equal(parseMetadata('META:0,1,1,1,1,nan,inf,nan,nan', 'META')[0]?.min, null);
    assert.throws(
      () => parseMetadata('META:0,-1,1,1,1,0,0,0,0', 'META'),
      hasCode('INVALID_METADATA'),
    );
    assert.throws(() => parseMetadata('META:0,1,1', 'META'), hasCode('INVALID_METADATA'));
    assert.throws(
      () => parseMetadata('META:0,1,1,1,1,0,0,0,0\nMETA_COUNT:2', 'META'),
      hasCode('INVALID_METADATA'),
    );
    assert.equal(parseBitDepth('BITS:16', 'BITS'), 16);
    assert.equal(parseBitDepth('BITS:filename', 'BITS'), null);
  });
});
