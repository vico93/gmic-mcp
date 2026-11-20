#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { describeError } from './errors.js';
import { GmicService } from './gmic/service.js';
import { createServer } from './server.js';

let service: GmicService | undefined;
let handle: StdioServerHandle | undefined;
let closing = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  process.exitCode = exitCode;
  await Promise.allSettled([service?.close(), handle?.close()]);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(
    "gmic-mcp: local stdio MCP server for G'MIC. Configure GMIC_MCP_BIN (executable/directory) or PATH. See README.md for tools and limits.",
  );
} else if (process.argv.includes('--version')) {
  console.error('gmic-mcp 0.2.0');
} else {
  try {
    service = new GmicService(loadConfig());
    handle = serveStdio(() => createServer(service!), {
      onerror: (error) => console.error(`gmic-mcp: ${error.message}`),
    });
    process.stdin.once('end', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown(130);
    });
    process.once('SIGTERM', () => {
      void shutdown(143);
    });
  } catch (error) {
    console.error(`gmic-mcp: ${JSON.stringify(describeError(error))}`);
    void shutdown(1);
  }
}
