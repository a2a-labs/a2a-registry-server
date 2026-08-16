import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RegistryError } from "./errors.js";
import type {
  AgentInstance,
  AgentPage,
  AgentQuery,
  Clock,
  JsonObject,
  RegisteredAgent,
  RegistrationInput,
  RegistryStore,
  StoredAgent,
} from "./types.js";

/** Default wall-clock implementation using Date.now(). */
const systemClock: Clock = { now: () => Date.now() };

/** Default instance identifier used when an explicit instanceId is not specified. */
export const DEFAULT_INSTANCE_ID = "default";

/** Generate a SHA-256 hash string for a secret lease token. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compare a candidate lease token against a stored SHA-256 token hash using constant-time comparison
 * to prevent timing side-channel attacks.
 */
function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Strip internal storage fields (lease token hashes, backend IDs) to return a public AgentInstance object. */
function publicInstance(agent: StoredAgent): AgentInstance {
  const {
    id: _, name: __, agentCard: ___, leaseTokenHash: ____, backendLeaseId: _____,
    backendRevision: ______, ...result
  } = agent;
  return result;
}

/**
 * Aggregate multiple stored instance records sharing the same logical agent ID into a unified
 * public `RegisteredAgent` representation with instance list and aggregated status fields.
 */
function logicalAgent(records: StoredAgent[]): RegisteredAgent {
  if (records.length === 0) throw new Error("Cannot build a logical agent without an active instance");
  const sorted = [...records].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const primary = sorted.find((record) => record.instanceId === DEFAULT_INSTANCE_ID) ?? sorted[0]!;
  const instances = sorted.map(publicInstance);
  return {
    id: primary.id,
    name: primary.name,
    agentCard: primary.agentCard,
    instances,
    instanceCount: instances.length,
    endpoint: primary.endpoint,
    ttlSeconds: primary.ttlSeconds,
    registeredAt: sorted.reduce((earliest, record) => record.registeredAt < earliest ? record.registeredAt : earliest, primary.registeredAt),
    updatedAt: sorted.reduce((latest, record) => record.updatedAt > latest ? record.updatedAt : latest, primary.updatedAt),
    lastSeen: sorted.reduce((latest, record) => record.lastSeen > latest ? record.lastSeen : latest, primary.lastSeen),
    expiresAt: sorted.reduce((latest, record) => record.expiresAt > latest ? record.expiresAt : latest, primary.expiresAt),
    metadata: primary.metadata,
    revision: Math.max(...sorted.map((record) => record.revision)),
  };
}

/** Helper function to convert unknown values to lowercase string. */
function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Test whether a logical agent matches the filter criteria specified in an AgentQuery object.
 * Checks name substring, skill IDs/names/tags, capability flags, and protocol bindings.
 */
function matches(agent: RegisteredAgent, query: AgentQuery): boolean {
  const card = agent.agentCard as unknown as JsonObject;
  if (query.name && !agent.name.toLowerCase().includes(query.name.toLowerCase())) return false;

  const skills = Array.isArray(card.skills) ? card.skills : [];
  if (query.skill) {
    const needle = query.skill.toLowerCase();
    const matched = skills.some((value) => {
      if (!value || typeof value !== "object") return false;
      const skill = value as JsonObject;
      return lower(skill.id) === needle || lower(skill.name).includes(needle) ||
        (Array.isArray(skill.tags) && skill.tags.some((tag) => lower(tag) === needle));
    });
    if (!matched) return false;
  }

  if (query.tag) {
    const needle = query.tag.toLowerCase();
    const matched = skills.some((value) => value && typeof value === "object" &&
      Array.isArray((value as JsonObject).tags) &&
      ((value as JsonObject).tags as unknown[]).some((tag) => lower(tag) === needle));
    if (!matched) return false;
  }

  if (query.capability) {
    const aliases: Record<string, string> = { push: "pushNotifications" };
    const requested = aliases[query.capability.toLowerCase()] ?? query.capability;
    const capabilities = card.capabilities && typeof card.capabilities === "object"
      ? card.capabilities as JsonObject
      : {};
    const key = Object.keys(capabilities).find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
    if (!key || capabilities[key] !== true) return false;
  }

  if (query.protocolBinding) {
    const needle = query.protocolBinding.toLowerCase();
    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
    const matched = interfaces.some((value) => value && typeof value === "object" &&
      lower((value as JsonObject).protocolBinding) === needle);
    if (!matched) return false;
  }
  return true;
}

/** Encode an agent ID into a URL-safe base64 string for use as a pagination cursor. */
function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/** Decode a base64url pagination cursor string back into an agent ID. */
function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new RegistryError(400, "invalid_cursor", "cursor is invalid");
  }
}

/** Return result structure from an agent registration operation. */
export interface RegisterResult {
  /** Aggregated logical agent state after registration. */
  agent: RegisteredAgent;
  /** Public representation of the registered instance. */
  instance: AgentInstance;
  /** Flag indicating whether a new instance record was created. */
  created: boolean;
  /** Secret lease token returned only upon initial creation of a new instance. */
  leaseToken?: string;
}

/**
 * Core business service for managing agent registrations, heartbeats, discovery queries,
 * and instance lifecycles across backing store implementations.
 */
export class RegistryService {
  readonly #store: RegistryStore;
  readonly #clock: Clock;
  readonly #defaultTtl: number;
  readonly #minTtl: number;
  readonly #maxTtl: number;
  #revision: number;

  /**
   * Create a new RegistryService instance.
   * @param store - Backend storage adapter (e.g. MemoryRegistryStore or EtcdRegistryStore).
   * @param options - Configuration options for default/min/max TTL settings and optional clock.
   */
  constructor(store: RegistryStore, options: {
    defaultTtlSeconds: number;
    minTtlSeconds: number;
    maxTtlSeconds: number;
    clock?: Clock;
  }) {
    this.#store = store;
    this.#clock = options.clock ?? systemClock;
    this.#defaultTtl = options.defaultTtlSeconds;
    this.#minTtl = options.minTtlSeconds;
    this.#maxTtl = options.maxTtlSeconds;
    this.#revision = this.#clock.now();
  }

  /** Return the name of the underlying storage backend. */
  get storeName(): string {
    return this.#store.name;
  }

  /** Start the service and underlying store. */
  async start(): Promise<void> {
    await this.#store.start();
  }

  /** Stop the service and clean up store resources. */
  async stop(): Promise<void> {
    await this.#store.stop();
  }

  /** Check if the underlying store is healthy and operational. */
  async ready(): Promise<boolean> {
    return this.#store.ready();
  }

  /**
   * Register or update an agent instance lease.
   * Validates bearer write tokens for creation, checks lease token ownership for updates,
   * enforces identical Agent Cards across all active instances of an agent ID, and saves the record.
   */
  async register(
    input: RegistrationInput,
    leaseToken?: string,
    privileged = false,
    creationAuthorized = true,
  ): Promise<RegisterResult> {
    const instanceId = input.instanceId ?? await this.#generateInstanceId(input.id);
    const existing = await this.#store.get(input.id, instanceId);
    if (!existing && !creationAuthorized) {
      throw new RegistryError(401, "write_auth_required", "A valid bearer token is required to register a new agent instance");
    }
    if (existing && !privileged) this.assertOwner(existing, leaseToken);

    const siblings = (await this.#store.list()).filter((agent) => agent.id === input.id && agent.instanceId !== instanceId);
    const sharedCard = siblings[0]?.agentCard;
    if (sharedCard && !isDeepStrictEqual(sharedCard, input.agentCard)) {
      throw new RegistryError(409, "agent_card_mismatch", `All active instances of agent '${input.id}' must publish the same Agent Card`);
    }

    const ttlSeconds = input.ttlSeconds ?? this.#defaultTtl;
    if (ttlSeconds < this.#minTtl || ttlSeconds > this.#maxTtl) {
      throw new RegistryError(400, "invalid_ttl", `ttlSeconds must be between ${this.#minTtl} and ${this.#maxTtl}`);
    }

    const nowMs = this.#clock.now();
    const now = new Date(nowMs).toISOString();
    const generatedToken = existing ? undefined : randomBytes(32).toString("base64url");
    const card = input.agentCard as unknown as JsonObject;
    const agent: StoredAgent = {
      id: input.id,
      instanceId,
      name: typeof card.name === "string" ? card.name : input.id,
      endpoint: input.endpoint ?? "",
      agentCard: input.agentCard,
      ttlSeconds,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
      lastSeen: now,
      expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      metadata: input.metadata ?? existing?.metadata ?? {},
      revision: this.nextRevision(),
      leaseTokenHash: existing?.leaseTokenHash ?? hashToken(generatedToken as string),
      ...(existing?.backendLeaseId === undefined ? {} : { backendLeaseId: existing.backendLeaseId }),
      ...(existing?.backendRevision === undefined ? {} : { backendRevision: existing.backendRevision }),
    };
    await this.#store.put(agent);
    const aggregate = logicalAgent([...siblings, agent]);
    return {
      agent: aggregate,
      instance: publicInstance(agent),
      created: existing === undefined,
      ...(generatedToken === undefined ? {} : { leaseToken: generatedToken }),
    };
  }

  /** Renew an agent lease targeting a default or inferred instance ID (compatibility route). */
  async heartbeat(
    id: string,
    leaseToken?: string,
    privileged = false,
  ): Promise<RegisteredAgent> {
    const instanceId = await this.#compatibilityInstanceId(id, leaseToken, privileged);
    return (await this.heartbeatInstance(id, instanceId, leaseToken, privileged)).agent;
  }

  /** Renew an agent instance lease by resetting its TTL timer. */
  async heartbeatInstance(
    id: string,
    instanceId: string,
    leaseToken?: string,
    privileged = false,
  ): Promise<{ agent: RegisteredAgent; instance: AgentInstance }> {
    const agent = await this.#requiredInstance(id, instanceId);
    if (!privileged) this.assertOwner(agent, leaseToken);
    const nowMs = this.#clock.now();
    const now = new Date(nowMs).toISOString();
    agent.lastSeen = now;
    agent.updatedAt = now;
    agent.expiresAt = new Date(nowMs + agent.ttlSeconds * 1000).toISOString();
    agent.revision = this.nextRevision();
    await this.#store.renew(agent);
    const records = (await this.#store.list()).filter((candidate) => candidate.id === id);
    return { agent: logicalAgent(records), instance: publicInstance(agent) };
  }

  /** Retrieve an aggregated logical agent by ID. Throws 404 if not found or expired. */
  async get(id: string): Promise<RegisteredAgent> {
    const records = (await this.#store.list()).filter((agent) => agent.id === id);
    if (records.length === 0) throw this.notFound(id);
    return logicalAgent(records);
  }

  /** Retrieve a specific agent instance by agent ID and instance ID. */
  async getInstance(id: string, instanceId: string): Promise<AgentInstance> {
    return publicInstance(await this.#requiredInstance(id, instanceId));
  }

  /** List all active public instances for a given logical agent ID. */
  async listInstances(id: string): Promise<AgentInstance[]> {
    const records = (await this.#store.list()).filter((agent) => agent.id === id)
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    if (records.length === 0) throw this.notFound(id);
    return records.map(publicInstance);
  }

  /** Query and filter registered agents with pagination support. */
  async list(query: AgentQuery): Promise<AgentPage> {
    const grouped = new Map<string, StoredAgent[]>();
    for (const instance of await this.#store.list()) {
      const records = grouped.get(instance.id) ?? [];
      records.push(instance);
      grouped.set(instance.id, records);
    }
    const all = [...grouped.values()].map(logicalAgent).filter((agent) => matches(agent, query))
      .sort((a, b) => a.id.localeCompare(b.id));
    const startAfter = query.cursor ? decodeCursor(query.cursor) : undefined;
    const start = startAfter ? all.findIndex((agent) => agent.id > startAfter) : 0;
    const offset = start < 0 ? all.length : start;
    const selected = all.slice(offset, offset + query.limit);
    const hasMore = offset + selected.length < all.length;
    return {
      agents: selected,
      total: all.length,
      revision: Math.max(this.#revision, ...all.map((agent) => agent.revision)),
      ...(hasMore && selected.length > 0 ? { nextCursor: encodeCursor(selected[selected.length - 1]!.id) } : {}),
    };
  }

  /** Unregister an agent using compatibility route resolution for default/inferred instance. */
  async unregister(
    id: string,
    leaseToken?: string,
    privileged = false,
  ): Promise<void> {
    const instanceId = await this.#compatibilityInstanceId(id, leaseToken, privileged);
    await this.unregisterInstance(id, instanceId, leaseToken, privileged);
  }

  /** Unregister and remove a specific agent instance lease from the store. */
  async unregisterInstance(
    id: string,
    instanceId: string,
    leaseToken?: string,
    privileged = false,
  ): Promise<void> {
    const agent = await this.#requiredInstance(id, instanceId);
    if (!privileged) this.assertOwner(agent, leaseToken);
    await this.#store.delete(agent);
    this.nextRevision();
  }

  /** Internal helper to fetch a required stored instance or throw a 404 RegistryError. */
  async #requiredInstance(id: string, instanceId: string): Promise<StoredAgent> {
    const agent = await this.#store.get(id, instanceId);
    if (!agent) {
      throw new RegistryError(404, "agent_instance_not_found", `Instance '${instanceId}' of agent '${id}' was not found or its lease expired`);
    }
    return agent;
  }

  /** Construct a 404 agent_not_found RegistryError. */
  private notFound(id: string): RegistryError {
    return new RegistryError(404, "agent_not_found", `Agent '${id}' was not found or every instance lease expired`);
  }

  /** Generate a unique UUID for a new instance, verifying non-collision with the store. */
  async #generateInstanceId(id: string): Promise<string> {
    // UUID collisions are extraordinarily unlikely, but checking the store
    // keeps the generated identifier unique even if a caller supplies a
    // previously generated value through a custom store or test clock.
    let instanceId: string;
    do {
      instanceId = randomUUID();
    } while (await this.#store.get(id, instanceId));
    return instanceId;
  }

  /**
   * Resolve the old agent-level heartbeat/unregister routes. Explicitly named
   * instances should use the instance routes; these compatibility routes can
   * still target an existing `default` record, the lease-token owner, or the
   * only active instance. Multiple generated instances are intentionally
   * rejected without an instance ID to avoid acting on the wrong lease.
   */
  async #compatibilityInstanceId(
    id: string,
    leaseToken?: string,
    privileged = false,
  ): Promise<string> {
    const records = (await this.#store.list())
      .filter((agent) => agent.id === id)
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    if (records.length === 0) throw this.notFound(id);

    if (leaseToken) {
      const owned = records.find((record) => tokenMatches(leaseToken, record.leaseTokenHash));
      if (owned) return owned.instanceId;
      throw new RegistryError(401, "invalid_lease_token", "A valid X-Registry-Lease-Token is required for this agent");
    }

    const defaultRecord = records.find((record) => record.instanceId === DEFAULT_INSTANCE_ID);
    if (defaultRecord) return defaultRecord.instanceId;

    if (records.length === 1) return records[0]!.instanceId;
    if (privileged) return records[0]!.instanceId;
    throw new RegistryError(409, "instance_id_required", `Agent '${id}' has multiple active instances; specify instanceId`);
  }

  /** Verify that the supplied leaseToken matches the stored agent's leaseTokenHash. */
  private assertOwner(agent: StoredAgent, leaseToken?: string): void {
    if (!leaseToken || !tokenMatches(leaseToken, agent.leaseTokenHash)) {
      throw new RegistryError(401, "invalid_lease_token", "A valid X-Registry-Lease-Token is required for this agent");
    }
  }

  /** Increment and return the monotonically increasing revision counter. */
  private nextRevision(): number {
    this.#revision += 1;
    return this.#revision;
  }
}

