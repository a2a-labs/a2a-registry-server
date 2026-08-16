/**
 * Custom error class for errors originating from the A2A Registry Server.
 * Encapsulates an HTTP status code, machine-readable error code string, message, and optional detail payload.
 */
export class RegistryError extends Error {
  /**
   * Create a new RegistryError.
   * @param status - HTTP status code associated with this error (e.g., 400, 401, 404, 500).
   * @param code - Unique machine-readable error code slug (e.g. "invalid_request", "agent_not_found").
   * @param message - Human-readable error description.
   * @param details - Optional additional context or underlying error cause object.
   */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Type guard to determine if a caught error is an instance of RegistryError.
 * @param error - The unknown value to check.
 * @returns True if error is a RegistryError.
 */
export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}

