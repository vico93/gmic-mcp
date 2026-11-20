import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { GmicError } from '../errors.js';

async function executableFile(file: string): Promise<string | undefined> {
  try {
    if (!(await stat(file)).isFile()) return undefined;
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return await realpath(file);
  } catch {
    return undefined;
  }
}

export async function resolveExecutable(config: Config): Promise<string> {
  const filename = process.platform === 'win32' ? 'gmic.exe' : 'gmic';
  if (config.bin !== undefined) {
    const requested = path.resolve(config.baseDir, config.bin);
    let candidate = requested;
    try {
      if ((await stat(requested)).isDirectory()) candidate = path.join(requested, filename);
    } catch {
      // The error below names the configured path, rather than falling back to PATH.
    }
    const found = await executableFile(candidate);
    if (found) return found;
    throw new GmicError(
      'GMIC_NOT_FOUND',
      `No executable G'MIC CLI at ${candidate}. Set GMIC_MCP_BIN to gmic or its installation directory.`,
      { configuredPath: config.bin },
    );
  }
  const pathValue = Object.entries(config.environment).find(
    ([key]) => key.toUpperCase() === 'PATH',
  )?.[1];
  for (const directory of (pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    const found = await executableFile(
      path.resolve(config.baseDir, directory.replace(/^"|"$/g, ''), filename),
    );
    if (found) return found;
  }
  throw new GmicError(
    'GMIC_NOT_FOUND',
    `G'MIC was not found on the server's PATH. Set GMIC_MCP_BIN to its executable or installation directory.`,
  );
}
