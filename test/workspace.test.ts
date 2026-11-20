import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveExecutable } from '../src/gmic/resolve.js';
import {
  collectOutputs,
  localPath,
  prepareOutputs,
  publishOutputs,
  stageInputs,
} from '../src/gmic/workspace.js';
import { hasCode, temporaryDirectory, testConfig } from './helpers.js';

describe('executable resolution', () => {
  let directory: string;
  let executable: string;
  before(async () => {
    directory = await temporaryDirectory();
    executable = path.join(directory, process.platform === 'win32' ? 'gmic.exe' : 'gmic');
    await writeFile(executable, 'test executable');
    await chmod(executable, 0o755);
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts an executable or its directory', async () => {
    assert.equal(
      await resolveExecutable(testConfig(directory, { GMIC_MCP_BIN: executable })),
      await realpath(executable),
    );
    assert.equal(
      await resolveExecutable(testConfig(directory, { GMIC_MCP_BIN: directory })),
      await realpath(executable),
    );
  });
  it('searches the process-local PATH when no explicit binary is given', async () => {
    assert.equal(
      await resolveExecutable(testConfig(directory, { GMIC_MCP_BIN: undefined, PATH: directory })),
      await realpath(executable),
    );
  });
  it('does not fall back when a configured binary is invalid', async () => {
    await assert.rejects(
      resolveExecutable(testConfig(directory, { GMIC_MCP_BIN: 'missing', PATH: directory })),
      hasCode('GMIC_NOT_FOUND'),
    );
    await assert.rejects(
      resolveExecutable(testConfig(directory, { GMIC_MCP_BIN: undefined, PATH: '' })),
      hasCode('GMIC_NOT_FOUND'),
    );
  });
});

describe('managed files', () => {
  let directory: string;
  let job: string;
  before(async () => {
    directory = await temporaryDirectory();
    job = path.join(directory, 'job');
    await mkdir(job);
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('stages literal filenames and rejects code files in the image interface', async () => {
    const input = path.join(directory, 'commas, $ {braces} ü.png');
    await writeFile(input, 'pixels');
    const [staged] = await stageInputs(
      [input],
      job,
      testConfig(directory),
      new AbortController().signal,
    );
    assert.equal(staged?.alias, 'input_0.png');
    assert.equal(await readFile(path.join(job, staged!.alias), 'utf8'), 'pixels');
    const script = path.join(directory, 'code.gmic');
    await writeFile(script, 'cli_start : exec something');
    await assert.rejects(
      stageInputs([script], job, testConfig(directory), new AbortController().signal),
      hasCode('INVALID_PATH'),
    );
    assert.throws(
      () => localPath('https://example.com/image.png', directory),
      hasCode('INVALID_PATH'),
    );
  });

  it('enforces total input size and rejects missing files', async () => {
    await assert.rejects(
      stageInputs(['missing.png'], job, testConfig(directory), new AbortController().signal),
      hasCode('INVALID_PATH'),
    );
    const input = path.join(directory, 'large.png');
    await writeFile(input, 'too large');
    await assert.rejects(
      stageInputs(
        [input],
        job,
        testConfig(directory, { GMIC_MCP_MAX_INPUT_BYTES: '2' }),
        new AbortController().signal,
      ),
      hasCode('INPUT_TOO_LARGE'),
    );
  });

  it('rejects nonexistent parents, overlapping paths and non-file destinations', async () => {
    await assert.rejects(
      prepareOutputs([{ path: 'missing-dir/output.png' }], testConfig(directory), false),
      hasCode('INVALID_PATH'),
    );
    await assert.rejects(
      prepareOutputs([{ path: 'same.png' }, { path: './same.png' }], testConfig(directory), false),
      hasCode('INVALID_PATH'),
    );
    await mkdir(path.join(directory, 'folder.png'));
    await assert.rejects(
      prepareOutputs([{ path: 'folder.png' }], testConfig(directory), true),
      hasCode('INVALID_PATH'),
    );
  });

  it('maps real numbered files, not just the requested template', async () => {
    const config = testConfig(directory);
    const outputs = await prepareOutputs([{ path: 'many.png' }], config, false);
    await writeFile(path.join(job, 'output_0_000000.png'), 'first');
    await writeFile(path.join(job, 'output_0_000001.png'), 'second');
    const files = await collectOutputs(outputs, job, config);
    assert.deepEqual(
      files.map((file) => path.basename(file.destination)),
      ['many_000000.png', 'many_000001.png'],
    );
    await publishOutputs(files, false, new AbortController().signal);
    assert.equal(await readFile(path.join(directory, 'many_000001.png'), 'utf8'), 'second');
    await assert.rejects(
      collectOutputs(outputs, job, testConfig(directory, { GMIC_MCP_MAX_OUTPUT_FILES: '1' })),
      hasCode('OUTPUT_LIMIT'),
    );
  });

  it('protects against a competing writer and cancellation at publication', async () => {
    const config = testConfig(directory);
    const [output] = await prepareOutputs([{ path: 'race.png' }], config, false);
    const staged = path.join(job, 'race-source.png');
    await writeFile(staged, 'new');
    const file = { staged, alias: 'race-source.png', destination: output!.destination, bytes: 3 };
    await writeFile(file.destination, 'other writer');
    await assert.rejects(
      publishOutputs([file], false, new AbortController().signal),
      hasCode('OUTPUT_EXISTS'),
    );
    assert.equal(await readFile(file.destination, 'utf8'), 'other writer');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      publishOutputs(
        [{ ...file, destination: path.join(directory, 'cancelled.png') }],
        false,
        controller.signal,
      ),
      hasCode('CANCELLED'),
    );
    assert.ok(!(await readdir(directory)).includes('cancelled.png'));
  });
});
