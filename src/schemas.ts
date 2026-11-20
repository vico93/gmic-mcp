import { z } from 'zod';

const singleLine = z
  .string()
  .max(65_536)
  .refine((value) => !/[\0\r\n]/.test(value), {
    message: "Use a single line of G'MIC syntax; use gmic_run_script for multiline code.",
  });
export const localPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value), {
    message: 'A local path cannot contain NUL or newline characters.',
  });
export const commandNameSchema = z
  .string()
  .max(128)
  .regex(
    /^(?:[A-Za-z_][A-Za-z0-9_]*|(?:\+|-|\*|\/|%|\^|==|!=|>=|<=|>|<|&|\||<<|>>|=>)(?:3d)?|3d)$/,
    "Use an undecorated G'MIC command name (put image selection and copy mode in their own fields).",
  );
const selectionSchema = z
  .string()
  .max(512)
  .regex(
    /^[A-Za-z0-9_,%:~.^+*\-/]*$/,
    'Use image indices, ranges, inversion, or names without square brackets.',
  );
const formatSchema = z
  .string()
  .max(16)
  .regex(/^[a-zA-Z][a-zA-Z0-9]*$/);
const inputOptionsSchema = z
  .string()
  .max(8192)
  .regex(
    /^[A-Za-z0-9_,.%:+-]*$/,
    'Use literal comma-separated file options without whitespace, quotes, or substitutions; use a pipeline step/script for expressions.',
  );
const inputObjectSchema = z
  .object({
    path: localPathSchema,
    options: inputOptionsSchema
      .optional()
      .describe('Native input format options, e.g. uint16,128,128 for RAW.'),
    format: formatSchema.optional().describe("Force a G'MIC file format, e.g. png or raw."),
  })
  .strict();
export const inputSchema = z.union([localPathSchema, inputObjectSchema]);
export const outputSchema = z
  .object({
    path: localPathSchema.describe(
      'Destination file/template. Its parent directory must already exist.',
    ),
    selection: selectionSchema
      .optional()
      .describe('No brackets; omit to export the entire image stack.'),
    options: singleLine
      .optional()
      .describe('Native output options, e.g. 16 for PNG or 90 for JPEG quality.'),
    format: formatSchema
      .optional()
      .describe('Force a format independent of the destination extension.'),
  })
  .strict();
export const stepSchema = z
  .object({
    command: commandNameSchema,
    arguments: singleLine
      .optional()
      .describe(
        "Raw G'MIC argument syntax, not shell syntax. Quote embedded strings as G'MIC requires.",
      ),
    selection: selectionSchema.optional(),
    copy: z.boolean().default(false).describe('Use +command to preserve the selected originals.'),
  })
  .strict();

const executionFields = {
  inputs: z.array(inputSchema).max(128).default([]),
  outputs: z.array(outputSchema).max(32).default([]),
  command_files: z
    .array(localPathSchema)
    .max(32)
    .default([])
    .describe('Explicitly import trusted local .gmic command files.'),
  overwrite: z.boolean().default(false),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .optional()
    .describe('May lower, but not raise, the configured timeout.'),
  preview: z
    .boolean()
    .default(false)
    .describe('Include a bounded PNG preview of the first eligible exported image.'),
  preview_mode: z
    .enum(['clip', 'normalize'])
    .default('clip')
    .describe('Only the derived preview is adapted, never the actual export.'),
  preview_max_dimension: z.number().int().min(64).max(2048).default(1024),
};

export const pipelineSchema = z
  .object({
    ...executionFields,
    outputs: z.array(outputSchema).min(1).max(32),
    steps: z.array(stepSchema).max(1024).default([]),
  })
  .strict()
  .refine((value) => value.inputs.length > 0 || value.steps.length > 0, {
    message: 'Provide input files or steps that generate image data.',
  });

export const scriptSchema = z
  .object({
    ...executionFields,
    script: z
      .string()
      .min(1)
      .max(1_048_576)
      .refine((value) => !value.includes('\0'))
      .optional()
      .describe(
        'Complete .gmic command definitions, not a shell command. Define the entrypoint below.',
      ),
    path: localPathSchema.optional().describe('Alternatively, a local .gmic command file.'),
    entrypoint: commandNameSchema.default('_main_'),
    arguments: singleLine.optional().describe("Raw G'MIC arguments passed to the entrypoint."),
  })
  .strict()
  .refine((value) => (value.script !== undefined) !== (value.path !== undefined), {
    message: 'Provide exactly one of script or path.',
  });

export const imageInfoSchema = z
  .object({
    input: inputSchema,
    timeout_ms: executionFields.timeout_ms,
  })
  .strict();

export const searchSchema = z
  .object({
    query: z.string().max(256).default(''),
    category: z.string().max(256).optional(),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const discoverSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(256)
      .describe('Image-processing intent, filter title, or command name.'),
    kind: z.enum(['all', 'filter', 'command']).default('all'),
    category: z.string().max(256).optional(),
    interactive: z.enum(['exclude', 'include', 'only']).default('exclude'),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const describeSchema = z
  .object({
    operation_id: z.string().min(1).max(256).describe('Exact ID returned by gmic_discover.'),
    parameter_key: z
      .string()
      .max(256)
      .optional()
      .describe('Optionally return only one named parameter from a filter descriptor.'),
    choice_query: z
      .string()
      .max(256)
      .optional()
      .describe('Filter a large choice list by label; use with parameter_key.'),
    choice_offset: z.number().int().min(0).max(100_000).default(0),
    choice_limit: z.number().int().min(1).max(100).default(12),
  })
  .strict();

const parameterValueSchema = z.union([
  z.string().max(8192),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([z.string().max(2048), z.number().finite(), z.boolean()])).max(16),
]);

export const operationStepSchema = z
  .object({
    operation_id: z.string().min(1).max(256).describe('Exact ID returned by gmic_discover.'),
    parameters: z
      .record(z.string(), parameterValueSchema)
      .refine(
        (value) => Object.keys(value).length <= 128,
        'At most 128 parameter overrides are allowed.',
      )
      .optional()
      .describe('Named filter parameters from gmic_describe. Omitted values use filter defaults.'),
    arguments: singleLine
      .optional()
      .describe('Native positional syntax for kind=command only; filters use named parameters.'),
    selection: selectionSchema.optional(),
    copy: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !(value.parameters && value.arguments !== undefined), {
    message: 'Use parameters for filters or arguments for CLI commands, not both.',
  });

export const executeSchema = z
  .object({
    inputs: executionFields.inputs,
    outputs: z.array(outputSchema).min(1).max(32),
    overwrite: executionFields.overwrite,
    timeout_ms: executionFields.timeout_ms,
    preview: executionFields.preview,
    preview_mode: executionFields.preview_mode,
    preview_max_dimension: executionFields.preview_max_dimension,
    operations: z.array(operationStepSchema).min(1).max(128),
  })
  .strict();

export const trustedCodeSchema = z
  .object({
    ...executionFields,
    pipeline: z
      .object({ steps: z.array(stepSchema).min(1).max(1024) })
      .strict()
      .optional(),
    script: z
      .object({
        source: z
          .string()
          .min(1)
          .max(1_048_576)
          .refine((value) => !value.includes('\0'))
          .optional(),
        path: localPathSchema.optional(),
        entrypoint: commandNameSchema.default('_main_'),
        arguments: singleLine.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.pipeline !== undefined) !== (value.script !== undefined), {
    message: 'Provide exactly one of pipeline or script.',
  })
  .refine(
    (value) =>
      !value.script || (value.script.source !== undefined) !== (value.script.path !== undefined),
    {
      message: 'A script requires exactly one of source or path.',
    },
  );

export const helpSchema = z
  .object({
    command: z.union([
      commandNameSchema,
      z
        .string()
        .max(128)
        .regex(/^[+-][A-Za-z_][A-Za-z0-9_]*$/),
    ]),
  })
  .strict();
export const resultSchema = z.object({
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;
export type Step = z.infer<typeof stepSchema>;
export type PipelineArgs = z.infer<typeof pipelineSchema>;
export type ScriptArgs = z.infer<typeof scriptSchema>;
export type ExecutionArgs = Omit<PipelineArgs, 'steps'>;
export type DiscoverArgs = z.infer<typeof discoverSchema>;
export type ExecuteArgs = z.infer<typeof executeSchema>;
export type OperationStep = z.infer<typeof operationStepSchema>;
export type TrustedCodeArgs = z.infer<typeof trustedCodeSchema>;
