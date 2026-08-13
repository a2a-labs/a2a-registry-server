export class RegistryError extends Error {
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

export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}
