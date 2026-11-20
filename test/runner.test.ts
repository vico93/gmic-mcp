import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { BoundedLog, ProcessRunner, type ProcessRequest } from '../src/gmic/runner.js';
import { hasCode, temporaryDirectory } from './helpers.js';

describe('bounded logs', () => {
  it('retains a bounded tail with total byte counts', () => {
    const log = new BoundedLog(6);
    log.append(Buffer.from('abc'));
    log.append(Buffer.from('defg'));
    assert.equal(log.text(), 'bcdefg');
    assert.equal(log.bytes, 7);
    log.append(Buffer.from('0123456789'));
    assert.equal(log.text(), '456789');
    assert.equal(log.bytes, 17);
  });
});

describe('process runner', () => {
  let directory: string;
  let runner: ProcessRunner;
  before(async () => {
    directory = await temporaryDirectory();
    runner = new ProcessRunner(1);
  });
  after(async () => {
    await runner.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (args: string[], overrides: Partial<ProcessRequest> = {}): ProcessRequest => ({
    executable: process.execPath,
    args: [path.resolve('test/fixtures/process.mjs'), ...args],
    cwd: directory,
    env: { ...process.env },
    timeoutMs: 5000,
    maxLogBytes: 1024,
    ...overrides,
  });

  it('passes literal argument arrays without a shell', async () => {
    const args = [
      'spaces here',
      'quote"here',
      '$variable',
      '{x+y}',
      'comma,path',
      'ü',
      '& echo BAD',
    ];
    const result = await runner.run(request(['echo', ...args]));
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(result.exitCode, 0);
  });

  it('reports native failure with captured stderr', async () => {
    await assert.rejects(runner.run(request(['error'])), (error: unknown) => {
      assert.ok(hasCode('GMIC_FAILED')(error));
      assert.match(JSON.stringify(error), /fixture failure/);
      return true;
    });
  });

  it('drains both streams while bounding retained data', async () => {
    const result = await runner.run(request(['logs']));
    assert.equal(result.stdoutBytes, 50_003);
    assert.ok(result.stdout.endsWith('END'));
    assert.ok(result.stderr.endsWith('TAIL'));
    assert.equal(result.logsTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 1026);
  });

  it('limits concurrency and starts queued work after release', async () => {
    const first = runner.run(request(['sleep', '200']));
    const second = runner.run(request(['echo', 'queued']));
    assert.deepEqual(runner.status, { active: 1, queued: 1 });
    await first;
    assert.equal((await second).stdout, '["queued"]');
    assert.deepEqual(runner.status, { active: 0, queued: 0 });
  });

  it('cancels queued work without starting it', async () => {
    const first = runner.run(request(['sleep', '200']));
    const controller = new AbortController();
    const second = runner.run(request(['echo', 'never'], { signal: controller.signal }));
    controller.abort();
    await assert.rejects(second, hasCode('CANCELLED'));
    await first;
    assert.deepEqual(runner.status, { active: 0, queued: 0 });
  });

  it('counts queue wait against the timeout', async () => {
    const first = runner.run(request(['sleep', '400']));
    await assert.rejects(
      runner.run(request(['echo', 'never'], { timeoutMs: 100 })),
      hasCode('TIMEOUT'),
    );
    await first;
  });

  it('terminates a timed-out native process and releases its slot', async () => {
    await assert.rejects(
      runner.run(request(['sleep', '10000'], { timeoutMs: 200 })),
      hasCode('TIMEOUT'),
    );
    assert.equal(
      (await runner.run(request(['echo', 'after-timeout']))).stdout,
      '["after-timeout"]',
    );
  });

  it('cancels in-flight work', async () => {
    const controller = new AbortController();
    const pending = runner.run(request(['sleep', '10000'], { signal: controller.signal }));
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await assert.rejects(pending, hasCode('CANCELLED'));
    } finally {
      clearTimeout(timer);
    }
  });

  it('cleans up ordinary child process trees', async () => {
    let childPid: number | undefined;
    await assert.rejects(runner.run(request(['tree'], { timeoutMs: 1500 })), (error: unknown) => {
      assert.ok(hasCode('TIMEOUT')(error));
      const found = /CHILD:(\d+)/.exec(JSON.stringify(error));
      childPid = found ? Number(found[1]) : undefined;
      return true;
    });
    assert.ok(childPid, 'fixture child must have started');
    assert.throws(() => process.kill(childPid!, 0));
  });

  it('aborts active and queued requests on shutdown', async () => {
    const instance = new ProcessRunner(1);
    const first = instance.run(request(['sleep', '10000']));
    const second = instance.run(request(['echo', 'queued']));
    const settled = Promise.allSettled([first, second]);
    await instance.close();
    assert.ok(
      (await settled).every(
        (result) => result.status === 'rejected' && hasCode('SHUTDOWN')(result.reason),
      ),
    );
    await assert.rejects(instance.run(request(['echo', 'closed'])), hasCode('SHUTDOWN'));
  });
});
