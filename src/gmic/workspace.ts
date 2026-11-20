import { constants } from 'node:fs';
import { copyFile, lstat, realpath, stat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { GmicError, checkAbort, errorCode } from '../errors.js';
import type { Input, Output } from '../schemas.js';

export interface StagedInput {
  source: string;
  alias: string;
  options: string | undefined;
}
export interface StagedOutput {
  requested: Output;
  destination: string;
  alias: string;
  stem: string;
  extension: string;
}
export interface ProducedFile {
  staged: string;
  alias: string;
  destination: string;
  bytes: number;
}

export function localPath(value: string, baseDir: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /[\0\r\n]/.test(value)) {
    throw new GmicError(
      'INVALID_PATH',
      "Expected a local filesystem path, not a URL or G'MIC expression.",
    );
  }
  const resolved = path.resolve(baseDir, value);
  if (process.platform === 'win32' && path.basename(resolved).includes(':')) {
    throw new GmicError(
      'INVALID_PATH',
      'NTFS alternate data streams are not supported as managed paths.',
    );
  }
  return resolved;
}

export async function existingFile(value: string, config: Config): Promise<string> {
  const file = localPath(value, config.baseDir);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new GmicError('INVALID_PATH', `Input file does not exist or cannot be accessed: ${file}`);
  }
  if (!info.isFile()) throw new GmicError('INVALID_PATH', `Not a regular input file: ${file}`);
  return realpath(file);
}

function extension(value: string, forced?: string): string {
  const ext = forced ?? path.extname(value).slice(1);
  if (ext && !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(ext)) {
    throw new GmicError(
      'INVALID_PATH',
      'Use an ordinary file extension or specify format explicitly.',
    );
  }
  return ext.toLowerCase();
}

export async function stageInputs(
  inputs: Input[],
  directory: string,
  config: Config,
  signal: AbortSignal,
): Promise<StagedInput[]> {
  const staged: StagedInput[] = [];
  let bytes = 0;
  for (const [index, input] of inputs.entries()) {
    checkAbort(signal);
    const requested = typeof input === 'string' ? { path: input } : input;
    const source = await existingFile(requested.path, config);
    const ext = extension(source, requested.format);
    if (ext === 'gmic' || /\.gmic(?:\.gz)?$/i.test(source)) {
      throw new GmicError(
        'INVALID_PATH',
        'Import .gmic files with command_files or gmic_run_script, not as image inputs.',
      );
    }
    if (bytes + (await stat(source)).size > config.maxInputBytes)
      throw new GmicError('INPUT_TOO_LARGE', `Inputs exceed ${config.maxInputBytes} bytes.`);
    const alias = `input_${index}${ext ? `.${ext}` : ''}`;
    await copyFile(source, path.join(directory, alias), constants.COPYFILE_EXCL);
    // Check the copy too, in case an input changed between stat and copyFile.
    const copied = (await stat(path.join(directory, alias))).size;
    bytes += copied;
    if (bytes > config.maxInputBytes)
      throw new GmicError('INPUT_TOO_LARGE', 'Inputs grew beyond the configured aggregate limit.');
    staged.push({ source, alias, options: requested.options });
  }
  return staged;
}

export async function stageCommands(
  files: string[],
  directory: string,
  config: Config,
  signal: AbortSignal,
): Promise<string[]> {
  const aliases: string[] = [];
  let bytes = 0;
  for (const [index, file] of files.entries()) {
    checkAbort(signal);
    const source = await existingFile(file, config);
    const limit = Math.min(config.maxInputBytes, 16_777_216);
    if (bytes + (await stat(source)).size > limit)
      throw new GmicError('INPUT_TOO_LARGE', 'Command files are too large.');
    const alias = `commands_${index}.gmic`;
    await copyFile(source, path.join(directory, alias), constants.COPYFILE_EXCL);
    bytes += (await stat(path.join(directory, alias))).size;
    if (bytes > limit)
      throw new GmicError('INPUT_TOO_LARGE', 'Command files grew beyond the configured limit.');
    aliases.push(alias);
  }
  return aliases;
}

async function validateDestination(file: string, overwrite: boolean): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile())
      throw new GmicError('INVALID_PATH', `Output is not a regular file: ${file}`);
    if (!overwrite)
      throw new GmicError(
        'OUTPUT_EXISTS',
        `Output already exists: ${file}. Set overwrite=true explicitly to replace it.`,
      );
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export async function prepareOutputs(
  outputs: Output[],
  config: Config,
  overwrite: boolean,
): Promise<StagedOutput[]> {
  const prepared: StagedOutput[] = [];
  for (const [index, output] of outputs.entries()) {
    const requested = localPath(output.path, config.baseDir);
    let parent: string;
    try {
      parent = await realpath(path.dirname(requested));
      if (!(await stat(parent)).isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new GmicError(
        'INVALID_PATH',
        `Output parent directory must already exist: ${path.dirname(requested)}`,
      );
    }
    const destination = path.join(parent, path.basename(requested));
    await validateDestination(destination, overwrite);
    const ext = extension(destination, output.format);
    if (!ext)
      throw new GmicError(
        'INVALID_PATH',
        'Output requires a file extension or an explicit format.',
      );
    const stem = `output_${index}`;
    prepared.push({
      requested: output,
      destination,
      alias: `${stem}.${ext}`,
      stem,
      extension: ext,
    });
  }
  assertDistinct(prepared.map((output) => output.destination));
  return prepared;
}

export function assertDistinct(files: string[]): void {
  const normalized = files.map((file) =>
    process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file,
  );
  if (new Set(normalized).size !== normalized.length)
    throw new GmicError('INVALID_PATH', 'Output destinations overlap.');
}

export async function collectOutputs(
  outputs: StagedOutput[],
  directory: string,
  config: Config,
): Promise<ProducedFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: ProducedFile[] = [];
  for (const output of outputs) {
    const matches = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          new RegExp(`^${output.stem}(?:_\\d+)?\\.${output.extension}$`).test(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (!matches.length)
      throw new GmicError(
        'OUTPUT_MISSING',
        `G'MIC produced no files for ${output.destination}. Check the output selection and script entrypoint.`,
      );
    for (const entry of matches) {
      const suffix = entry.name.slice(output.stem.length, -(output.extension.length + 1));
      const ext = path.extname(output.destination);
      const destination = suffix
        ? path.join(
            path.dirname(output.destination),
            `${path.basename(output.destination, ext)}${suffix}${ext}`,
          )
        : output.destination;
      const staged = path.join(directory, entry.name);
      const info = await lstat(staged);
      if (!info.isFile() || info.isSymbolicLink())
        throw new GmicError('INVALID_PATH', 'A staged output is not a regular file.');
      files.push({ staged, alias: entry.name, destination, bytes: info.size });
      if (files.length > config.maxOutputFiles)
        throw new GmicError(
          'OUTPUT_LIMIT',
          `G'MIC produced more than ${config.maxOutputFiles} output files.`,
        );
    }
  }
  assertDistinct(files.map((file) => file.destination));
  return files;
}

export async function publishOutputs(
  files: ProducedFile[],
  overwrite: boolean,
  signal: AbortSignal,
): Promise<string[]> {
  for (const file of files) await validateDestination(file.destination, overwrite);
  const published: string[] = [];
  try {
    for (const file of files) {
      checkAbort(signal);
      if (!overwrite) {
        // Exclusive copy protects against a competing writer after the preflight check.
        await copyFile(file.staged, file.destination, constants.COPYFILE_EXCL);
      } else {
        const temporary = path.join(
          path.dirname(file.destination),
          `.gmic-mcp-${randomUUID()}.tmp`,
        );
        try {
          await copyFile(file.staged, temporary, constants.COPYFILE_EXCL);
          checkAbort(signal);
          await validateDestination(file.destination, true);
          await rename(temporary, file.destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      published.push(file.destination);
    }
  } catch (error) {
    throw new GmicError(
      errorCode(error) === 'EEXIST'
        ? 'OUTPUT_EXISTS'
        : error instanceof GmicError
          ? error.code
          : 'OUTPUT_WRITE_FAILED',
      error instanceof Error ? error.message : String(error),
      { publishedOutputs: published },
    );
  }
  return published;
}

export function mimeType(filename: string): string {
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
  };
  return types[path.extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream';
}
