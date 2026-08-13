import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RegistryConfig } from "./config.js";
import { isRegistryError, RegistryError } from "./errors.js";
import { RegistryService } from "./service.js";
import { parseAgentQuery, parseRegistration, validateId, validateInstanceId } from "./validation.js";

const API_VERSION = "v1";

interface RequestContext {
  requestId: string;
  startedAt: number;
}

class Metrics {
  requests = 0;
  errors = 0;
  registrations = 0;
  heartbeats = 0;
  unregistrations = 0;

  render(storeName: string): string {
    return [
      "# HELP a2a_registry_http_requests_total Total HTTP requests.",
      "# TYPE a2a_registry_http_requests_total counter",
      `a2a_registry_http_requests_total ${this.requests}`,
      "# HELP a2a_registry_http_errors_total Total HTTP responses with status >= 400.",
      "# TYPE a2a_registry_http_errors_total counter",
      `a2a_registry_http_errors_total ${this.errors}`,
      "# HELP a2a_registry_registrations_total Successful registrations and updates.",
      "# TYPE a2a_registry_registrations_total counter",
      `a2a_registry_registrations_total ${this.registrations}`,
      "# HELP a2a_registry_heartbeats_total Successful lease renewals.",
      "# TYPE a2a_registry_heartbeats_total counter",
      `a2a_registry_heartbeats_total ${this.heartbeats}`,
      "# HELP a2a_registry_unregistrations_total Successful unregistrations.",
      "# TYPE a2a_registry_unregistrations_total counter",
      `a2a_registry_unregistrations_total ${this.unregistrations}`,
      `a2a_registry_store_info{store="${storeName}"} 1`,
      "",
    ].join("\n");
  }
}

function constantEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new RegistryError(413, "body_too_large", `Request body exceeds ${maximumBytes} bytes`);
    chunks.push(buffer);
  }
  if (bytes === 0) throw new RegistryError(400, "invalid_json", "A JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RegistryError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function setCommonHeaders(res: ServerResponse, config: RegistryConfig, requestId: string): void {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match, X-Registry-Lease-Token, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "ETag, X-Registry-Revision, X-Request-Id");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Request-Id", requestId);
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function leaseToken(req: IncomingMessage): string | undefined {
  const value = req.headers["x-registry-lease-token"];
  return Array.isArray(value) ? value[0] : value;
}

function pathId(pathname: string, suffix = ""): string | undefined {
  const expression = suffix
    ? new RegExp(`^/v1/(?:registry/)?agents/([^/]+)/${suffix}$`)
    : /^\/v1\/(?:registry\/)?agents\/([^/]+)$/;
  const match = expression.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return validateId(decodeURIComponent(match[1]));
  } catch (error) {
    if (error instanceof URIError) throw new RegistryError(400, "invalid_request", "Agent ID is not valid URL encoding");
    throw error;
  }
}

function instancePath(pathname: string, suffix = ""): { id: string; instanceId: string } | undefined {
  const expression = suffix
    ? new RegExp(`^/v1/agents/([^/]+)/instances/([^/]+)/${suffix}$`)
    : /^\/v1\/agents\/([^/]+)\/instances\/([^/]+)$/;
  const match = expression.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return {
      id: validateId(decodeURIComponent(match[1])),
      instanceId: validateInstanceId(decodeURIComponent(match[2])),
    };
  } catch (error) {
    if (error instanceof URIError) throw new RegistryError(400, "invalid_request", "Agent or instance ID is not valid URL encoding");
    throw error;
  }
}

function instanceCollectionId(pathname: string): string | undefined {
  const match = /^\/v1\/agents\/([^/]+)\/instances$/.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return validateId(decodeURIComponent(match[1]));
  } catch (error) {
    if (error instanceof URIError) throw new RegistryError(400, "invalid_request", "Agent ID is not valid URL encoding");
    throw error;
  }
}

function isListPath(pathname: string): boolean {
  return pathname === "/v1/agents" || pathname === "/v1/registry/agents" || pathname === "/v1/registry";
}

function isRegisterPath(pathname: string): boolean {
  return pathname === "/v1/agents" || pathname === "/v1/registry/register" || pathname === "/v1/registry";
}

export function createRegistryHttpServer(service: RegistryService, config: RegistryConfig): Server {
  const metrics = new Metrics();
  return createServer(async (req, res) => {
    const context: RequestContext = {
      requestId: (Array.isArray(req.headers["x-request-id"]) ? req.headers["x-request-id"][0] : req.headers["x-request-id"]) ?? crypto.randomUUID(),
      startedAt: Date.now(),
    };
    metrics.requests += 1;
    setCommonHeaders(res, config, context.requestId);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", config.publicUrl);
      const privileged = config.writeToken !== undefined && bearer(req) !== undefined &&
        constantEquals(bearer(req) as string, config.writeToken);

      if (req.method === "GET" && url.pathname === "/") {
        json(res, 200, {
          name: "A2A Registry Server",
          apiVersion: API_VERSION,
          documentation: `${config.publicUrl.replace(/\/$/, "")}/openapi.yaml`,
          endpoints: { agents: "/v1/agents", liveness: "/health/live", readiness: "/health/ready", metrics: "/metrics" },
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/openapi.yaml") {
        const body = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");
        res.writeHead(200, { "Content-Type": "application/yaml; charset=utf-8" });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health/live") {
        json(res, 200, { status: "ok", service: "a2a-registry" });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/health/ready" || url.pathname === "/health")) {
        const ready = await service.ready();
        json(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", store: service.storeName });
        return;
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        const body = metrics.render(service.storeName);
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(body);
        return;
      }

      if (req.method === "POST" && isRegisterPath(url.pathname)) {
        if (config.writeToken && !privileged) {
          throw new RegistryError(401, "write_auth_required", "A valid bearer token is required to register a new agent");
        }
        const input = parseRegistration(await readJson(req, config.maxBodyBytes));
        const result = await service.register(input, leaseToken(req), privileged);
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, {
          Location: result.instance.instanceId === "default"
            ? `/v1/agents/${encodeURIComponent(result.agent.id)}`
            : `/v1/agents/${encodeURIComponent(result.agent.id)}/instances/${encodeURIComponent(result.instance.instanceId)}`,
          "Cache-Control": "no-store",
        });
        return;
      }

      const instanceHeartbeat = instancePath(url.pathname, "heartbeat");
      if (req.method === "POST" && instanceHeartbeat) {
        const result = await service.heartbeatInstance(
          instanceHeartbeat.id, instanceHeartbeat.instanceId, leaseToken(req), privileged,
        );
        metrics.heartbeats += 1;
        json(res, 200, { status: "heartbeat_acknowledged", ...result }, { "Cache-Control": "no-store" });
        return;
      }

      const heartbeatId = pathId(url.pathname, "heartbeat");
      if (req.method === "POST" && heartbeatId) {
        const agent = await service.heartbeat(heartbeatId, leaseToken(req), privileged);
        metrics.heartbeats += 1;
        json(res, 200, { status: "heartbeat_acknowledged", agent }, { "Cache-Control": "no-store" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/registry/heartbeat") {
        const body = await readJson(req, config.maxBodyBytes) as { id?: unknown; leaseToken?: unknown };
        const id = validateId(body.id);
        const token = leaseToken(req) ?? (typeof body.leaseToken === "string" ? body.leaseToken : undefined);
        const agent = await service.heartbeat(id, token, privileged);
        metrics.heartbeats += 1;
        json(res, 200, { status: "heartbeat_acknowledged", agent }, { "Cache-Control": "no-store" });
        return;
      }

      if (req.method === "GET" && isListPath(url.pathname)) {
        const page = await service.list(parseAgentQuery(url));
        const etag = `W/\"registry-${page.revision}\"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag, "X-Registry-Revision": String(page.revision) });
          res.end();
          return;
        }
        json(res, 200, page, {
          ETag: etag,
          "X-Registry-Revision": String(page.revision),
          "Cache-Control": "public, max-age=5, must-revalidate",
        });
        return;
      }

      const instancesId = instanceCollectionId(url.pathname);
      if (req.method === "POST" && instancesId) {
        if (config.writeToken && !privileged) {
          throw new RegistryError(401, "write_auth_required", "A valid bearer token is required to register a new agent instance");
        }
        const raw = await readJson(req, config.maxBodyBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RegistryError(400, "invalid_request", "Request body must be an object");
        }
        const input = parseRegistration({ ...raw, id: instancesId });
        if (!input.instanceId) throw new RegistryError(400, "invalid_request", "instanceId is required");
        const result = await service.register(input, leaseToken(req), privileged);
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, {
          Location: `/v1/agents/${encodeURIComponent(instancesId)}/instances/${encodeURIComponent(result.instance.instanceId)}`,
          "Cache-Control": "no-store",
        });
        return;
      }
      if (req.method === "GET" && instancesId) {
        const instances = await service.listInstances(instancesId);
        json(res, 200, { instances, total: instances.length }, { "Cache-Control": "public, max-age=5, must-revalidate" });
        return;
      }

      const instanceRoute = instancePath(url.pathname);
      if (req.method === "GET" && instanceRoute) {
        const instance = await service.getInstance(instanceRoute.id, instanceRoute.instanceId);
        const etag = `W/\"agent-instance-${instanceRoute.id}-${instance.instanceId}-${instance.revision}\"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        json(res, 200, { instance }, { ETag: etag, "Cache-Control": "public, max-age=5, must-revalidate" });
        return;
      }
      if (req.method === "PUT" && instanceRoute) {
        const raw = await readJson(req, config.maxBodyBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RegistryError(400, "invalid_request", "Request body must be an object");
        }
        const input = parseRegistration({ ...raw, id: instanceRoute.id, instanceId: instanceRoute.instanceId });
        const result = await service.register(
          input, leaseToken(req), privileged, config.writeToken === undefined || privileged,
        );
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, { Location: url.pathname, "Cache-Control": "no-store" });
        return;
      }
      if (req.method === "DELETE" && instanceRoute) {
        await service.unregisterInstance(instanceRoute.id, instanceRoute.instanceId, leaseToken(req), privileged);
        metrics.unregistrations += 1;
        res.writeHead(204);
        res.end();
        return;
      }

      const id = pathId(url.pathname);
      if (req.method === "GET" && id) {
        const agent = await service.get(id);
        const etag = `W/\"agent-${agent.id}-${agent.revision}\"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        json(res, 200, { agent }, { ETag: etag, "Cache-Control": "public, max-age=5, must-revalidate" });
        return;
      }

      if (req.method === "PUT" && id) {
        const raw = await readJson(req, config.maxBodyBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RegistryError(400, "invalid_request", "Request body must be an object");
        const input = parseRegistration({ ...raw, id });
        const result = await service.register(input, leaseToken(req), privileged, config.writeToken === undefined || privileged);
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, { Location: `/v1/agents/${encodeURIComponent(id)}`, "Cache-Control": "no-store" });
        return;
      }

      if (req.method === "DELETE" && id) {
        await service.unregister(id, leaseToken(req), privileged);
        metrics.unregistrations += 1;
        res.writeHead(204);
        res.end();
        return;
      }

      throw new RegistryError(404, "route_not_found", "Route not found");
    } catch (error) {
      metrics.errors += 1;
      const registryError = isRegistryError(error)
        ? error
        : new RegistryError(500, "internal_error", "An unexpected error occurred");
      json(res, registryError.status, {
        type: `https://a2a-registry.dev/problems/${registryError.code}`,
        title: registryError.code,
        status: registryError.status,
        detail: registryError.message,
        requestId: context.requestId,
      }, { "Cache-Control": "no-store" });
      if (!isRegistryError(error)) {
        console.error(JSON.stringify({ level: "error", requestId: context.requestId, error: error instanceof Error ? error.stack : String(error) }));
      }
    } finally {
      console.log(JSON.stringify({
        level: "info",
        requestId: context.requestId,
        method: req.method,
        path: req.url,
        status: res.statusCode,
        durationMs: Date.now() - context.startedAt,
      }));
    }
  });
}
