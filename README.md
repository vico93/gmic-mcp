# gmic-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for the
[G'MIC CLI](https://gmic.eu/). It exposes thousands of commands and filters through a
fixed, low-token workflow:

```text
gmic_discover → gmic_describe → gmic_execute
```

The server does **not** register one MCP tool per G'MIC operation. It discovers the
installed CLI commands plus the official G'MIC-Qt filter catalogue, assigns stable
operation IDs, fills filter defaults, validates named parameters, and only then invokes
G'MIC.

## Requirements

- Node.js 22.12 or newer.
- A separately installed G'MIC command-line executable.
- Tested with G'MIC 4.0.7 on Windows.

G'MIC, its DLLs, filters, and documentation are not bundled or automatically installed.

## Install

```sh
npm ci
npm run build
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`:

```powershell
npm.cmd ci
npm.cmd run build
```

## MCP configuration

```json
{
  "mcpServers": {
    "gmic": {
      "command": "node",
      "args": ["/path/to/gmic-mcp/dist/index.js"],
      "env": {
        "GMIC_MCP_BIN": "/path/to/gmic"
      }
    }
  }
}
```

`GMIC_MCP_BIN` may identify the executable or its installation directory. If omitted,
the server searches its process-local `PATH`. An invalid explicit path never silently
falls back to another installation.

Do not use `GMIC_PATH` for executable discovery: G'MIC already reserves it for native
state. Each operation receives a fresh private `GMIC_PATH`, so the user's normal
`user.gmic`, cached updates, and `cli_start` hooks are not imported implicitly.

Relative paths use the MCP server's startup directory. Absolute paths are recommended.

## Tools

The default server exposes five tools:

| Tool                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `gmic_discover`      | Search commands and high-level filters by intent               |
| `gmic_describe`      | Fetch the exact schema/defaults for one operation ID           |
| `gmic_execute`       | Run validated operations with explicit inputs and outputs      |
| `gmic_inspect_image` | Inspect dimensions, channels, depth, bit depth, and statistics |
| `gmic_status`        | Troubleshoot the executable, build flags, and wrapper limits   |

An optional sixth tool, `gmic_run_trusted_code`, is enabled with
`GMIC_MCP_ENABLE_RAW=1`. It is an advanced escape hatch for raw pipelines and scripts,
not the normal path for filters.

### 1. Discover

```json
{
  "query": "dream smoothing",
  "kind": "all",
  "interactive": "exclude",
  "limit": 5
}
```

Typical compact result:

```json
{
  "operation_id": "filter:fx_dreamsmooth",
  "kind": "filter",
  "title": "Dream Smoothing",
  "category": "Artistic",
  "parameter_count": 9,
  "has_defaults": true
}
```

Never invent an operation ID. `filter:fx_colorize`, for example, is not a real operation;
discovery returns actual alternatives such as `filter:fx_recolorize`,
`filter:fx_bwrecolorize`, and `filter:fx_colorize_lineart`.

Search is deterministic and weighted toward exact IDs, commands, titles, categories,
parameter names, and short descriptions. Common intent synonyms such as blur/smooth,
resize/scale, and colorize/recolor are recognized. Large preset lists receive no special
ranking advantage.

### 2. Describe

```json
{
  "operation_id": "filter:fx_dreamsmooth"
}
```

Filter descriptions return named parameters, types, defaults, ranges, choices, and their
native positions. CLI commands return their native G'MIC argument syntax instead.

Large choice lists are paginated to reduce context use. Request one parameter or search
its choices with:

```json
{
  "operation_id": "filter:fx_dreamsmooth",
  "parameter_key": "merging_option",
  "choice_query": "soft",
  "choice_limit": 12
}
```

### 3. Execute

High-level filters use named parameters. Omitted values use catalogue defaults:

```json
{
  "inputs": ["/path/to/workspace/photo.png"],
  "operations": [
    {
      "operation_id": "filter:fx_dreamsmooth",
      "parameters": {
        "iterations": 4,
        "opacity": 0.75,
        "merging_option": "average"
      }
    }
  ],
  "outputs": [{ "path": "/path/to/workspace/dream.png" }],
  "preview": true
}
```

CLI commands use their exact operation ID and native positional syntax:

```json
{
  "inputs": ["/path/to/workspace/photo.png"],
  "operations": [
    { "operation_id": "cli:resize", "arguments": "50%,50%" },
    { "operation_id": "cli:blur", "arguments": "1.5", "selection": "0" }
  ],
  "outputs": [{ "path": "/path/to/workspace/small.png" }]
}
```

An operation may use `copy: true` to preserve selected originals. A selection is written
without brackets, for example `"0"`, `"0,2"`, `"0-3"`, or `"-1"`.

The structured executor rejects before processing:

- unknown operation IDs, with suggestions;
- unknown filter parameters;
- incorrect parameter types;
- values outside documented ranges;
- invalid choice labels or indices;
- operations requiring unsupported parameter serialization;
- interactive operations;
- catalogue filters not defined by the installed CLI.

## GUI filter catalogue

The executable's embedded command code omits much of the `#@gui` metadata used by
G'MIC-Qt. On the first discovery, the default `auto` mode retrieves the official JSON
metadata from:

```text
https://gmic.eu/update<installed_numeric_version>
```

Only metadata is read. The server does **not** install/import the remote command update.
The JSON is validated, stripped into an in-memory operation registry, and cached under
`GMIC_MCP_STATE_DIR/catalog`. Before a filter runs, the server verifies that its command
is actually defined by the local CLI.

The metadata request exposes the machine's IP address and G'MIC HTTP user agent to
`gmic.eu`, like other HTTP requests. Disable it for fully offline CLI-only discovery:

```json
{ "GMIC_MCP_GUI_CATALOG": "off" }
```

Or provide an already downloaded G'MIC GUI JSON catalogue:

```json
{ "GMIC_MCP_GUI_CATALOG": "/path/to/gmic-filters.json" }
```

Catalogue descriptions are untrusted reference data, never instructions to execute.

## Inputs, outputs, and previews

Inputs may be path strings or objects with `path`, `format`, and literal format `options`.
The wrapper copies them under safe aliases, so spaces, Unicode, commas, `$`, and braces in
filenames are not interpreted as G'MIC syntax.

Outputs require an existing parent directory. `overwrite` defaults to false and uses
exclusive publication. G'MIC may create multiple numbered files; always use the actual
returned paths.

G'MIC processes floating-point arrays. The wrapper does not implicitly normalize or clip
exports. Integer formats may quantize values; JPEG is lossy and cannot preserve alpha.
Use GMZ to retain signed floating-point data or add an explicit normalize/cut operation.

`preview: true` returns a separate bounded PNG MCP image block. `preview_mode` may be
`clip` or `normalize`; only the thumbnail is adapted. Signals, volumes, and meshes are not
silently flattened.

## Environment variables

| Variable                     | Default                 | Purpose                                    |
| ---------------------------- | ----------------------- | ------------------------------------------ |
| `GMIC_MCP_BIN`               | Search PATH             | Executable or installation directory       |
| `GMIC_MCP_STATE_DIR`         | User cache / `gmic-mcp` | Job and catalogue state                    |
| `GMIC_MCP_GUI_CATALOG`       | `auto`                  | `auto`, `off`, or local GUI JSON path      |
| `GMIC_MCP_ENABLE_RAW`        | `false`                 | Expose `gmic_run_trusted_code`             |
| `GMIC_MCP_TIMEOUT_MS`        | `120000`                | Operation timeout, including queue wait    |
| `GMIC_MCP_MAX_CONCURRENCY`   | `1`                     | Concurrent native processes (1–16)         |
| `GMIC_MCP_MAX_INPUT_BYTES`   | `268435456`             | Aggregate managed input size               |
| `GMIC_MCP_MAX_LOG_BYTES`     | `1048576`               | Captured bytes per native stream           |
| `GMIC_MCP_MAX_OUTPUT_FILES`  | `128`                   | Maximum managed output artifacts           |
| `GMIC_MCP_MAX_PREVIEW_BYTES` | `2097152`               | Maximum preview file size                  |
| `GMIC_MCP_PASS_ENV`          | Empty                   | Extra environment variable names for G'MIC |

Tool-level `timeout_ms` can lower but not raise the configured timeout ceiling.

## Errors and token use

Tool handlers return a compact structured envelope:

```json
{ "ok": true, "result": {} }
```

Failures use `isError: true`:

```json
{
  "ok": false,
  "error": {
    "code": "UNKNOWN_OPERATION",
    "message": "No installed operation has ID 'filter:fx_colorize'.",
    "details": {
      "suggestions": ["filter:fx_recolorize", "filter:fx_bwrecolorize"],
      "next_action": "Call gmic_discover and use an exact returned operation_id."
    }
  }
}
```

Native failures return a short relevant message and timing/exit metadata rather than full
stdout/stderr. Large filter choice lists and discovery results are paginated. Preview bytes
are returned only in the MCP image block, not duplicated in structured JSON.

## Security boundary

- Local stdio transport only; no unauthenticated HTTP endpoint.
- Native processes use argument arrays with `shell: false`.
- Child processes receive a minimal environment; harness secrets are not inherited unless
  named in `GMIC_MCP_PASS_ENV`.
- Every job gets private state and managed input/output staging.
- Timeouts and cancellation perform best-effort process-tree cleanup.
- Structured execution restricts names and typed filter values, but installed G'MIC
  operations are still trusted local code and may themselves access files/network.
- `gmic_run_trusted_code` is explicitly **not a sandbox** and can bypass managed-output
  protections. Do not expose this server to untrusted clients.

## Context resources

- `gmic://guide/pipelines`
- `gmic://guide/output`
- `gmic://guide/scripts`

Clients may ignore MCP resources, so essential workflow rules are duplicated in short server
instructions, tool descriptions, discovery results, and recoverable errors.

## Development

```sh
npm run typecheck
npm test
npm run format:check
npm audit
npm pack --dry-run
```

Native integration tests run when `GMIC_MCP_TEST_BIN` is set:

```powershell
$env:GMIC_MCP_TEST_BIN = '/path/to/gmic'
npm.cmd test
```

Tests cover both MCP protocol eras, operation discovery/ranking, GUI defaults, unknown IDs,
named-parameter validation, scripts, image metadata, previews, GMZ precision, volumes,
3D objects, codecs, filenames, overwrite protection, failures, timeouts, and process cleanup.

## References and license

- [G'MIC reference](https://gmic.eu/reference/)
- [G'MIC tutorial](https://gmic.eu/tutorial/)
- [G'MIC cheatsheets](https://gmic.eu/tutorial/cheatsheet.html)
- [G'MIC Community](https://github.com/GreycLab/gmic-community)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

The wrapper is MIT licensed. G'MIC and its remotely retrieved metadata have their own
CeCILL/CeCILL-C-compatible licensing; they are not redistributed by this package.
