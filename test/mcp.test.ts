import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { temporaryDirectory } from './helpers.js';

function data(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result.content.find((block) => block.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text) as Record<string, unknown>;
}

for (const era of ['legacy', 'modern'] as const) {
  describe(`MCP stdio (${era})`, () => {
    let directory: string;
    let client: Client;
    let transport: StdioClientTransport;
    let stderr = '';
    before(async () => {
      directory = await temporaryDirectory();
      client = new Client(
        { name: 'gmic-mcp-test', version: '1.0.0' },
        {
          versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
        },
      );
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('dist/index.js')],
        env: {
          ...(process.env as Record<string, string>),
          GMIC_MCP_BIN: path.join(directory, 'missing-gmic'),
          GMIC_MCP_STATE_DIR: path.join(directory, 'state'),
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await client.connect(transport);
    });
    after(async () => {
      await client?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('advertises five focused tools and honest execution annotations', async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'gmic_describe',
        'gmic_discover',
        'gmic_execute',
        'gmic_inspect_image',
        'gmic_status',
      ]);
      const execute = tools.find((tool) => tool.name === 'gmic_execute')!;
      assert.equal(execute.annotations?.readOnlyHint, false);
      assert.equal(execute.annotations?.openWorldHint, true);
    });

    it("serves contextual guides without requiring a G'MIC executable", async () => {
      const { resources } = await client.listResources();
      assert.equal(resources.length, 3);
      const guide = await client.readResource({ uri: 'gmic://guide/pipelines' });
      const item = guide.contents[0]!;
      assert.ok('text' in item);
      assert.match(String(item.text), /cheatsheet\.html/);
      assert.match(String(item.text), /image stack/);
    });

    it("returns a structured tool error for missing G'MIC, without breaking stdio", async () => {
      const result = await client.callTool({ name: 'gmic_status', arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(data(result).ok, false);
      assert.equal((data(result).error as Record<string, unknown>).code, 'GMIC_NOT_FOUND');
      assert.equal((await client.listTools()).tools.length, 5);
      assert.doesNotMatch(stderr, /secret|UnhandledPromiseRejection/);
    });

    it('rejects malformed tool arguments before invoking native code', async () => {
      const result = await client.callTool({
        name: 'gmic_execute',
        arguments: {
          inputs: ['image.png'],
          operations: [{ operation_id: 'cli:blur', arguments: '1', parameters: {} }],
          outputs: [{ path: 'output.png' }],
        },
      });
      assert.equal(result.isError, true);
      assert.equal((await client.listTools()).tools.length, 5);
    });
  });
}

describe('optional raw tool', () => {
  it('is advertised only when explicitly enabled', async () => {
    const directory = await temporaryDirectory();
    const client = new Client({ name: 'gmic-mcp-raw-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/index.js')],
      env: {
        ...(process.env as Record<string, string>),
        GMIC_MCP_BIN: path.join(directory, 'missing-gmic'),
        GMIC_MCP_STATE_DIR: path.join(directory, 'state'),
        GMIC_MCP_ENABLE_RAW: '1',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 6);
      assert.ok(tools.some((tool) => tool.name === 'gmic_run_trusted_code'));
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('MCP native image result', { skip: !process.env.GMIC_MCP_TEST_BIN }, () => {
  it('transmits structured metadata and actual image content through a real client', async () => {
    const directory = await temporaryDirectory();
    const client = new Client(
      { name: 'gmic-mcp-native-test', version: '1.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/index.js')],
      env: {
        ...(process.env as Record<string, string>),
        GMIC_MCP_BIN: process.env.GMIC_MCP_TEST_BIN!,
        GMIC_MCP_STATE_DIR: path.join(directory, 'state'),
        GMIC_MCP_GUI_CATALOG: 'off',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const target = path.join(directory, 'mcp-image.png');
      const result = await client.callTool({
        name: 'gmic_execute',
        arguments: {
          operations: [{ operation_id: 'cli:input', arguments: '16,12,1,3,x+y+c' }],
          outputs: [{ path: target }],
          preview: true,
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(data(result).ok, true);
      const content = result.content.find((block) => block.type === 'image');
      assert.ok(content && content.type === 'image');
      assert.equal(content.mimeType, 'image/png');
      assert.ok((await readFile(target)).length > 0);
      const details = data(result).result as Record<string, unknown>;
      const previews = details.preview as Record<string, unknown>;
      assert.equal(
        previews.data,
        undefined,
        'base64 should not be duplicated in structured metadata',
      );

      const rejected = await client.callTool({
        name: 'gmic_execute',
        arguments: {
          operations: [{ operation_id: 'filter:fx_colorize' }],
          outputs: [{ path: path.join(directory, 'must-not-exist.png') }],
        },
      });
      assert.equal(rejected.isError, true);
      const error = data(rejected).error as Record<string, unknown>;
      assert.equal(error.code, 'UNKNOWN_OPERATION');
      assert.doesNotMatch(JSON.stringify(error), /stdout|stderr/);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
