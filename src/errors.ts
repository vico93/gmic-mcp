export class GmicError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GmicError';
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export function abortError(signal: AbortSignal): GmicError {
  return signal.reason instanceof GmicError
    ? signal.reason
    : new GmicError('CANCELLED', 'The operation was cancelled.');
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof GmicError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'IO_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
