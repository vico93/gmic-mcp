import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { GmicError } from './errors.js';

export interface Config {
  bin: string | undefined;
  baseDir: string;
  stateDir: string;
  timeoutMs: number;
  maxConcurrency: number;
  maxLogBytes: number;
  maxInputBytes: number;
  maxOutputFiles: number;
  maxPreviewBytes: number;
  passEnv: string[];
  guiCatalog: 'auto' | 'off' | string;
  enableRaw: boolean;
  environment: NodeJS.ProcessEnv;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new GmicError('CONFIGURATION_ERROR', `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new GmicError('CONFIGURATION_ERROR', `${name} must be true/false or 1/0.`);
}

function stateRoot(env: NodeJS.ProcessEnv): string {
  if (platform() === 'win32') return env.LOCALAPPDATA || tmpdir();
  if (platform() === 'darwin') return path.join(homedir(), 'Library', 'Caches');
  return env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  // Plain-object environment overlays can contain both Path and PATH even though
  // Windows treats them as one variable. Honor the last supplied value once.
  const snapshot: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    snapshot[process.platform === 'win32' ? name.toUpperCase() : name] = value;
  }
  env = snapshot;
  const baseDir = path.resolve(cwd);
  const bin = env.GMIC_MCP_BIN?.trim();
  if (env.GMIC_MCP_BIN !== undefined && (!bin || /[\0\r\n]/.test(bin) || /^['"]/.test(bin))) {
    throw new GmicError(
      'CONFIGURATION_ERROR',
      'GMIC_MCP_BIN must be an unquoted executable path or installation directory.',
    );
  }
  if (env.GMIC_MCP_STATE_DIR !== undefined && !env.GMIC_MCP_STATE_DIR.trim()) {
    throw new GmicError('CONFIGURATION_ERROR', 'GMIC_MCP_STATE_DIR cannot be empty.');
  }
  if (env.GMIC_MCP_STATE_DIR && /[\0\r\n]/.test(env.GMIC_MCP_STATE_DIR)) {
    throw new GmicError(
      'CONFIGURATION_ERROR',
      'GMIC_MCP_STATE_DIR cannot contain NUL or newline characters.',
    );
  }
  const passEnv = (env.GMIC_MCP_PASS_ENV ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (passEnv.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new GmicError(
      'CONFIGURATION_ERROR',
      'GMIC_MCP_PASS_ENV must list environment variable names.',
    );
  }
  const guiCatalog = env.GMIC_MCP_GUI_CATALOG?.trim() || 'auto';
  if (/[\0\r\n]/.test(guiCatalog)) {
    throw new GmicError(
      'CONFIGURATION_ERROR',
      'GMIC_MCP_GUI_CATALOG cannot contain NUL or newlines.',
    );
  }
  return {
    bin,
    baseDir,
    stateDir: path.resolve(
      baseDir,
      env.GMIC_MCP_STATE_DIR ?? path.join(stateRoot(env), 'gmic-mcp'),
    ),
    timeoutMs: integer(env, 'GMIC_MCP_TIMEOUT_MS', 120_000, 100, 3_600_000),
    maxConcurrency: integer(env, 'GMIC_MCP_MAX_CONCURRENCY', 1, 1, 16),
    maxLogBytes: integer(env, 'GMIC_MCP_MAX_LOG_BYTES', 1_048_576, 4096, 16_777_216),
    maxInputBytes: integer(env, 'GMIC_MCP_MAX_INPUT_BYTES', 268_435_456, 1, 4_294_967_296),
    maxOutputFiles: integer(env, 'GMIC_MCP_MAX_OUTPUT_FILES', 128, 1, 1024),
    maxPreviewBytes: integer(env, 'GMIC_MCP_MAX_PREVIEW_BYTES', 2_097_152, 1024, 8_388_608),
    passEnv: [...new Set(passEnv)],
    guiCatalog: /^(auto|off)$/i.test(guiCatalog)
      ? (guiCatalog.toLowerCase() as 'auto' | 'off')
      : path.resolve(baseDir, guiCatalog),
    enableRaw: boolean(env, 'GMIC_MCP_ENABLE_RAW', false),
    environment: snapshot,
  };
}

/** Child processes never inherit the entire harness environment. */
export function childEnvironment(
  config: Config,
  executable: string,
  jobDir: string,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CURL_CA_BUNDLE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'LD_LIBRARY_PATH',
    'DYLD_LIBRARY_PATH',
    'OMP_NUM_THREADS',
    ...config.passEnv.map((name) => name.toUpperCase()),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(config.environment)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  }
  // Avoid duplicate case variants of PATH on Windows.
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [path.dirname(executable), env[pathKey] ?? '']
    .filter(Boolean)
    .join(path.delimiter);
  for (const name of Object.keys(env)) {
    if (['GMIC_PATH', 'GMIC_VERBOSITY', 'TMP', 'TEMP', 'TMPDIR'].includes(name.toUpperCase())) {
      delete env[name];
    }
  }
  env.GMIC_PATH = path.join(jobDir, 'gmic');
  env.GMIC_VERBOSITY = '1';
  env.TMP = env.TEMP = env.TMPDIR = jobDir;
  return env;
}
