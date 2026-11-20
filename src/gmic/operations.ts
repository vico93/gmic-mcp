import { GmicError } from '../errors.js';
import type { DiscoverArgs, OperationStep } from '../schemas.js';
import type { CommandDoc } from './catalogue.js';

export type OperationKind = 'command' | 'filter';

export interface OperationParameter {
  key: string;
  name: string;
  type:
    | 'integer'
    | 'number'
    | 'boolean'
    | 'choice'
    | 'color'
    | 'point'
    | 'button'
    | 'value'
    | 'unsupported';
  position: number;
  span: number;
  nativeDefault: string[];
  defaultValue: unknown;
  minimum?: number | undefined;
  maximum?: number | undefined;
  choices?: Record<string, string> | undefined;
  exposed: boolean;
}

export interface Operation {
  operationId: string;
  kind: OperationKind;
  command: string;
  title: string;
  category: string;
  summary: string;
  interactive: boolean;
  structured: boolean;
  argumentSyntax?: string | undefined;
  documentation?: string | undefined;
  parameters?: OperationParameter[] | undefined;
}

export interface OperationRegistry {
  operations: Operation[];
  byId: Map<string, Operation>;
  warnings: string[];
  cliCount: number;
  filterCount: number;
  guiSourceVersion?: string | undefined;
}

interface RawGuiParameter {
  type?: unknown;
  name?: unknown;
  default?: unknown;
  value?: unknown;
  position?: unknown;
  pos?: unknown;
  min?: unknown;
  max?: unknown;
  choices?: unknown;
  text?: unknown;
}

const blockedCommands = new Set([
  'camera',
  'command',
  'display',
  'display0',
  'exec',
  'exec_out',
  'input_text',
  'output',
  'output_text',
  'update',
  'wait',
  'window',
]);

const synonyms: Record<string, string[]> = {
  blur: ['smooth', 'soften'],
  smooth: ['blur', 'soften'],
  soften: ['blur', 'smooth'],
  colorize: ['recolor', 'tint', 'colourize'],
  recolor: ['colorize', 'tint'],
  resize: ['scale', 'resample'],
  scale: ['resize', 'resample'],
  monochrome: ['grayscale', 'greyscale', 'blackwhite', 'bw'],
  grayscale: ['monochrome', 'greyscale', 'bw'],
  sharpen: ['detail', 'clarity'],
  detail: ['sharpen', 'clarity'],
  denoise: ['noise', 'repair', 'despeckle'],
  repair: ['denoise', 'restore'],
  dreamlike: ['dream', 'dreamy', 'smooth'],
  dreamy: ['dream', 'smooth'],
  suavizar: ['smooth', 'blur'],
  desfocar: ['blur'],
  colorir: ['colorize'],
  redimensionar: ['resize', 'scale'],
  nitidez: ['sharpen', 'detail'],
  ruido: ['denoise', 'noise'],
  sonho: ['dream', 'dreamy'],
};

const stopWords = new Set([
  'a',
  'an',
  'and',
  'apply',
  'effect',
  'filter',
  'for',
  'image',
  'make',
  'of',
  'on',
  'photo',
  'picture',
  'please',
  'the',
  'to',
  'with',
]);

export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compact(value: string): string {
  return normalizeText(value).replaceAll(' ', '');
}

function keyFrom(name: string, fallback: string): string {
  const key = normalizeText(name)
    .replace(/\s+/g, '_')
    .replace(/^[0-9]+/, '');
  return key || fallback;
}

function cleanNote(value: string): string {
  return value
    .replace(/data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[embedded image]')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function finite(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function parseParameter(raw: RawGuiParameter, used: Set<string>): OperationParameter | undefined {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const position = finite(raw.pos ?? raw.position);
  if (position === undefined || position < 1 || !Number.isInteger(position)) return undefined;
  const name =
    typeof raw.name === 'string' && raw.name.trim() ? cleanNote(raw.name).slice(0, 200) : type;
  let key = keyFrom(name, `${type}_${position}`);
  const base = key;
  for (let suffix = 2; used.has(key); suffix++) key = `${base}_${suffix}`;
  used.add(key);

  const stringDefault = raw.default === undefined ? '' : String(raw.default);
  let nativeDefault = [stringDefault];
  let mapped: OperationParameter['type'] = 'unsupported';
  let defaultValue: unknown = stringDefault;
  let exposed = true;
  let choices: Record<string, string> | undefined;
  if (type === 'int' || type === 'float') {
    mapped = type === 'int' ? 'integer' : 'number';
    defaultValue = finite(raw.default) ?? 0;
  } else if (type === 'bool') {
    mapped = 'boolean';
    defaultValue = /^(1|true)$/i.test(stringDefault);
    nativeDefault = [defaultValue ? '1' : '0'];
  } else if (type === 'button') {
    mapped = 'button';
    defaultValue = false;
    nativeDefault = ['0'];
  } else if (type === 'choice') {
    mapped = 'choice';
    if (raw.choices && typeof raw.choices === 'object' && !Array.isArray(raw.choices)) {
      choices = Object.fromEntries(
        Object.entries(raw.choices as Record<string, unknown>)
          .slice(0, 10_000)
          .map(([k, v]) => [k.slice(0, 32), cleanNote(String(v)).slice(0, 500)]),
      );
    }
    const index = String(Math.trunc(finite(raw.default) ?? 0));
    nativeDefault = [index];
    defaultValue = choices?.[index] ?? Number(index);
  } else if (type === 'color') {
    mapped = 'color';
    nativeDefault = stringDefault.split(',').map((item) => item.trim());
    defaultValue = nativeDefault.map((item) => finite(item) ?? 0);
  } else if (type === 'point') {
    mapped = 'point';
    nativeDefault = String(raw.position ?? raw.default ?? '0,0')
      .split(',')
      .slice(0, 2)
      .map((item) => item.trim());
    while (nativeDefault.length < 2) nativeDefault.push('0');
    defaultValue = nativeDefault.map((item) => finite(item) ?? 0);
  } else if (type === 'value') {
    mapped = 'value';
    exposed = false;
    nativeDefault = [String(raw.value ?? raw.default ?? '')];
    defaultValue = nativeDefault[0];
  }
  return {
    key,
    name,
    type: mapped,
    position,
    span: nativeDefault.length,
    nativeDefault,
    defaultValue,
    ...(finite(raw.min) !== undefined ? { minimum: finite(raw.min)! } : {}),
    ...(finite(raw.max) !== undefined ? { maximum: finite(raw.max)! } : {}),
    ...(choices ? { choices } : {}),
    exposed,
  };
}

export function parseGuiOperations(value: unknown): {
  filters: Operation[];
  sourceVersion?: string;
} {
  if (!value || typeof value !== 'object')
    throw new GmicError('CATALOGUE_INVALID', 'GUI catalogue is not an object.');
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.categories))
    throw new GmicError('CATALOGUE_INVALID', 'GUI catalogue has no categories array.');
  const filters: Operation[] = [];
  for (const rawCategory of root.categories) {
    if (!rawCategory || typeof rawCategory !== 'object') continue;
    const categoryObject = rawCategory as Record<string, unknown>;
    const category =
      typeof categoryObject.name === 'string'
        ? cleanNote(categoryObject.name).slice(0, 200)
        : 'Uncategorized';
    if (!Array.isArray(categoryObject.filters)) continue;
    for (const rawFilter of categoryObject.filters) {
      if (!rawFilter || typeof rawFilter !== 'object') continue;
      const filter = rawFilter as Record<string, unknown>;
      const command = typeof filter.command === 'string' ? filter.command.trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(command) || command === '_none_' || category === 'About')
        continue;
      const title =
        typeof filter.name === 'string' ? cleanNote(filter.name).slice(0, 200) : command;
      const rawParameters = Array.isArray(filter.parameters)
        ? (filter.parameters as RawGuiParameter[])
        : [];
      const notes = rawParameters
        .filter((parameter) => parameter.type === 'note' && typeof parameter.text === 'string')
        .map((parameter) => cleanNote(String(parameter.text)))
        .filter((note) => note && !/^author\s*:/i.test(note) && !note.includes('[embedded image]'));
      const used = new Set<string>();
      const parameters = rawParameters
        .map((parameter) => parseParameter(parameter, used))
        .filter((parameter): parameter is OperationParameter => Boolean(parameter));
      const maxPosition = parameters.reduce(
        (max, parameter) => Math.max(max, parameter.position + parameter.span - 1),
        0,
      );
      const occupied = new Set(
        parameters.flatMap((parameter) =>
          Array.from({ length: parameter.span }, (_, i) => parameter.position + i),
        ),
      );
      const unsupported =
        parameters.some((parameter) => parameter.type === 'unsupported') ||
        (maxPosition > 0 && occupied.size !== maxPosition);
      const interactive = /interactive|display|camera|game/i.test(
        `${title} ${command} ${category} ${notes.slice(0, 3).join(' ')}`,
      );
      filters.push({
        operationId: `filter:${command}`,
        kind: 'filter',
        command,
        title,
        category,
        summary: (notes.find((note) => note.length >= 20) ?? `${title} filter.`).slice(0, 500),
        interactive,
        structured: !unsupported && !interactive,
        parameters,
      });
    }
  }
  return {
    filters,
    ...(typeof root.gmic_version === 'string' ? { sourceVersion: root.gmic_version } : {}),
  };
}

export function buildRegistry(
  commands: CommandDoc[],
  filters: Operation[],
  warnings: string[],
  guiSourceVersion?: string,
): OperationRegistry {
  const operations: Operation[] = commands.map((command) => ({
    operationId: `cli:${command.name}`,
    kind: 'command',
    command: command.name,
    title: command.name,
    category: command.category,
    summary: command.description.slice(0, 500),
    interactive:
      /interactive|viewer|display|window|camera/i.test(command.category) ||
      /^(?:display|window|camera|wait|x_)/.test(command.name),
    structured: !blockedCommands.has(command.name),
    argumentSyntax: command.arguments,
    documentation: command.documentation,
  }));
  const seen = new Set(operations.map((operation) => operation.operationId));
  for (const filter of filters)
    if (!seen.has(filter.operationId)) {
      operations.push(filter);
      seen.add(filter.operationId);
    }
  operations.sort((a, b) => a.title.localeCompare(b.title, 'en'));
  return {
    operations,
    byId: new Map(operations.map((operation) => [operation.operationId, operation])),
    warnings,
    cliCount: commands.length,
    filterCount: filters.length,
    ...(guiSourceVersion ? { guiSourceVersion } : {}),
  };
}

function trigramScore(left: string, right: string): number {
  const grams = (value: string) =>
    new Set(Array.from({ length: Math.max(0, value.length - 2) }, (_, i) => value.slice(i, i + 3)));
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common++;
  return (2 * common) / (a.size + b.size);
}

export function discoverOperations(registry: OperationRegistry, args: DiscoverArgs): Operation[] {
  const phrase = normalizeText(args.query);
  const compactQuery = compact(args.query);
  const baseTokens = phrase.split(' ').filter((token) => token && !stopWords.has(token));
  const tokens = [...new Set(baseTokens.flatMap((token) => [token, ...(synonyms[token] ?? [])]))];
  const scored: { operation: Operation; score: number }[] = [];
  for (const operation of registry.operations) {
    if (args.kind !== 'all' && operation.kind !== args.kind) continue;
    if (args.category && !normalizeText(operation.category).includes(normalizeText(args.category)))
      continue;
    if (args.interactive === 'exclude' && operation.interactive) continue;
    if (args.interactive === 'only' && !operation.interactive) continue;
    const command = normalizeText(operation.command);
    const title = normalizeText(operation.title);
    const category = normalizeText(operation.category);
    const params = normalizeText(
      operation.parameters?.map((parameter) => parameter.name).join(' ') ?? '',
    );
    const summary = normalizeText(operation.summary);
    let score = 0;
    if (compact(operation.operationId) === compactQuery) score += 1200;
    if (compact(operation.command) === compactQuery) score += 1000;
    if (compact(operation.title) === compactQuery) score += 900;
    if (title.includes(phrase)) score += 300;
    if (command.includes(phrase)) score += 250;
    for (const token of tokens) {
      if (title.split(' ').includes(token)) score += 70;
      else if (title.includes(token)) score += 35;
      if (command.includes(token)) score += 55;
      if (category.includes(token)) score += 18;
      if (params.includes(token)) score += 12;
      if (summary.includes(token)) score += 4;
    }
    score +=
      40 *
      Math.max(
        trigramScore(compactQuery, compact(operation.title)),
        trigramScore(compactQuery, compact(operation.command)),
      );
    if (score >= 15) scored.push({ operation, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.operation.title.localeCompare(b.operation.title, 'en'))
    .map((item) => item.operation);
}

export function operationSuggestions(
  registry: OperationRegistry,
  value: string,
  limit = 5,
): string[] {
  const query = normalizeText(value.replace(/^(cli|filter):/, '')) || value;
  return discoverOperations(registry, {
    query,
    kind: 'all',
    interactive: 'include',
    offset: 0,
    limit,
    category: undefined,
  })
    .slice(0, limit)
    .map((operation) => operation.operationId);
}

export interface DescribeOptions {
  parameterKey?: string | undefined;
  choiceQuery?: string | undefined;
  choiceOffset?: number | undefined;
  choiceLimit?: number | undefined;
}

function parameterForModel(
  parameter: OperationParameter,
  options: DescribeOptions = {},
): Record<string, unknown> {
  const allChoices = Object.entries(parameter.choices ?? {});
  const query = normalizeText(options.choiceQuery ?? '');
  const filteredChoices = query
    ? allChoices.filter(([, label]) => normalizeText(label).includes(query))
    : allChoices;
  const offset = options.choiceOffset ?? 0;
  const limit = options.choiceLimit ?? 12;
  const choices = Object.fromEntries(filteredChoices.slice(offset, offset + limit));
  return {
    key: parameter.key,
    name: parameter.name,
    type: parameter.type,
    default: parameter.defaultValue,
    ...(parameter.minimum !== undefined ? { minimum: parameter.minimum } : {}),
    ...(parameter.maximum !== undefined ? { maximum: parameter.maximum } : {}),
    ...(parameter.choices
      ? {
          choices,
          choice_count: allChoices.length,
          matching_choice_count: filteredChoices.length,
          choices_truncated: offset + limit < filteredChoices.length,
          next_choice_offset: offset + limit < filteredChoices.length ? offset + limit : null,
        }
      : {}),
    positions: Array.from({ length: parameter.span }, (_, i) => parameter.position + i),
  };
}

export function describeOperation(
  operation: Operation,
  options: DescribeOptions = {},
): Record<string, unknown> {
  if (operation.kind === 'command')
    return {
      operation_id: operation.operationId,
      kind: operation.kind,
      command: operation.command,
      title: operation.title,
      category: operation.category,
      summary: operation.summary,
      interactive: operation.interactive,
      executable_with: operation.structured ? 'gmic_execute' : 'gmic_run_trusted_code',
      parameter_style: 'native_gmic_arguments',
      argument_syntax: operation.argumentSyntax ?? '',
      documentation: operation.documentation?.slice(0, 8000) ?? '',
      execute_example: {
        operation_id: operation.operationId,
        arguments: operation.argumentSyntax ? '<use syntax above>' : undefined,
      },
    };
  const allParameters = (operation.parameters ?? []).filter((parameter) => parameter.exposed);
  const parameters = options.parameterKey
    ? allParameters.filter((parameter) => parameter.key === options.parameterKey)
    : allParameters;
  if (options.parameterKey && !parameters.length) {
    throw new GmicError(
      'UNKNOWN_PARAMETER',
      `Unknown parameter '${options.parameterKey}' for ${operation.operationId}.`,
      {
        known_parameters: allParameters.map((parameter) => parameter.key),
      },
    );
  }
  return {
    operation_id: operation.operationId,
    kind: operation.kind,
    command: operation.command,
    title: operation.title,
    category: operation.category,
    summary: operation.summary,
    interactive: operation.interactive,
    executable_with: operation.structured ? 'gmic_execute' : 'gmic_run_trusted_code',
    parameter_style: 'named',
    parameters: parameters.map((parameter) => parameterForModel(parameter, options)),
    ...(!options.parameterKey
      ? {
          default_parameters: Object.fromEntries(
            allParameters.map((parameter) => [parameter.key, parameter.defaultValue]),
          ),
        }
      : {}),
    ...(parameters.some((parameter) =>
      parameter.choices
        ? Object.keys(parameter.choices).length > (options.choiceLimit ?? 12)
        : false,
    )
      ? {
          next_action:
            'Call gmic_describe again with parameter_key and choice_query/choice_offset to page large choice lists.',
        }
      : {}),
    execute_example: { operation_id: operation.operationId, parameters: {} },
  };
}

function numeric(parameter: OperationParameter, value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (parameter.type === 'integer' && !Number.isInteger(value))
  ) {
    throw new GmicError(
      'INVALID_PARAMETER',
      `${parameter.key} must be ${parameter.type === 'integer' ? 'an integer' : 'a number'}.`,
    );
  }
  if (parameter.minimum !== undefined && value < parameter.minimum)
    throw new GmicError('VALUE_OUT_OF_RANGE', `${parameter.key} must be >= ${parameter.minimum}.`);
  if (parameter.maximum !== undefined && value > parameter.maximum)
    throw new GmicError('VALUE_OUT_OF_RANGE', `${parameter.key} must be <= ${parameter.maximum}.`);
  return value;
}

function serializeParameter(parameter: OperationParameter, value: unknown): string[] {
  if (parameter.type === 'integer' || parameter.type === 'number')
    return [String(numeric(parameter, value))];
  if (parameter.type === 'boolean' || parameter.type === 'button') {
    if (typeof value !== 'boolean')
      throw new GmicError('INVALID_PARAMETER', `${parameter.key} must be boolean.`);
    return [value ? '1' : '0'];
  }
  if (parameter.type === 'choice') {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      parameter.choices?.[String(value)] !== undefined
    )
      return [String(value)];
    if (typeof value === 'string') {
      const match = Object.entries(parameter.choices ?? {}).find(
        ([, label]) => normalizeText(label) === normalizeText(value),
      );
      if (match) return [match[0]];
    }
    throw new GmicError(
      'INVALID_PARAMETER',
      `${parameter.key} must be one of the documented choice labels or indices.`,
      { choices: parameter.choices ?? {} },
    );
  }
  if (parameter.type === 'color' || parameter.type === 'point') {
    if (
      !Array.isArray(value) ||
      value.length !== parameter.span ||
      value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
    ) {
      throw new GmicError(
        'INVALID_PARAMETER',
        `${parameter.key} must be an array of ${parameter.span} numbers.`,
      );
    }
    if (
      parameter.type === 'color' &&
      value.some((item) => Number(item) < 0 || Number(item) > 255)
    ) {
      throw new GmicError(
        'VALUE_OUT_OF_RANGE',
        `${parameter.key} color components must be in 0..255.`,
      );
    }
    return value.map(String);
  }
  if (parameter.type === 'value') return parameter.nativeDefault;
  throw new GmicError(
    'UNSUPPORTED_PARAMETER',
    `${parameter.key} cannot be safely serialized by structured execution.`,
  );
}

export function compileOperation(
  operation: Operation,
  step: OperationStep,
): {
  command: string;
  arguments?: string;
  selection?: string;
  copy: boolean;
  resolvedParameters?: Record<string, unknown>;
} {
  if (!operation.structured)
    throw new GmicError(
      operation.interactive ? 'INTERACTIVE_OPERATION_BLOCKED' : 'RAW_ONLY_OPERATION',
      operation.interactive
        ? `${operation.title} is interactive and cannot run through structured MCP execution.`
        : `${operation.title} requires gmic_run_trusted_code.`,
    );
  if (operation.kind === 'command') {
    if (step.parameters)
      throw new GmicError('INVALID_PARAMETER', 'CLI commands use arguments, not named parameters.');
    return {
      command: operation.command,
      ...(step.arguments !== undefined ? { arguments: step.arguments } : {}),
      ...(step.selection !== undefined ? { selection: step.selection } : {}),
      copy: step.copy,
    };
  }
  if (step.arguments !== undefined)
    throw new GmicError(
      'INVALID_PARAMETER',
      'Filters use named parameters, not positional arguments.',
    );
  const parameters = operation.parameters ?? [];
  const overrides = step.parameters ?? {};
  const known = new Set(
    parameters.filter((parameter) => parameter.exposed).map((parameter) => parameter.key),
  );
  const unknown = Object.keys(overrides).filter((key) => !known.has(key));
  if (unknown.length)
    throw new GmicError(
      'UNKNOWN_PARAMETER',
      `Unknown parameters for ${operation.operationId}: ${unknown.join(', ')}.`,
      { known_parameters: [...known] },
    );
  const max = parameters.reduce(
    (value, parameter) => Math.max(value, parameter.position + parameter.span - 1),
    0,
  );
  const args = Array<string>(max).fill('');
  const resolved: Record<string, unknown> = {};
  for (const parameter of parameters) {
    const value =
      parameter.exposed && Object.hasOwn(overrides, parameter.key)
        ? overrides[parameter.key]
        : parameter.defaultValue;
    const native = parameter.exposed
      ? serializeParameter(parameter, value)
      : parameter.nativeDefault;
    native.forEach((item, index) => {
      args[parameter.position - 1 + index] = item;
    });
    if (parameter.exposed) resolved[parameter.key] = value;
  }
  return {
    command: operation.command,
    arguments: args.join(','),
    ...(step.selection !== undefined ? { selection: step.selection } : {}),
    copy: step.copy,
    resolvedParameters: resolved,
  };
}
