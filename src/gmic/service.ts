import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { childEnvironment, type Config } from '../config.js';
import { GmicError, checkAbort } from '../errors.js';
import type {
  DiscoverArgs,
  ExecuteArgs,
  ExecutionArgs,
  Input,
  PipelineArgs,
  ScriptArgs,
} from '../schemas.js';
import { parseCatalogue, type CommandDoc } from './catalogue.js';
import {
  buildRegistry,
  compileOperation,
  describeOperation,
  discoverOperations,
  operationSuggestions,
  parseGuiOperations,
  type Operation,
  type OperationRegistry,
} from './operations.js';
import {
  commandFile,
  compileStep,
  inputLines,
  metadataLines,
  outputLines,
  parseBitDepth,
  parseMetadata,
  type ImageMetadata,
} from './pipeline.js';
import { resolveExecutable } from './resolve.js';
import { ProcessRunner, type ProcessResult } from './runner.js';
import {
  collectOutputs,
  mimeType,
  prepareOutputs,
  publishOutputs,
  stageCommands,
  stageInputs,
  type ProducedFile,
} from './workspace.js';

interface Job {
  directory: string;
  executable: string;
  signal: AbortSignal;
  token: string;
  run: (args: string[]) => Promise<ProcessResult>;
  program: (name: string, lines: string[], verbosity?: number) => Promise<ProcessResult>;
}

export interface OutputArtifact {
  path: string;
  mimeType: string;
  bytes: number;
  images: ImageMetadata[];
  sourceBitDepth: number | null;
}

export interface ExecutionResult {
  outputs: OutputArtifact[];
  stack: ImageMetadata[];
  inputPaths: string[];
  durationMs: number;
  diagnostics: ProcessResult;
  warnings: string[];
  preview?: { data: string; mimeType: 'image/png'; sourcePath: string };
}

interface NativeIdentity {
  executable: string;
  numericVersion: string;
  version: string | null;
  flags: string | null;
  pixelType: string | null;
}

export class GmicService {
  public readonly runner: ProcessRunner;
  private shutdown = new AbortController();
  private jobs = new Set<Promise<unknown>>();
  private registryCache: OperationRegistry | undefined;
  private cliRegistryCache: OperationRegistry | undefined;
  private commandDocsCache: CommandDoc[] | undefined;
  private identityCache: NativeIdentity | undefined;
  private filterAvailability = new Map<string, boolean>();

  constructor(public readonly config: Config) {
    this.runner = new ProcessRunner(config.maxConcurrency);
  }

  async close(): Promise<void> {
    this.shutdown.abort(new GmicError('SHUTDOWN', 'The MCP server is shutting down.'));
    await Promise.allSettled([this.runner.close(), ...this.jobs]);
  }

  private withJob<T>(
    callback: (job: Job) => Promise<T>,
    timeoutMs?: number,
    external?: AbortSignal,
  ): Promise<T> {
    const pending = this.executeJob(callback, timeoutMs, external);
    this.jobs.add(pending);
    void pending.finally(() => this.jobs.delete(pending)).catch(() => {});
    return pending;
  }

  private async executeJob<T>(
    callback: (job: Job) => Promise<T>,
    requestedTimeout?: number,
    external?: AbortSignal,
  ): Promise<T> {
    const timeoutMs = requestedTimeout ?? this.config.timeoutMs;
    if (timeoutMs < 100 || timeoutMs > this.config.timeoutMs || !Number.isInteger(timeoutMs)) {
      throw new GmicError(
        'CONFIGURATION_ERROR',
        `timeout_ms must be between 100 and the configured ceiling of ${this.config.timeoutMs}.`,
      );
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new GmicError('TIMEOUT', `Operation exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref();
    const signal = AbortSignal.any([
      deadline.signal,
      this.shutdown.signal,
      ...(external ? [external] : []),
    ]);
    let directory: string | undefined;
    try {
      checkAbort(signal);
      const executable = await resolveExecutable(this.config);
      checkAbort(signal);
      await mkdir(path.join(this.config.stateDir, 'jobs'), { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(this.config.stateDir, 'jobs', 'job-'));
      await mkdir(path.join(directory, 'gmic'), { mode: 0o700 });
      const jobDir = directory;
      const env = childEnvironment(this.config, executable, directory);
      const run = (args: string[]) => {
        checkAbort(signal);
        return this.runner.run({
          executable,
          args,
          cwd: jobDir,
          env,
          timeoutMs,
          maxLogBytes: this.config.maxLogBytes,
          signal,
        });
      };
      const job: Job = {
        directory,
        executable,
        signal,
        token: randomUUID().replaceAll('-', ''),
        run,
        program: async (name, lines, verbosity = -1) => {
          checkAbort(signal);
          const filename = `${name}.gmic`;
          await writeFile(path.join(jobDir, filename), commandFile(name, lines), {
            encoding: 'utf8',
            flag: 'wx',
          });
          return run(['-verbose', String(verbosity), '-command', filename, `-${name}`, '-quit']);
        },
      };
      return await callback(job);
    } finally {
      clearTimeout(timer);
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
          console.error(
            `gmic-mcp: could not clean its job directory ${directory}: ${String(error)}`,
          );
        }
      }
    }
  }

  async info(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withJob(
      async (job) => {
        const identity = await this.identity(job);
        return {
          executable: identity.executable,
          version: identity.version,
          buildFlags: identity.flags,
          pixelType: identity.pixelType,
          transport: 'stdio',
          configuration: {
            stateDir: this.config.stateDir,
            relativePathBase: this.config.baseDir,
            timeoutMs: this.config.timeoutMs,
            maxConcurrency: this.config.maxConcurrency,
            maxInputBytes: this.config.maxInputBytes,
            maxLogBytesPerStream: this.config.maxLogBytes,
            maxOutputFiles: this.config.maxOutputFiles,
            passEnv: this.config.passEnv,
            guiCatalog:
              this.config.guiCatalog === 'auto' || this.config.guiCatalog === 'off'
                ? this.config.guiCatalog
                : 'local-file',
            rawToolEnabled: this.config.enableRaw,
          },
          execution: this.runner.status,
          trustModel: "Trusted local G'MIC code; not a filesystem, process, or network sandbox.",
        };
      },
      undefined,
      signal,
    );
  }

  private async identity(job: Job): Promise<NativeIdentity> {
    if (this.identityCache?.executable === job.executable) return this.identityCache;
    const marker = `__MCP_${job.token}`;
    const result = await job.run([
      '-verbose',
      '-1',
      '+echo',
      `${marker}_VERSION:$_version`,
      '+echo',
      `${marker}_FLAGS:$_flags`,
      '+echo',
      `${marker}_PIXEL:$_pixeltype`,
      '-quit',
    ]);
    const value = (suffix: string) =>
      result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith(`${marker}_${suffix}:`))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim() ?? null;
    const numericVersion = value('VERSION');
    if (!numericVersion || !/^\d{3,}$/.test(numericVersion)) {
      throw new GmicError('CATALOGUE_UNAVAILABLE', "G'MIC did not report a numeric version.");
    }
    this.identityCache = {
      executable: job.executable,
      numericVersion,
      version: `${numericVersion.slice(0, -2)}.${numericVersion.at(-2)}.${numericVersion.at(-1)}`,
      flags: value('FLAGS'),
      pixelType: value('PIXEL'),
    };
    return this.identityCache;
  }

  private async registry(signal?: AbortSignal, includeGui = true): Promise<OperationRegistry> {
    if (includeGui && this.registryCache) return this.registryCache;
    if (!includeGui && this.cliRegistryCache) return this.cliRegistryCache;
    if (!includeGui && this.registryCache) return this.registryCache;
    const registry = await this.withJob(
      async (job) => {
        const identity = await this.identity(job);
        const warnings: string[] = [];
        let commands = this.commandDocsCache;
        if (!commands) {
          // The CLI supplies its embedded stdlib as image [0] for `-help` on a
          // fresh state directory. Export it through an isolated help override.
          const userFile = process.platform === 'win32' ? 'user.gmic' : '.gmic';
          await writeFile(
            path.join(job.directory, 'gmic', userFile),
            'help : output_text[0] stdlib.gmic quit\n',
            'utf8',
          );
          await job.run(['-help']);
          const source = path.join(job.directory, 'stdlib.gmic');
          try {
            if ((await stat(source)).size > 16_777_216)
              throw new GmicError(
                'CATALOGUE_UNAVAILABLE',
                'Embedded documentation exceeds 16 MiB.',
              );
            commands = parseCatalogue(await readFile(source, 'utf8'));
            if (!commands.length)
              throw new GmicError(
                'CATALOGUE_UNAVAILABLE',
                'The embedded standard library contains no #@cli documentation.',
              );
            this.commandDocsCache = commands;
          } catch (error) {
            if (error instanceof GmicError) throw error;
            throw new GmicError(
              'CATALOGUE_UNAVAILABLE',
              "Could not export the installed CLI's embedded documentation. This CLI version may not support the help mechanism.",
            );
          }
        }
        const gui = includeGui
          ? await this.loadGuiCatalogue(identity.numericVersion, job, warnings)
          : { filters: [] as Operation[], sourceVersion: undefined };
        return buildRegistry(commands, gui.filters, warnings, gui.sourceVersion);
      },
      undefined,
      signal,
    );
    if (includeGui) this.registryCache = registry;
    else this.cliRegistryCache = registry;
    return registry;
  }

  private async loadGuiCatalogue(
    numericVersion: string,
    job: Job,
    warnings: string[],
  ): Promise<{ filters: Operation[]; sourceVersion?: string }> {
    if (this.config.guiCatalog === 'off') {
      warnings.push('GUI filter catalogue is disabled; discovery contains CLI commands only.');
      return { filters: [] };
    }
    if (this.config.guiCatalog !== 'auto') return this.readGuiCatalogue(this.config.guiCatalog);

    const directory = path.join(this.config.stateDir, 'catalog');
    const cacheFile = path.join(directory, `gui-source-${numericVersion}.json`);
    try {
      const cached = await this.readGuiCatalogue(cacheFile);
      if (cached.sourceVersion && cached.sourceVersion !== this.identityCache?.version) {
        warnings.push(
          `Cached GUI metadata reports G'MIC ${cached.sourceVersion}; execution is checked against installed ${this.identityCache?.version}.`,
        );
      }
      return cached;
    } catch {
      // Missing and invalid wrapper-owned caches are replaced below.
      await rm(cacheFile, { force: true });
    }

    try {
      const filename = 'official-gui-catalog.json';
      await job.run([
        '-verbose',
        '-1',
        '-input_text',
        `https://gmic.eu/update${numericVersion}`,
        '-output_text',
        filename,
        '-quit',
      ]);
      const loaded = await this.readGuiCatalogue(path.join(job.directory, filename));
      if (loaded.sourceVersion && loaded.sourceVersion !== this.identityCache?.version) {
        warnings.push(
          `Official GUI metadata reports G'MIC ${loaded.sourceVersion}; execution is checked against installed ${this.identityCache?.version}.`,
        );
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await copyFile(path.join(job.directory, filename), temporary);
        await rename(temporary, cacheFile);
      } finally {
        await rm(temporary, { force: true });
      }
      return loaded;
    } catch (error) {
      warnings.push(
        `GUI filter metadata is unavailable (${error instanceof Error ? error.message : String(error)}). CLI discovery remains available.`,
      );
      return { filters: [] };
    }
  }

  private async readGuiCatalogue(
    filename: string,
  ): Promise<{ filters: Operation[]; sourceVersion?: string }> {
    const info = await stat(filename).catch(() => undefined);
    if (!info?.isFile()) {
      throw new GmicError('CATALOGUE_INVALID', `GUI catalogue is not a file: ${filename}`);
    }
    if (info.size > 32 * 1024 * 1024) {
      throw new GmicError('CATALOGUE_INVALID', 'GUI catalogue exceeds 32 MiB.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filename, 'utf8'));
    } catch (error) {
      throw new GmicError(
        'CATALOGUE_INVALID',
        `Could not parse GUI catalogue JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseGuiOperations(parsed);
  }

  async discover(args: DiscoverArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const registry = await this.registry(signal, args.kind !== 'command');
    const matches = discoverOperations(registry, args);
    const available: Operation[] = [];
    let cursor = 0;
    const needed = args.offset + args.limit;
    // Official metadata can be slightly newer than the executable. Probe only
    // enough ranked candidates to build this page, in small native batches.
    while (cursor < matches.length && available.length < needed && cursor < 100) {
      const batch = matches.slice(cursor, cursor + 8);
      const filterCommands = batch
        .filter((operation) => operation.kind === 'filter')
        .map((operation) => operation.command);
      if (filterCommands.length) await this.filterExistsBatch(filterCommands, signal);
      for (const operation of batch) {
        if (
          operation.kind === 'command' ||
          this.filterAvailability.get(operation.command) === true
        ) {
          available.push(operation);
        }
      }
      cursor += batch.length;
    }
    const page = available.slice(args.offset, args.offset + args.limit);
    return {
      query: args.query,
      candidate_count: matches.length,
      offset: args.offset,
      has_more: cursor < matches.length || available.length > args.offset + args.limit,
      next_offset:
        cursor < matches.length || available.length > args.offset + args.limit
          ? args.offset + args.limit
          : null,
      results: page.map((operation) => ({
        operation_id: operation.operationId,
        kind: operation.kind,
        title: operation.title,
        command: operation.command,
        category: operation.category,
        summary: operation.summary.slice(0, 240),
        interactive: operation.interactive,
        executable_with: operation.structured ? 'gmic_execute' : 'gmic_run_trusted_code',
        ...(operation.kind === 'filter'
          ? {
              parameter_count:
                operation.parameters?.filter((parameter) => parameter.exposed).length ?? 0,
              has_defaults: operation.structured,
            }
          : { argument_syntax: operation.argumentSyntax ?? '' }),
      })),
      next_action: page.length
        ? 'Call gmic_describe with an exact operation_id before overriding parameters; gmic_execute may use filter defaults directly.'
        : 'Broaden the query or include interactive operations. Never invent an operation_id.',
      catalogue: {
        cli_commands: registry.cliCount,
        gui_filters: registry.filterCount,
        provenance:
          "Installed CLI documentation plus official G'MIC GUI metadata; titles and descriptions are untrusted reference data.",
        ...(registry.guiSourceVersion ? { gui_source_version: registry.guiSourceVersion } : {}),
        warnings: registry.warnings,
      },
    };
  }

  async describe(
    operationId: string,
    signal?: AbortSignal,
    options: {
      parameterKey?: string | undefined;
      choiceQuery?: string | undefined;
      choiceOffset?: number | undefined;
      choiceLimit?: number | undefined;
    } = {},
  ): Promise<Record<string, unknown>> {
    const registry = await this.registry(signal, operationId.startsWith('filter:'));
    const operation = registry.byId.get(operationId);
    if (!operation) {
      throw new GmicError('UNKNOWN_OPERATION', `No installed operation has ID '${operationId}'.`, {
        suggestions: operationSuggestions(registry, operationId),
        next_action: 'Call gmic_discover and use an exact returned operation_id.',
      });
    }
    if (operation.kind === 'filter' && !(await this.filterExists(operation.command, signal))) {
      throw new GmicError(
        'OPERATION_UNAVAILABLE',
        `${operation.operationId} is listed by the official catalogue but is not defined by the installed CLI.`,
        {
          suggestions: operationSuggestions(registry, operation.title, 8)
            .filter((candidate) => candidate !== operation.operationId)
            .slice(0, 5),
          next_action:
            "Choose another result from gmic_discover or update G'MIC explicitly outside this server.",
        },
      );
    }
    return { ...describeOperation(operation, options), catalogueWarnings: registry.warnings };
  }

  async search(
    query: string,
    category: string | undefined,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const registry = await this.registry(signal, false);
    const matches = query
      ? discoverOperations(registry, {
          query,
          kind: 'command',
          interactive: 'include',
          offset,
          limit,
          ...(category ? { category } : {}),
        })
      : registry.operations.filter(
          (operation) =>
            operation.kind === 'command' &&
            (!category || operation.category.toLowerCase().includes(category.toLowerCase())),
        );
    return {
      query,
      total: matches.length,
      offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      commands: matches.slice(offset, offset + limit).map((operation) => ({
        name: operation.command,
        category: operation.category,
        arguments: operation.argumentSyntax ?? '',
        description: operation.summary,
      })),
      source: 'Unified operation registry.',
    };
  }

  async help(command: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const registry = await this.registry(signal);
    const found = registry.byId.get(`cli:${command}`) ?? registry.byId.get(`filter:${command}`);
    if (found) {
      const described = describeOperation(found);
      return {
        command,
        available: true,
        documentation:
          found.kind === 'command'
            ? `${found.argumentSyntax ?? ''}\n\n${found.documentation ?? found.summary}`
            : JSON.stringify(described, null, 2),
        source:
          found.kind === 'command' ? 'Embedded #@cli documentation' : 'Official #@gui metadata',
        format: found.kind === 'command' ? "G'MIC markdown" : 'application/json',
      };
    }
    return {
      command,
      available: false,
      documentation: null,
      suggestions: operationSuggestions(registry, command, 10),
      note: 'Call gmic_discover; never invent a command or filter name.',
    };
  }

  async executeOperations(
    args: ExecuteArgs,
    signal?: AbortSignal,
  ): Promise<ExecutionResult & { applied_operations: unknown[] }> {
    const registry = await this.registry(
      signal,
      args.operations.some((operation) => operation.operation_id.startsWith('filter:')),
    );
    const compiled: ReturnType<typeof compileOperation>[] = [];
    const appliedOperations: unknown[] = [];
    for (const step of args.operations) {
      const operation = registry.byId.get(step.operation_id);
      if (!operation) {
        throw new GmicError(
          'UNKNOWN_OPERATION',
          `No installed operation has ID '${step.operation_id}'.`,
          {
            suggestions: operationSuggestions(registry, step.operation_id),
            next_action: 'Call gmic_discover and use an exact returned operation_id.',
          },
        );
      }
      if (operation.kind === 'filter' && !(await this.filterExists(operation.command, signal))) {
        throw new GmicError(
          'OPERATION_UNAVAILABLE',
          `${operation.operationId} is described by the official catalogue but is not defined by the installed CLI.`,
          {
            suggestions: operationSuggestions(registry, operation.title, 8)
              .filter((candidate) => candidate !== operation.operationId)
              .slice(0, 5),
            next_action:
              "Choose another result from gmic_discover or update G'MIC explicitly outside this server.",
          },
        );
      }
      const item = compileOperation(operation, step);
      compiled.push(item);
      appliedOperations.push({
        operation_id: operation.operationId,
        command: operation.command,
        ...(item.resolvedParameters ? { parameters: item.resolvedParameters } : {}),
        ...(item.arguments !== undefined && operation.kind === 'command'
          ? { arguments: item.arguments }
          : {}),
      });
    }
    const executionArgs: ExecutionArgs = {
      inputs: args.inputs,
      outputs: args.outputs,
      command_files: [],
      overwrite: args.overwrite,
      preview: args.preview,
      preview_mode: args.preview_mode,
      preview_max_dimension: args.preview_max_dimension,
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
    };
    const result = await this.execute(
      executionArgs,
      () =>
        Promise.resolve([
          '_preview_enabled=0',
          '_randomized=0',
          '_output_mode=0',
          ...compiled.map((step) =>
            compileStep({
              command: step.command,
              copy: step.copy,
              ...(step.arguments !== undefined ? { arguments: step.arguments } : {}),
              ...(step.selection !== undefined ? { selection: step.selection } : {}),
            }),
          ),
        ]),
      signal,
    );
    return { ...result, applied_operations: appliedOperations };
  }

  private async filterExists(command: string, signal?: AbortSignal): Promise<boolean> {
    const cached = this.filterAvailability.get(command);
    if (cached !== undefined) return cached;
    await this.filterExistsBatch([command], signal);
    return this.filterAvailability.get(command) ?? false;
  }

  private async filterExistsBatch(
    commands: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, boolean>> {
    const unresolved = [...new Set(commands)].filter(
      (command) => this.filterAvailability.get(command) === undefined,
    );
    if (!unresolved.length) return this.filterAvailability;
    const uncertain: string[] = [];
    await this.withJob(
      async (job) => {
        const args = ['-verbose', '-1'];
        unresolved.forEach((item, index) => {
          args.push(
            '+echo',
            `__MCP_COMMAND_${job.token}_${index}:$$${item}:__MCP_COMMAND_END_${job.token}_${index}`,
          );
        });
        args.push('-quit');
        const result = await job.run(args);
        for (const [index, item] of unresolved.entries()) {
          const start = `__MCP_COMMAND_${job.token}_${index}:`;
          const end = `:__MCP_COMMAND_END_${job.token}_${index}`;
          const line = result.stdout
            .split(/\r?\n/)
            .find((candidate) => candidate.startsWith(start) && candidate.endsWith(end));
          if (!line && result.logsTruncated) uncertain.push(item);
          else
            this.filterAvailability.set(
              item,
              Boolean(line && line.length > start.length + end.length),
            );
        }
      },
      undefined,
      signal,
    );
    for (const item of uncertain) {
      const exists = await this.withJob(
        async (job) => {
          const marker = `__MCP_COMMAND_${job.token}:`;
          const result = await job.run(['-verbose', '-1', '+echo', `${marker}$$${item}`, '-quit']);
          const line = result.stdout
            .split(/\r?\n/)
            .find((candidate) => candidate.startsWith(marker));
          return (
            result.stdoutBytes > Buffer.byteLength(marker) + 2 ||
            Boolean(line && line.length > marker.length)
          );
        },
        undefined,
        signal,
      );
      this.filterAvailability.set(item, exists);
    }
    return this.filterAvailability;
  }

  async imageInfo(
    input: Input,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withJob(
      async (job) => {
        const [staged] = await stageInputs([input], job.directory, this.config, job.signal);
        const marker = `__MCP_IMAGE_${job.token}`;
        const bitMarker = `__MCP_BITS_${job.token}`;
        const result = await job.program(`mcp_info_${job.token}`, [
          ...inputLines([staged!]),
          `+echo ${bitMarker}:` + '${}',
          ...metadataLines(marker),
        ]);
        const images = parseMetadata(result.stdout, marker);
        if (!images.length)
          throw new GmicError('NO_IMAGES', 'The input did not produce any image data.');
        return {
          path: staged!.source,
          bytes: (await stat(path.join(job.directory, staged!.alias))).size,
          sourceBitDepth: parseBitDepth(result.stdout, bitMarker),
          images,
          diagnostics: result,
        };
      },
      timeoutMs,
      signal,
    );
  }

  runPipeline(args: PipelineArgs, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.execute(args, () => Promise.resolve(args.steps.map(compileStep)), signal);
  }

  runScript(args: ScriptArgs, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.execute(
      args,
      async (job) => {
        let alias: string;
        if (args.path !== undefined) {
          [alias] = (await stageCommands([args.path], job.directory, this.config, job.signal)) as [
            string,
          ];
          // Reserve a distinct name from the command_files imports.
          const unique = 'entry_script.gmic';
          await rename(path.join(job.directory, alias), path.join(job.directory, unique));
          alias = unique;
        } else {
          alias = 'entry_script.gmic';
          await writeFile(path.join(job.directory, alias), args.script!, {
            encoding: 'utf8',
            flag: 'wx',
          });
        }
        return [
          `-command ${alias}`,
          `-${args.entrypoint}${args.arguments ? ` ${args.arguments}` : ' ,'}`,
        ];
      },
      signal,
    );
  }

  private execute(
    args: ExecutionArgs,
    makeSteps: (job: Job) => Promise<string[]>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    return this.withJob(
      async (job) => {
        const started = performance.now();
        const outputs = await prepareOutputs(args.outputs, this.config, args.overwrite);
        const inputs = await stageInputs(args.inputs, job.directory, this.config, job.signal);
        // Prepare the entrypoint before importing command_files to avoid alias collisions.
        const steps = await makeSteps(job);
        const commands = await stageCommands(
          args.command_files,
          job.directory,
          this.config,
          job.signal,
        );
        const marker = `__MCP_STACK_${job.token}`;
        const result = await job.program(
          `mcp_run_${job.token}`,
          [
            ...inputLines(inputs),
            ...commands.map((alias) => `-command ${alias}`),
            ...steps,
            ...metadataLines(marker),
            ...outputLines(outputs),
          ],
          1,
        );
        const stack = parseMetadata(result.stdout, marker);
        const files = await collectOutputs(outputs, job.directory, this.config);
        const warnings: string[] = [];
        const artifacts = await this.inspectExports(files, job, warnings);
        for (const artifact of artifacts) {
          const integerMaximum =
            artifact.sourceBitDepth === 8
              ? 255
              : artifact.sourceBitDepth === 16
                ? 65535
                : ['image/jpeg', 'image/webp', 'image/bmp', 'image/gif'].includes(artifact.mimeType)
                  ? 255
                  : undefined;
          if (
            integerMaximum !== undefined &&
            stack.some(
              (image) =>
                (image.min !== null && image.min < 0) ||
                (image.max !== null && image.max > integerMaximum),
            )
          ) {
            warnings.push(
              `The in-memory stack contains values outside the integer range for ${artifact.path}; selected exports may lose values. Use GMZ or explicitly adapt the data.`,
            );
          }
          if (artifact.mimeType === 'image/jpeg' && stack.some((image) => image.channels === 4)) {
            warnings.push(
              `The stack contains four-channel data, but JPEG cannot preserve alpha: ${artifact.path}.`,
            );
          }
        }
        const preview = args.preview
          ? await this.makePreview(files, artifacts, args, job, warnings)
          : undefined;
        await publishOutputs(files, args.overwrite, job.signal);
        return {
          outputs: artifacts,
          stack,
          inputPaths: inputs.map((input) => input.source),
          durationMs: Math.round(performance.now() - started),
          diagnostics: result,
          warnings,
          ...(preview ? { preview } : {}),
        };
      },
      args.timeout_ms,
      signal,
    );
  }

  private async inspectExports(
    files: ProducedFile[],
    job: Job,
    warnings: string[],
  ): Promise<OutputArtifact[]> {
    if (!files.length) return [];
    const lines: string[] = [];
    for (const [index, file] of files.entries()) {
      lines.push(
        '-local[] {',
        `-input ${file.alias}`,
        `+echo __MCP_BITS_${job.token}_${index}:` + '${}',
        ...metadataLines(`__MCP_EXPORT_${job.token}_${index}`),
        '-onfail',
        '}',
      );
    }
    const result = await job.program(`mcp_inspect_${job.token}`, lines);
    return files.map((file, index) => {
      const images = parseMetadata(result.stdout, `__MCP_EXPORT_${job.token}_${index}`);
      if (!images.length)
        warnings.push(
          `Could not read back image metadata for ${file.destination}; the file was still produced.`,
        );
      return {
        path: file.destination,
        mimeType: mimeType(file.alias),
        bytes: file.bytes,
        images,
        sourceBitDepth: parseBitDepth(result.stdout, `__MCP_BITS_${job.token}_${index}`),
      };
    });
  }

  private async makePreview(
    files: ProducedFile[],
    artifacts: OutputArtifact[],
    args: ExecutionArgs,
    job: Job,
    warnings: string[],
  ): Promise<ExecutionResult['preview']> {
    const index = artifacts.findIndex((artifact) => {
      const image = artifact.images[0];
      return (
        image &&
        image.depth === 1 &&
        image.channels >= 1 &&
        image.channels <= 4 &&
        image.width > 1 &&
        image.height > 1
      );
    });
    if (index < 0) {
      warnings.push('No eligible 2D grayscale/RGB/RGBA output for a preview.');
      return undefined;
    }
    const artifact = artifacts[index]!;
    const image = artifact.images[0]!;
    const scale = Math.min(1, args.preview_max_dimension / Math.max(image.width, image.height));
    const lines = [
      `-input ${files[index]!.alias}`,
      '-keep[0]',
      `-resize ${Math.max(1, Math.round(image.width * scale))},${Math.max(1, Math.round(image.height * scale))},1,100%,3`,
    ];
    if (args.preview_mode === 'normalize') lines.push('-normalize 0,255');
    else {
      if (artifact.sourceBitDepth === 16) lines.push('-div 257');
      lines.push('-cut 0,255');
    }
    lines.push('-output preview.png,8');
    await job.program(`mcp_preview_${job.token}`, lines);
    if ((await stat(path.join(job.directory, 'preview.png'))).size > this.config.maxPreviewBytes) {
      warnings.push(
        'Preview omitted because it exceeds GMIC_MCP_MAX_PREVIEW_BYTES; reduce preview_max_dimension.',
      );
      return undefined;
    }
    return {
      data: (await readFile(path.join(job.directory, 'preview.png'))).toString('base64'),
      mimeType: 'image/png',
      sourcePath: artifact.path,
    };
  }
}
