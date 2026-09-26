import type { ApiErrorCode } from "@contracts";

/** An error that maps straight to an HTTP status, for cases the domain errors do not cover. */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Sign in required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export const notFound = (message = "Not found") => new HttpError(404, "NOT_FOUND", message);
