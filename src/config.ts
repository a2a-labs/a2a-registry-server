import { RegistryError } from "./errors.js";

export interface RegistryConfig {
  host: string;
  port: number;
  publicUrl: string;
  store: "memory" | "etcd";
  defaultTtlSeconds: number;
  minTtlSeconds: number;
  maxTtlSeconds: number;
  pruneIntervalMs: number;
  maxBodyBytes: number;
  corsOrigin: string;
  writeToken?: string;
  etcd: {
    endpoint: string;
    prefix: string;
    username?: string;
    password?: string;
    bearerToken?: string;
  };
}

export interface RegistryConfigOverrides {
  host?: string;
  port?: number;
  publicUrl?: string;
  store?: "memory" | "etcd";
  defaultTtlSeconds?: number;
  minTtlSeconds?: number;
  maxTtlSeconds?: number;
  pruneIntervalMs?: number;
  maxBodyBytes?: number;
  corsOrigin?: string;
  writeToken?: string;
  etcd?: Partial<RegistryConfig["etcd"]>;
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  environment: NodeJS.ProcessEnv,
  override?: number,
  maximum?: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  const resolved = override ?? value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || (maximum !== undefined && resolved > maximum)) {
    const range = maximum === undefined ? `>= ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new RegistryError(500, "invalid_configuration", `${name} must be an integer ${range}`);
  }
  return resolved;
}

function optional(name: string, environment: NodeJS.ProcessEnv, override?: string): string | undefined {
  const value = override ?? environment[name];
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function url(name: string, value: string): string {
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RegistryError(500, "invalid_configuration", `${name} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RegistryError(500, "invalid_configuration", `${name} must use http or https`);
  }
  return normalized;
}

/**
 * Load server configuration from the environment and optional CLI overrides.
 * Overrides are applied last, making command-line flags take precedence over
 * both a process environment and an env file loaded by the CLI.
 */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: RegistryConfigOverrides = {},
): RegistryConfig {
  const configuredStore = overrides.store ?? environment.REGISTRY_STORE ?? "memory";
  const store = configuredStore;
  if (store !== "memory" && store !== "etcd") {
    throw new RegistryError(500, "invalid_configuration", "REGISTRY_STORE must be memory or etcd");
  }

  const port = integer("REGISTRY_PORT", Number(environment.PORT ?? 3003), 0, environment, overrides.port, 65_535);
  const minTtlSeconds = integer("REGISTRY_MIN_TTL_SECONDS", 10, 1, environment, overrides.minTtlSeconds);
  const maxTtlSeconds = integer("REGISTRY_MAX_TTL_SECONDS", 3600, minTtlSeconds, environment, overrides.maxTtlSeconds);
  const defaultTtlSeconds = integer("REGISTRY_DEFAULT_TTL_SECONDS", 60, minTtlSeconds, environment, overrides.defaultTtlSeconds);
  if (defaultTtlSeconds > maxTtlSeconds) {
    throw new RegistryError(500, "invalid_configuration", "REGISTRY_DEFAULT_TTL_SECONDS must not exceed REGISTRY_MAX_TTL_SECONDS");
  }

  const configuredHost = overrides.host ?? environment.REGISTRY_HOST ?? "0.0.0.0";
  const host = configuredHost.trim();
  if (!host) throw new RegistryError(500, "invalid_configuration", "REGISTRY_HOST must not be empty");

  const publicUrl = url(
    "REGISTRY_PUBLIC_URL",
    overrides.publicUrl ?? environment.REGISTRY_PUBLIC_URL ?? `http://localhost:${port}`,
  );
  const etcdEndpoint = url("ETCD_ENDPOINT", overrides.etcd?.endpoint ?? environment.ETCD_ENDPOINT ?? "http://localhost:2379");

  return {
    host,
    port,
    publicUrl,
    store,
    defaultTtlSeconds,
    minTtlSeconds,
    maxTtlSeconds,
    pruneIntervalMs: integer("REGISTRY_PRUNE_INTERVAL_MS", 5000, 100, environment, overrides.pruneIntervalMs),
    maxBodyBytes: integer("REGISTRY_MAX_BODY_BYTES", 1024 * 1024, 1024, environment, overrides.maxBodyBytes),
    corsOrigin: (overrides.corsOrigin ?? environment.REGISTRY_CORS_ORIGIN ?? "*").trim() || "*",
    writeToken: optional("REGISTRY_WRITE_TOKEN", environment, overrides.writeToken),
    etcd: {
      endpoint: etcdEndpoint,
      prefix: (overrides.etcd?.prefix ?? environment.ETCD_PREFIX ?? "/a2a-registry/agents/").trim() || "/a2a-registry/agents/",
      username: optional("ETCD_USERNAME", environment, overrides.etcd?.username),
      password: optional("ETCD_PASSWORD", environment, overrides.etcd?.password),
      bearerToken: optional("ETCD_BEARER_TOKEN", environment, overrides.etcd?.bearerToken),
    },
  };
}
