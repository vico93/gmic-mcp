import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GmicError, abortError, checkAbort, errorCode } from '../errors.js';

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  logsTruncated: boolean;
  durationMs: number;
}

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxLogBytes: number;
  signal?: AbortSignal | undefined;
}

/** Retain the tail, so end-of-run metadata survives verbose scripts. */
export class BoundedLog {
  private chunks: Buffer[] = [];
  private retained = 0;
  public bytes = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (chunk.length >= this.limit) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.limit))];
      this.retained = this.limit;
      return;
    }
    this.chunks.push(chunk);
    this.retained += chunk.length;
    while (this.retained > this.limit) {
      const first = this.chunks[0]!;
      const excess = this.retained - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.retained -= first.length;
      } else {
        this.chunks[0] = Buffer.from(first.subarray(excess));
        this.retained -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.retained).toString('utf8');
  }
}

interface Waiter {
  start: () => void;
  cancel: () => void;
}

export class ProcessRunner {
  private active = 0;
  private waiting: Waiter[] = [];
  private shutdown = new AbortController();
  private pending = new Set<Promise<ProcessResult>>();

  constructor(private readonly maxConcurrency: number) {}

  get status(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  run(request: ProcessRequest): Promise<ProcessResult> {
    const promise = this.execute(request);
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  async close(): Promise<void> {
    this.shutdown.abort(new GmicError('SHUTDOWN', 'The MCP server is shutting down.'));
    await Promise.allSettled([...this.pending]);
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    if (this.waiting.length >= 128)
      throw new GmicError('QUEUE_FULL', 'The execution queue is full.');
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          signal.removeEventListener('abort', waiter.cancel);
          this.active++;
          resolve(() => this.release());
        },
        cancel: () => {
          this.waiting = this.waiting.filter((item) => item !== waiter);
          reject(abortError(signal));
        },
      };
      signal.addEventListener('abort', waiter.cancel, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.start();
  }

  private async execute(request: ProcessRequest): Promise<ProcessResult> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new GmicError('TIMEOUT', `G'MIC exceeded ${request.timeoutMs} ms.`)),
      request.timeoutMs,
    );
    timer.unref();
    const signal = AbortSignal.any([
      deadline.signal,
      this.shutdown.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    let release: (() => void) | undefined;
    try {
      release = await this.acquire(signal);
      checkAbort(signal);
      return await this.spawn(request, signal);
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }

  private spawn(request: ProcessRequest, signal: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const stdout = new BoundedLog(request.maxLogBytes);
      const stderr = new BoundedLog(request.maxLogBytes);
      let child: ChildProcess;
      try {
        child = spawn(request.executable, request.args, {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new GmicError('GMIC_FAILED', `Could not launch G'MIC: ${String(error)}`));
        return;
      }
      let finished = false;
      let exitTimer: NodeJS.Timeout | undefined;
      let stopping: Promise<void> | undefined;
      const onAbort = () => {
        stopping ??= this.stop(child, request.env);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      child.stdout!.on('data', (chunk: Buffer) => stdout.append(chunk));
      child.stderr!.on('data', (chunk: Buffer) => stderr.append(chunk));
      const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(exitTimer);
        signal.removeEventListener('abort', onAbort);
        child.stdout?.destroy();
        child.stderr?.destroy();
        const result: ProcessResult = {
          exitCode,
          signal: exitSignal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          logsTruncated: stdout.bytes > request.maxLogBytes || stderr.bytes > request.maxLogBytes,
          durationMs: Math.round(performance.now() - started),
        };
        // Await tree cleanup before the caller removes the job directory.
        void (stopping ?? Promise.resolve()).then(() => {
          if (signal.aborted) {
            const error = abortError(signal);
            reject(
              new GmicError(error.code, error.message, { ...error.details, diagnostics: result }),
            );
          } else if (exitCode !== 0) {
            reject(
              new GmicError(
                'GMIC_FAILED',
                `G'MIC exited with ${exitSignal ?? `code ${exitCode}`}.`,
                {
                  diagnostics: result,
                },
              ),
            );
          } else resolve(result);
        });
      };
      child.once('error', (error) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        clearTimeout(exitTimer);
        reject(
          new GmicError(
            errorCode(error) === 'ENOENT' ? 'GMIC_NOT_FOUND' : 'GMIC_FAILED',
            `Could not launch ${request.executable}: ${error.message}`,
          ),
        );
      });
      child.once('close', finish);
      // A detached descendant can retain pipes after the main process exits.
      child.once('exit', (code, exitSignal) => {
        exitTimer = setTimeout(() => finish(code, exitSignal), 250);
      });
    });
  }

  private async stop(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<void> {
    if (!child.pid) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      return;
    }
    const root = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
    await new Promise<void>((resolve) => {
      const killer = spawn(
        root ? path.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { env, windowsHide: true, shell: false, stdio: 'ignore' },
      );
      const timer = setTimeout(() => {
        killer.kill();
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      const done = () => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve();
      };
      killer.once('error', done);
      killer.once('exit', done);
    });
  }
}
