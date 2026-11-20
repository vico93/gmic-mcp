import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { GmicError } from '../src/errors.js';

export async function temporaryDirectory(): Promise<string> {
  const parent = process.env.GMIC_MCP_TEST_TMPDIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, 'gmic-mcp-test-'));
}

export function testConfig(directory: string, overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig(
    {
      ...process.env,
      GMIC_MCP_STATE_DIR: path.join(directory, 'state'),
      GMIC_MCP_GUI_CATALOG: 'off',
      ...overrides,
    },
    directory,
  );
}

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GmicError && error.code === code;
}
