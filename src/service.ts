import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RegistryError } from "./errors.js";
import type {
  AgentPage,
  AgentQuery,
  Clock,
  JsonObject,
  RegisteredAgent,
  RegistrationInput,
  RegistryStore,
  StoredAgent,
} from "./types.js";

const systemClock: Clock = { now: () => Date.now() };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicAgent(agent: StoredAgent): RegisteredAgent {
  const { leaseTokenHash: _, backendLeaseId: __, backendRevision: ___, ...result } = agent;
  return result;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function matches(agent: StoredAgent, query: AgentQuery): boolean {
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

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new RegistryError(400, "invalid_cursor", "cursor is invalid");
  }
}

export interface RegisterResult {
  agent: RegisteredAgent;
  created: boolean;
  leaseToken?: string;
}

export class RegistryService {
  readonly #store: RegistryStore;
  readonly #clock: Clock;
  readonly #defaultTtl: number;
  readonly #minTtl: number;
  readonly #maxTtl: number;
  #revision: number;

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

  get storeName(): string {
    return this.#store.name;
  }

  async start(): Promise<void> {
    await this.#store.start();
  }

  async stop(): Promise<void> {
    await this.#store.stop();
  }

  async ready(): Promise<boolean> {
    return this.#store.ready();
  }

  async register(
    input: RegistrationInput,
    leaseToken?: string,
    privileged = false,
    creationAuthorized = true,
  ): Promise<RegisterResult> {
    const existing = await this.#store.get(input.id);
    if (!existing && !creationAuthorized) {
      throw new RegistryError(401, "write_auth_required", "A valid bearer token is required to register a new agent");
    }
    if (existing && !privileged) this.assertOwner(existing, leaseToken);

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
    return {
      agent: publicAgent(agent),
      created: existing === undefined,
      ...(generatedToken === undefined ? {} : { leaseToken: generatedToken }),
    };
  }

  async heartbeat(id: string, leaseToken?: string, privileged = false): Promise<RegisteredAgent> {
    const agent = await this.#required(id);
    if (!privileged) this.assertOwner(agent, leaseToken);
    const nowMs = this.#clock.now();
    const now = new Date(nowMs).toISOString();
    agent.lastSeen = now;
    agent.updatedAt = now;
    agent.expiresAt = new Date(nowMs + agent.ttlSeconds * 1000).toISOString();
    agent.revision = this.nextRevision();
    await this.#store.renew(agent);
    return publicAgent(agent);
  }

  async get(id: string): Promise<RegisteredAgent> {
    return publicAgent(await this.#required(id));
  }

  async list(query: AgentQuery): Promise<AgentPage> {
    const all = (await this.#store.list()).filter((agent) => matches(agent, query)).sort((a, b) => a.id.localeCompare(b.id));
    const startAfter = query.cursor ? decodeCursor(query.cursor) : undefined;
    const start = startAfter ? all.findIndex((agent) => agent.id > startAfter) : 0;
    const offset = start < 0 ? all.length : start;
    const selected = all.slice(offset, offset + query.limit);
    const hasMore = offset + selected.length < all.length;
    return {
      agents: selected.map(publicAgent),
      total: all.length,
      revision: Math.max(this.#revision, ...all.map((agent) => agent.revision)),
      ...(hasMore && selected.length > 0 ? { nextCursor: encodeCursor(selected[selected.length - 1]!.id) } : {}),
    };
  }

  async unregister(id: string, leaseToken?: string, privileged = false): Promise<void> {
    const agent = await this.#required(id);
    if (!privileged) this.assertOwner(agent, leaseToken);
    await this.#store.delete(agent);
    this.nextRevision();
  }

  async #required(id: string): Promise<StoredAgent> {
    const agent = await this.#store.get(id);
    if (!agent) throw new RegistryError(404, "agent_not_found", `Agent '${id}' was not found or its lease expired`);
    return agent;
  }

  private assertOwner(agent: StoredAgent, leaseToken?: string): void {
    if (!leaseToken || !tokenMatches(leaseToken, agent.leaseTokenHash)) {
      throw new RegistryError(401, "invalid_lease_token", "A valid X-Registry-Lease-Token is required for this agent");
    }
  }

  private nextRevision(): number {
    this.#revision += 1;
    return this.#revision;
  }
}
