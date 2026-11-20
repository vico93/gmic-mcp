import type { Step } from '../schemas.js';
import type { StagedInput, StagedOutput } from './workspace.js';
import { GmicError } from '../errors.js';

export interface ImageMetadata {
  index: number;
  width: number;
  height: number;
  depth: number;
  channels: number;
  pixelCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  standardDeviation: number | null;
}

export function inputLines(inputs: StagedInput[]): string[] {
  return inputs.map((input) => `-input ${input.alias}${input.options ? `,${input.options}` : ''}`);
}

export function compileStep(step: Step): string {
  // A prefixed '-' shortcut would become deprecated '--' get-mode syntax.
  const command = step.command === '-' ? 'sub' : step.command === '-3d' ? 'sub3d' : step.command;
  const selection = step.selection === undefined ? '' : `[${step.selection}]`;
  // The comma is G'MIC's explicit empty-argument delimiter. Without it, a
  // custom command with optional arguments may consume the next pipeline item.
  const args = step.arguments ? ` ${step.arguments}` : ' ,';
  return `${step.copy ? '+' : '-'}${command}${selection}${args}`;
}

export function outputLines(outputs: StagedOutput[]): string[] {
  return outputs.map(
    (output) =>
      `-output${output.requested.selection === undefined ? '' : `[${output.requested.selection}]`} ${output.alias}${output.requested.options ? `,${output.requested.options}` : ''}`,
  );
}

export function metadataLines(marker: string): string[] {
  return [
    '-foreach {',
    `  +echo ${marker}:$>,{w},{h},{d},{s},{im},{iM},{ia},{iv}`,
    '}',
    `+echo ${marker}_COUNT:$!`,
  ];
}

export function commandFile(name: string, lines: string[]): string {
  const source = `${name} :\n${lines.map((line) => `  ${line}`).join('\n')}\n`;
  if (Buffer.byteLength(source) > 8_388_608)
    throw new GmicError('INPUT_TOO_LARGE', 'Compiled pipeline exceeds 8 MiB.');
  return source;
}

export function parseMetadata(text: string, marker: string): ImageMetadata[] {
  const images: ImageMetadata[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${marker}:`)) continue;
    const raw = line.slice(marker.length + 1).split(',');
    const fields = raw.map(Number);
    if (
      fields.length !== 9 ||
      raw.some((value) => !value.trim()) ||
      fields.slice(0, 5).some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new GmicError('INVALID_METADATA', "G'MIC returned malformed image metadata.");
    }
    const [index, width, height, depth, channels, min, max, mean, variance] = fields as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const finite = (value: number) => (Number.isFinite(value) ? value : null);
    images.push({
      index,
      width,
      height,
      depth,
      channels,
      pixelCount: width * height * depth * channels,
      min: finite(min),
      max: finite(max),
      mean: finite(mean),
      standardDeviation: finite(Math.sqrt(Math.max(0, variance))),
    });
  }
  const countLine = text.split(/\r?\n/).find((line) => line.startsWith(`${marker}_COUNT:`));
  if (countLine && Number(countLine.slice(marker.length + 7)) !== images.length) {
    throw new GmicError(
      'INVALID_METADATA',
      'Image metadata was truncated or incomplete. Increase GMIC_MCP_MAX_LOG_BYTES.',
    );
  }
  return images;
}

export function parseBitDepth(text: string, marker: string): number | null {
  const line = text.split(/\r?\n/).find((line) => line.startsWith(`${marker}:`));
  const value = line?.slice(marker.length + 1).trim();
  return value && /^(1|8|16|32|64)$/.test(value) ? Number(value) : null;
}
