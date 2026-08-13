import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { AgentCard } from "@a2a-js/sdk";
import { createRegistryHttpServer } from "../src/http.js";
import type { RegistryConfig } from "../src/config.js";
import { RegistryService } from "../src/service.js";
import { MemoryRegistryStore } from "../src/store/memory.js";

const card = {
  name: "Weather Agent",
  description: "Returns forecasts",
  version: "1.0.0",
  supportedInterfaces: [{ url: "https://weather.example/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["application/json"],
  skills: [{ id: "forecast", name: "Weather forecast", description: "Forecast by city", tags: ["weather"] }],
} as unknown as AgentCard;

describe("registry HTTP API", () => {
  const store = new MemoryRegistryStore(1000);
  const service = new RegistryService(store, { defaultTtlSeconds: 60, minTtlSeconds: 1, maxTtlSeconds: 3600 });
  const config: RegistryConfig = {
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    store: "memory",
    defaultTtlSeconds: 60,
    minTtlSeconds: 1,
    maxTtlSeconds: 3600,
    pruneIntervalMs: 1000,
    maxBodyBytes: 1024 * 1024,
    corsOrigin: "*",
    etcd: { endpoint: "http://localhost:2379", prefix: "/test/" },
  };
  const server = createRegistryHttpServer(service, config);
  let baseUrl: string;

  before(async () => {
    await service.start();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await service.stop();
  });

  it("registers, discovers, renews, and unregisters an Agent Card", async () => {
    const registration = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "weather-1", agentCard: card, ttlSeconds: 30, metadata: { region: "eu-west" } }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as { leaseToken: string; agent: { endpoint: string } };
    assert.ok(registered.leaseToken);
    assert.equal(registered.agent.endpoint, "https://weather.example/a2a");

    const discovery = await fetch(`${baseUrl}/v1/agents?skill=forecast&capability=streaming&tag=weather`);
    assert.equal(discovery.status, 200);
    const page = await discovery.json() as { total: number; agents: Array<{ id: string }> };
    assert.equal(page.total, 1);
    assert.equal(page.agents[0]?.id, "weather-1");
    assert.ok(discovery.headers.get("etag"));

    const rejected = await fetch(`${baseUrl}/v1/agents/weather-1/heartbeat`, { method: "POST" });
    assert.equal(rejected.status, 401);

    const heartbeat = await fetch(`${baseUrl}/v1/agents/weather-1/heartbeat`, {
      method: "POST",
      headers: { "x-registry-lease-token": registered.leaseToken },
    });
    assert.equal(heartbeat.status, 200);

    const removed = await fetch(`${baseUrl}/v1/agents/weather-1`, {
      method: "DELETE",
      headers: { "x-registry-lease-token": registered.leaseToken },
    });
    assert.equal(removed.status, 204);
    assert.equal((await fetch(`${baseUrl}/v1/agents/weather-1`)).status, 404);
  });

  it("supports the PoC registration and heartbeat aliases", async () => {
    const response = await fetch(`${baseUrl}/v1/registry/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "legacy-1", endpoint: "https://legacy.example/a2a", agentCard: card, ttlMs: 10_000 }),
    });
    assert.equal(response.status, 201);
    const { leaseToken } = await response.json() as { leaseToken: string };
    const heartbeat = await fetch(`${baseUrl}/v1/registry/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "legacy-1", leaseToken }),
    });
    assert.equal(heartbeat.status, 200);
  });

  it("serves its OpenAPI contract and honors discovery ETags", async () => {
    const contract = await fetch(`${baseUrl}/openapi.yaml`);
    assert.equal(contract.status, 200);
    assert.match(await contract.text(), /title: A2A Registry API/);

    const first = await fetch(`${baseUrl}/v1/agents`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const cached = await fetch(`${baseUrl}/v1/agents`, { headers: { "if-none-match": etag } });
    assert.equal(cached.status, 304);
  });
});

describe("lease expiry", () => {
  it("removes an agent when its TTL elapses", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const store = new MemoryRegistryStore(1000, clock);
    const service = new RegistryService(store, { defaultTtlSeconds: 10, minTtlSeconds: 1, maxTtlSeconds: 60, clock });
    await service.start();
    await service.register({ id: "expiring", endpoint: "https://example.test/a2a", agentCard: card, ttlSeconds: 2 });
    now += 2001;
    await assert.rejects(() => service.get("expiring"), (error: unknown) =>
      error instanceof Error && error.message.includes("lease expired"));
    await service.stop();
  });

  it("does not let an unauthenticated caller bypass protected enrollment", async () => {
    const store = new MemoryRegistryStore();
    const service = new RegistryService(store, { defaultTtlSeconds: 10, minTtlSeconds: 1, maxTtlSeconds: 60 });
    await assert.rejects(
      () => service.register({ id: "blocked", endpoint: "https://example.test/a2a", agentCard: card }, undefined, false, false),
      (error: unknown) => error instanceof Error && error.message.includes("bearer token"),
    );
  });
});
