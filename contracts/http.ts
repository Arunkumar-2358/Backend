/** Wire-level types shared by the API and its clients. No runtime dependencies. */

export type ApiErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "GATE" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Unmet business-rule gates (code = "GATE"). */
    failures?: string[];
    requestId?: string;
  };
}

/** Standard result for commands that only report a human-readable outcome. */
export interface MessageResult {
  message: string;
}

/**
 * Every endpoint is keyed "METHOD /path/{param}".
 * Dates travel as ISO-8601 strings and are revived to Date by the client.
 */
export interface RouteDef {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  response: unknown;
}
