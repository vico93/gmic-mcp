import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GmicService } from '../src/gmic/service.js';
import { executeSchema, pipelineSchema, scriptSchema } from '../src/schemas.js';
import { hasCode, temporaryDirectory, testConfig } from './helpers.js';

const binary = process.env.GMIC_MCP_TEST_BIN;

describe("real G'MIC integration", { skip: !binary }, () => {
  let directory: string;
  let service: GmicService;
  let image: string;
  let original: Buffer;
  before(async () => {
    directory = await temporaryDirectory();
    service = new GmicService(
      testConfig(directory, { GMIC_MCP_BIN: binary!, GMIC_MCP_TIMEOUT_MS: '30000' }),
    );
    image = path.join(directory, 'source, $ {curly} ü.png');
    await service.runPipeline(
      pipelineSchema.parse({
        steps: [{ command: 'input', arguments: '64,48,1,3,x+y+10*c' }],
        outputs: [{ path: image, options: '16' }],
      }),
    );
    original = await readFile(image);
  });
  after(async () => {
    await service?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('reports the actual native version and flags', async () => {
    const info = await service.info();
    assert.match(String(info.version), /^\d+\.\d+\.\d+$/);
    assert.ok(info.buildFlags);
    assert.ok(info.pixelType);
  });

  it('exports and searches the local documented catalogue without networking', async () => {
    const result = await service.search('blur', undefined, 0, 5);
    const docs = result.commands as { name: string }[];
    assert.ok(Number(result.total) > 5);
    assert.equal(docs[0]?.name, 'blur');
    const all = await service.search('', undefined, 0, 1);
    assert.ok(Number(all.total) > 800);
  });

  it('retrieves native help and treats missing documentation as unavailable', async () => {
    assert.match(String((await service.help('blur')).documentation), /deviation/);
    assert.equal((await service.help('mcp_nonexistent_command_zzzz')).available, false);
  });

  it('discovers, describes, and executes Dream Smoothing with complete GUI defaults', async () => {
    const filterService = new GmicService(
      testConfig(directory, {
        GMIC_MCP_BIN: binary!,
        GMIC_MCP_TIMEOUT_MS: '30000',
        GMIC_MCP_STATE_DIR: path.join(directory, 'filter-state'),
        GMIC_MCP_GUI_CATALOG: path.resolve('test/fixtures/gui-catalog.json'),
      }),
    );
    try {
      const discovered = await filterService.discover({
        query: 'dream smoothing',
        kind: 'all',
        interactive: 'exclude',
        offset: 0,
        limit: 10,
      });
      const results = discovered.results as { operation_id: string }[];
      assert.equal(results[0]?.operation_id, 'filter:fx_dreamsmooth');
      const described = await filterService.describe('filter:fx_dreamsmooth');
      assert.equal((described.default_parameters as Record<string, unknown>).spatial_overlap, 24);

      const output = path.join(directory, 'dream-defaults.png');
      const executed = await filterService.executeOperations(
        executeSchema.parse({
          inputs: [image],
          operations: [{ operation_id: 'filter:fx_dreamsmooth' }],
          outputs: [{ path: output }],
        }),
      );
      assert.equal(executed.outputs[0]?.images[0]?.width, 64);
      assert.equal(
        (executed.applied_operations[0] as { operation_id: string }).operation_id,
        'filter:fx_dreamsmooth',
      );
      await assert.rejects(
        filterService.describe('filter:fx_colorize'),
        hasCode('UNKNOWN_OPERATION'),
      );
    } finally {
      await filterService.close();
    }
  });

  it('reads accurate dimensions, statistics, and PNG bit depth from a staged input', async () => {
    const info = await service.imageInfo(image);
    const images = info.images as { width: number; height: number; channels: number }[];
    assert.equal(images[0]?.width, 64);
    assert.equal(images[0]?.height, 48);
    assert.equal(images[0]?.channels, 3);
    assert.equal(info.sourceBitDepth, 16);
    assert.deepEqual(await readFile(image), original);
  });

  it('resizes with native formulas and returns a bounded PNG preview', async () => {
    const result = await service.runPipeline(
      pipelineSchema.parse({
        inputs: [image],
        steps: [
          { command: 'resize', arguments: '50%,50%' },
          { command: 'blur', arguments: '1.5' },
        ],
        outputs: [{ path: path.join(directory, 'edited, $ ü.png'), options: '16' }],
        preview: true,
      }),
    );
    assert.equal(result.outputs[0]?.images[0]?.width, 32);
    assert.equal(result.outputs[0]?.images[0]?.height, 24);
    assert.ok(result.preview);
    assert.deepEqual(
      Buffer.from(result.preview.data, 'base64').subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.deepEqual(await readFile(image), original);
  });

  it('preserves originals with copy mode and exports actual numbered paths', async () => {
    const result = await service.runPipeline(
      pipelineSchema.parse({
        inputs: [image],
        steps: [{ command: 'mirror', arguments: 'x', copy: true }],
        outputs: [{ path: path.join(directory, 'multiple.png') }],
      }),
    );
    assert.equal(result.stack.length, 2);
    assert.equal(result.outputs.length, 2);
    for (const output of result.outputs)
      assert.match(path.basename(output.path), /^multiple_\d+\.png$/);
  });

  it('supports native JPEG, TIFF and WebP output options when built in', async (context) => {
    const flags = String((await service.info()).buildFlags).toLowerCase();
    const formats = [
      { flag: 'jpeg', extension: 'jpg', options: '90' },
      { flag: 'tiff', extension: 'tif', options: 'uint16,deflate' },
      { flag: 'webp', extension: 'webp', options: '80' },
    ].filter((format) => flags.includes(format.flag));
    assert.ok(formats.length > 0, 'at least one additional native codec is expected');
    const result = await service.runPipeline(
      pipelineSchema.parse({
        inputs: [image],
        outputs: formats.map((format) => ({
          path: path.join(directory, `codec.${format.extension}`),
          options: format.options,
        })),
      }),
    );
    assert.equal(result.outputs.length, formats.length);
    for (const output of result.outputs) assert.equal(output.images[0]?.width, 64);
    context.diagnostic(
      `Checked native codecs: ${formats.map((format) => format.extension).join(', ')}`,
    );
  });

  it('preserves signed floating point data in GMZ and does not flatten volumes', async () => {
    const signed = await service.runPipeline(
      pipelineSchema.parse({
        steps: [{ command: 'input', arguments: '8,6,1,1,x/10-2' }],
        outputs: [{ path: path.join(directory, 'signed.gmz') }],
      }),
    );
    assert.equal(signed.outputs[0]?.images[0]?.min, -2);
    assert.ok(Math.abs(signed.outputs[0]!.images[0]!.max! + 1.3) < 1e-6);
    const volume = await service.runPipeline(
      pipelineSchema.parse({
        steps: [{ command: 'input', arguments: '8,6,4,2,x+y+z+c' }],
        outputs: [{ path: path.join(directory, 'volume.gmz') }],
        preview: true,
      }),
    );
    assert.equal(volume.outputs[0]?.images[0]?.depth, 4);
    assert.equal(volume.preview, undefined);
    assert.ok(volume.warnings.length > 0);
  });

  it('runs inline scripts with the default entrypoint and arguments', async () => {
    const result = await service.runScript(
      scriptSchema.parse({
        inputs: [image],
        script: '_main_ :\n  -resize $1,$2\n',
        arguments: '8,6',
        outputs: [{ path: path.join(directory, 'inline.png') }],
      }),
    );
    assert.equal(result.outputs[0]?.images[0]?.width, 8);
    assert.equal(result.outputs[0]?.images[0]?.height, 6);
  });

  it('does not mistake a one-column 3D object payload for a 2D preview', async () => {
    const result = await service.runPipeline(
      pipelineSchema.parse({
        steps: [{ command: 'box3d' }],
        outputs: [{ path: path.join(directory, 'cube.off') }],
        preview: true,
      }),
    );
    assert.ok(result.outputs[0]!.bytes > 0);
    assert.equal(result.preview, undefined);
    assert.ok(result.warnings.length > 0);
  });

  it('supports custom defaults, variables and loops without shell expansion', async () => {
    const result = await service.runScript(
      scriptSchema.parse({
        inputs: [image],
        script:
          '_main_ :\n  factor=${1=2}\n  -repeat 2 {\n    -div $factor\n  }\n  +echo "script completed"\n',
        arguments: '2',
        outputs: [{ path: path.join(directory, 'loop.gmz') }],
      }),
    );
    assert.ok(Math.abs(result.stack[0]!.max! - 32.5) < 1e-6);
    assert.match(result.diagnostics.stdout, /script completed/);
  });

  it('handles the subtraction shortcut without deprecated double-hyphen syntax', async () => {
    const result = await service.runPipeline(
      pipelineSchema.parse({
        steps: [
          { command: 'input', arguments: '8,6,1,1,x+y' },
          { command: '-', arguments: '5' },
        ],
        outputs: [{ path: path.join(directory, 'subtraction.gmz') }],
      }),
    );
    assert.equal(result.stack[0]?.min, -5);
  });

  it('stages script files and explicit imports, including unusual Windows filenames', async () => {
    const script = path.join(directory, 'custom, $ ü.gmic');
    const imported = path.join(directory, 'imported.gmic');
    await writeFile(script, 'main : imported_resize $1,$2\n');
    await writeFile(imported, 'imported_resize : -resize $1,$2\n');
    const result = await service.runScript(
      scriptSchema.parse({
        inputs: [image],
        path: script,
        command_files: [imported],
        entrypoint: 'main',
        arguments: '7,5',
        outputs: [{ path: path.join(directory, 'from-file.png') }],
      }),
    );
    assert.equal(result.outputs[0]?.images[0]?.width, 7);
  });

  it('protects existing outputs, and permits explicit in-place replacement', async () => {
    const target = path.join(directory, 'exists.png');
    await writeFile(target, 'untouched');
    const args = pipelineSchema.parse({ inputs: [image], outputs: [{ path: target }] });
    await assert.rejects(service.runPipeline(args), hasCode('OUTPUT_EXISTS'));
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    const result = await service.runPipeline(pipelineSchema.parse({ ...args, overwrite: true }));
    assert.equal(result.outputs.length, 1);
    assert.notEqual((await readFile(target)).toString(), 'untouched');
    const inPlace = path.join(directory, 'in-place.png');
    await writeFile(inPlace, original);
    const edited = await service.runPipeline(
      pipelineSchema.parse({
        inputs: [inPlace],
        steps: [{ command: 'resize', arguments: '50%,50%' }],
        outputs: [{ path: inPlace }],
        overwrite: true,
      }),
    );
    assert.equal(edited.outputs[0]?.images[0]?.width, 32);
    assert.deepEqual(await readFile(image), original);
  });

  it('warns when the stack contains values outside an integer export range', async () => {
    const result = await service.runPipeline(
      pipelineSchema.parse({
        steps: [{ command: 'input', arguments: '8,6,1,1,x/10-2' }],
        outputs: [{ path: path.join(directory, 'integer-range.png'), options: '8' }],
      }),
    );
    assert.equal(result.stack[0]?.min, -2);
    assert.ok(result.warnings.some((warning) => warning.includes('outside the integer range')));
  });

  it('does not publish outputs after native failure or an early script quit', async () => {
    const target = path.join(directory, 'must-not-exist.png');
    await assert.rejects(
      service.runPipeline(
        pipelineSchema.parse({
          inputs: [image],
          steps: [{ command: 'mcp_nonexistent_command_zzzz' }],
          outputs: [{ path: target }],
        }),
      ),
      hasCode('GMIC_FAILED'),
    );
    await assert.rejects(readFile(target));
    await assert.rejects(
      service.runScript(
        scriptSchema.parse({ script: '_main_ : -quit', outputs: [{ path: target }] }),
      ),
      hasCode('OUTPUT_MISSING'),
    );
  });

  it('honors timeout ceilings and cleans up jobs after failure', async () => {
    await assert.rejects(
      service.runScript(scriptSchema.parse({ script: '_main_ : -wait 2000', timeout_ms: 200 })),
      hasCode('TIMEOUT'),
    );
    await assert.rejects(service.imageInfo(image, 30_001), hasCode('CONFIGURATION_ERROR'));
    assert.deepEqual(await readdir(path.join(service.config.stateDir, 'jobs')), []);
  });
});
