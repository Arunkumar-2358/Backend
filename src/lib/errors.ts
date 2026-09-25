export class GateError extends Error {
  constructor(public readonly failures: string[]) {
    super(`Gate not met: ${failures.join("; ")}`);
    this.name = "GateError";
  }
}

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
