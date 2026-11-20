import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { describeError } from './errors.js';
import { GmicService, type ExecutionResult } from './gmic/service.js';
import { guides, serverInstructions } from './guides.js';
import {
  describeSchema,
  discoverSchema,
  executeSchema,
  imageInfoSchema,
  resultSchema,
  trustedCodeSchema,
  type PipelineArgs,
  type ScriptArgs,
} from './schemas.js';

export { loadConfig } from './config.js';
export { GmicService } from './gmic/service.js';

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const discoversRemoteMetadata = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
const executesCode = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function compactDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if ('stdout' in object && 'stderr' in object) {
    return {
      exitCode: object.exitCode,
      signal: object.signal,
      durationMs: object.durationMs,
      logsTruncated: object.logsTruncated,
    };
  }
  if (Array.isArray(value)) return value.map(compactDiagnostics);
  return Object.fromEntries(
    Object.entries(object).map(([key, field]) => [key, compactDiagnostics(field)]),
  );
}

function compactFailure(error: unknown): Record<string, unknown> {
  const described = describeError(error);
  const details = described.details;
  if (!details || typeof details !== 'object') return described;
  const diagnostics = (details as Record<string, unknown>).diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return described;
  const native = diagnostics as Record<string, unknown>;
  const stderr = typeof native.stderr === 'string' ? native.stderr : '';
  const stdout = typeof native.stdout === 'string' ? native.stdout : '';
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const relevant = lines.filter((line) =>
    /\*\*\* Error|Unknown command|Undefined argument|No help available/i.test(line),
  );
  return {
    code: described.code,
    message: described.message,
    details: {
      ...Object.fromEntries(
        Object.entries(details as Record<string, unknown>).filter(([key]) => key !== 'diagnostics'),
      ),
      nativeMessage: (
        relevant.at(-1) ??
        lines.at(-1) ??
        "G'MIC failed without a diagnostic message"
      ).slice(-2000),
      exitCode: native.exitCode,
      durationMs: native.durationMs,
      logsTruncated: native.logsTruncated,
    },
  };
}

async function respond(
  callback: () => Promise<Record<string, unknown> | ExecutionResult>,
): Promise<CallToolResult> {
  try {
    const data = await callback();
    const preview = 'preview' in data ? (data.preview as ExecutionResult['preview']) : undefined;
    const { preview: _preview, ...metadata } = data as unknown as Record<string, unknown>;
    const envelope = {
      ok: true,
      result: compactDiagnostics({
        ...metadata,
        ...(preview
          ? { preview: { mimeType: preview.mimeType, sourcePath: preview.sourcePath } }
          : {}),
      }),
    };
    return {
      structuredContent: envelope,
      content: [
        { type: 'text', text: JSON.stringify(envelope) },
        ...(preview
          ? [{ type: 'image' as const, data: preview.data, mimeType: preview.mimeType }]
          : []),
      ],
    };
  } catch (error) {
    const envelope = { ok: false, error: compactFailure(error) };
    return {
      isError: true,
      structuredContent: envelope,
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
  }
}

export function createServer(service: GmicService): McpServer {
  const server = new McpServer(
    { name: 'gmic-mcp', version: '0.2.0' },
    { instructions: serverInstructions, maxToolInputElements: 10_000 },
  );

  server.registerTool(
    'gmic_status',
    {
      title: "G'MIC status",
      description:
        "Troubleshoot the local G'MIC executable, version, capabilities and wrapper limits. Ordinary image work should begin with gmic_discover, not this tool.",
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    (ctx) => respond(() => service.info(ctx.mcpReq.signal)),
  );

  server.registerTool(
    'gmic_discover',
    {
      title: "Discover G'MIC operations",
      description:
        'Find installed CLI commands and high-level GUI filters for an image-processing intent. Never invent an operation ID: use an exact operation_id returned here, then call gmic_describe or gmic_execute. Results are compact and ranked; the first call may fetch and cache official version-addressed GUI metadata from gmic.eu.',
      inputSchema: discoverSchema,
      outputSchema: resultSchema,
      annotations: discoversRemoteMetadata,
    },
    (args, ctx) => respond(() => service.discover(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'gmic_describe',
    {
      title: "Describe a G'MIC operation",
      description:
        'Resolve one exact operation_id from gmic_discover. Returns named filter parameters with defaults/ranges/choices, or native argument syntax for a CLI command. Call this before overriding parameters; defaults can be executed without guessing positional arguments.',
      inputSchema: describeSchema,
      outputSchema: resultSchema,
      annotations: discoversRemoteMetadata,
    },
    (args, ctx) =>
      respond(() =>
        service.describe(args.operation_id, ctx.mcpReq.signal, {
          ...(args.parameter_key ? { parameterKey: args.parameter_key } : {}),
          ...(args.choice_query ? { choiceQuery: args.choice_query } : {}),
          choiceOffset: args.choice_offset,
          choiceLimit: args.choice_limit,
        }),
      ),
  );

  server.registerTool(
    'gmic_inspect_image',
    {
      title: 'Inspect image data',
      description:
        "Read a local image's dimensions, depth, channels, statistics and source bit depth when G'MIC reports it. Use before selecting frames/layers or when an operation has input constraints. It stages a copy and never opens a display window implicitly.",
      inputSchema: imageInfoSchema,
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    (args, ctx) => respond(() => service.imageInfo(args.input, args.timeout_ms, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'gmic_execute',
    {
      title: "Execute G'MIC operations",
      description:
        'Execute a sequence of exact operation_id values from gmic_discover. GUI filters take named parameters and omitted values use validated defaults; CLI commands take native arguments. Unknown IDs/parameters are rejected before processing, interactive operations are blocked, outputs are explicit, and optional previews never alter exported data.',
      inputSchema: executeSchema,
      outputSchema: resultSchema,
      annotations: executesCode,
    },
    (args, ctx) => respond(() => service.executeOperations(args, ctx.mcpReq.signal)),
  );

  if (service.config.enableRaw) {
    server.registerTool(
      'gmic_run_trusted_code',
      {
        title: "Run trusted raw G'MIC code",
        description:
          'Advanced fallback only: run raw pipeline steps or complete .gmic definitions when structured discovery cannot express the task or the user explicitly requests code. This is trusted local code with filesystem, network and process capabilities; it can bypass managed-output protections and is not a sandbox.',
        inputSchema: trustedCodeSchema,
        outputSchema: resultSchema,
        annotations: executesCode,
      },
      (args, ctx) =>
        respond(() => {
          if (args.pipeline) {
            const pipeline: PipelineArgs = {
              inputs: args.inputs,
              outputs: args.outputs,
              command_files: args.command_files,
              overwrite: args.overwrite,
              preview: args.preview,
              preview_mode: args.preview_mode,
              preview_max_dimension: args.preview_max_dimension,
              steps: args.pipeline.steps,
              ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
            };
            return service.runPipeline(pipeline, ctx.mcpReq.signal);
          }
          const script = args.script!;
          const request: ScriptArgs = {
            inputs: args.inputs,
            outputs: args.outputs,
            command_files: args.command_files,
            overwrite: args.overwrite,
            preview: args.preview,
            preview_mode: args.preview_mode,
            preview_max_dimension: args.preview_max_dimension,
            entrypoint: script.entrypoint,
            ...(script.source !== undefined ? { script: script.source } : { path: script.path! }),
            ...(script.arguments !== undefined ? { arguments: script.arguments } : {}),
            ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
          };
          return service.runScript(request, ctx.mcpReq.signal);
        }),
    );
  }

  for (const guide of guides) {
    server.registerResource(
      guide.name,
      guide.uri,
      { title: guide.title, description: guide.title, mimeType: 'text/markdown' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide.text }],
      }),
    );
  }
  return server;
}
